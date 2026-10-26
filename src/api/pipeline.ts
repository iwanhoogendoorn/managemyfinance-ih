import type FinancePlugin from "../main";
import { bearerToken, tokenMatches, type TokenCrypto } from "./auth";
import { appendAudit, diffLedger, snapshotLedger, type AuditEntry } from "./audit";
import { isClientAllowed, isLocalRequest, isReadMethod } from "./bind";
import { HttpError, Reply, type RequestContext, type Router } from "./router";
import { outOfScopeFields, SCOPED_PATCH_FIELDS, scopedRoute } from "./scopes";

/**
 * Everything between "a request arrived" and "this is the response", with no socket in sight.
 *
 * server.ts turns a Node request into an ApiRequest and writes the ApiResponse back; this decides what
 * the response is. Keeping the two apart is what lets every rule below — who may connect, the token,
 * the remote-write switch, the error format, the headers — be tested by calling a function.
 *
 * The order is deliberate: who is asking, then whether they hold the token, then whether they may
 * write (for another device: all writes, the remote write scopes, or none — and every such write is
 * audited, see audit.ts), and only then which route and what body. An unauthenticated caller learns nothing about which
 * paths exist, and no body is read for anyone who was going to be refused anyway.
 */

/** Largest request body accepted, in bytes. Anything bigger is a 413 — see server.ts readBody. */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface ApiRequest {
	method: string;
	/** The raw request target, query string included. */
	url: string;
	/** Lower-cased header names, as Node gives them. */
	headers: Record<string, string | string[] | undefined>;
	remoteAddress: string | undefined;
	/** Reads the whole body as text. Rejects with HttpError(413) past MAX_BODY_BYTES. Called at most
	 *  once, and only for a request that got as far as its handler and can carry a body. */
	readBody(): Promise<string>;
}

export interface ApiResponse {
	status: number;
	headers: Record<string, string>;
	/** Serialized JSON, or "" for no body. server.ts drops it for HEAD but keeps the length. */
	body: string;
}

export interface PipelineDeps {
	router: Router;
	plugin: FinancePlugin;
	crypto: TokenCrypto;
	/** Where a 500's stack goes. console.error by default; tests capture it to check the token isn't in it. */
	log?: (...args: unknown[]) => void;
	newRequestId?: () => string;
}

function defaultRequestId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Headers on every response, authenticated or not: nothing here is ever worth caching, and a JSON
 *  body must never be sniffed into something a browser would render. */
const BASE_HEADERS: Record<string, string> = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
};

function json(status: number, body: unknown, extra?: Record<string, string>): ApiResponse {
	const headers: Record<string, string> = { ...BASE_HEADERS, ...extra };
	if (body === undefined) return { status, headers, body: "" };
	headers["Content-Type"] = "application/json; charset=utf-8";
	return { status, headers, body: JSON.stringify(body) };
}

function error(status: number, message: string, extra?: Record<string, string>): ApiResponse {
	return json(status, { error: message }, extra);
}

export async function handleApiRequest(deps: PipelineDeps, req: ApiRequest): Promise<ApiResponse> {
	const { plugin } = deps;
	const settings = plugin.settings;
	const method = req.method.toUpperCase();

	if (!isClientAllowed(req.remoteAddress, settings.apiBind)) return error(403, "Client not allowed");

	if (!tokenMatches(deps.crypto, bearerToken(req.headers.authorization), settings.apiToken)) {
		return error(401, "Missing or invalid bearer token", { "WWW-Authenticate": 'Bearer realm="mmf"' });
	}

	// From here on the caller holds the token, so every response — errors included — carries the
	// revision. Read last, after the handler, so a write's own response already shows its effect.
	const response = await authenticated(deps, req, method);
	response.headers["x-mmf-revision"] = String(plugin.store?.revision ?? 0);
	return response;
}

/**
 * How a write from another device is let through: "full" when "Allow writes from other devices" is on,
 * "scoped" when only the remote write scopes are and this request is one of them, "refused" otherwise.
 * Only ever asked about remote writes — a local request never reaches it.
 */
function remoteAccess(settings: PipelineDeps["plugin"]["settings"], method: string, path: string): "full" | "scoped" | "refused" {
	if (settings.apiAllowRemoteWrites) return "full";
	if (settings.apiRemoteWriteScopes && scopedRoute(method, path)) return "scoped";
	return "refused";
}

async function authenticated(deps: PipelineDeps, req: ApiRequest, method: string): Promise<ApiResponse> {
	const write = !isReadMethod(method);
	// Same-device requests and reads go straight through, exactly as before the scopes existed. Only a
	// write from another device takes the audited path.
	if (!write || isLocalRequest(req.remoteAddress, req.headers)) return route(deps, req, method);
	return remoteWrite(deps, req, method);
}

async function remoteWrite(deps: PipelineDeps, req: ApiRequest, method: string): Promise<ApiResponse> {
	const { plugin } = deps;
	const settings = plugin.settings;
	let path = req.url.split("?")[0];
	try {
		path = new URL(req.url, "http://localhost").pathname;
	} catch {
		// Left as the raw path: refused below either way, and the log still says what was asked.
	}
	const access = remoteAccess(settings, method, path);
	const entry: AuditEntry = { time: new Date().toISOString(), method, path, client: req.remoteAddress ?? "unknown", access, status: 0 };

	let response: ApiResponse;
	if (access === "refused") {
		response = settings.apiRemoteWriteScopes
			? error(403, `${method} ${path} is outside the remote write scopes — from another device only POST /import, PATCH /transactions/:id (categoryId, review) and POST /imports/:batchId/undo are allowed`)
			: error(403, "Writes from other devices are turned off (Settings → Local API → Allow writes from other devices)");
	} else {
		const before = plugin.store ? snapshotLedger(plugin.store.transactions) : undefined;
		response = await route(deps, req, method, access === "scoped" ? scopedFieldCheck(method, path) : undefined, entry);
		if (before && plugin.store) entry.diff = diffLedger(before, snapshotLedger(plugin.store.transactions));
	}

	entry.status = response.status;
	try {
		const body = response.body ? (JSON.parse(response.body) as Record<string, unknown>) : undefined;
		if (response.status >= 400 && typeof body?.error === "string") entry.error = body.error;
		if (typeof body?.batchId === "string") entry.ids = { ...entry.ids, batchId: body.batchId };
		if (body?.dryRun === true) entry.dryRun = true;
	} catch {
		// Not JSON — nothing more to pick out of it.
	}
	try {
		await appendAudit(plugin.app, settings.dataFolder, entry);
	} catch (err) {
		// The write itself already happened; failing the response now would make the client retry an
		// import that went through. Logged loudly instead.
		(deps.log ?? console.error)("[mmf/api] couldn't write the audit log:", err instanceof Error ? err.message : err);
	}
	return response;
}

/** For a scoped PATCH: refuses any body field outside the scope before the route sees it. */
function scopedFieldCheck(method: string, path: string): ((body: unknown) => ApiResponse | undefined) | undefined {
	if (scopedRoute(method, path) !== "patch-transaction") return undefined;
	return (body) => {
		const extra = outOfScopeFields(body);
		if (extra.length === 0) return undefined;
		return error(403, `Cannot change ${extra.join(", ")} from another device — the remote write scopes allow only ${SCOPED_PATCH_FIELDS.join(" and ")}`);
	};
}

async function route(
	deps: PipelineDeps,
	req: ApiRequest,
	method: string,
	checkBody?: (body: unknown) => ApiResponse | undefined,
	audit?: AuditEntry
): Promise<ApiResponse> {
	const { plugin, router } = deps;
	const write = !isReadMethod(method);

	let url: URL;
	try {
		url = new URL(req.url, "http://localhost");
	} catch {
		return error(400, "Malformed request URL");
	}
	const path = url.pathname;

	const match = router.match(method, path);
	if (match.kind === "none") return error(404, "Not found");
	if (match.kind === "method") return error(405, `Cannot ${method} ${path}`, { Allow: match.allowed.join(", ") });

	const requestId = (deps.newRequestId ?? defaultRequestId)();
	if (audit) {
		audit.requestId = requestId;
		if (Object.keys(match.params).length > 0) audit.ids = { ...match.params };
	}
	// Opened before the body is read and closed after the response is decided, so `written` covers
	// everything this request could have caused. Taken from the store once: switching portfolio reloads
	// that same instance in place, so it can't go stale mid-request.
	const tracker = plugin.store.trackWrites();
	let repaintedAt: number | undefined;
	// Repaints only once something was written, and again only if more was written since — so a dry
	// run that calls refresh() costs nothing, and the revision is left to the store alone: it moves when
	// a file is really written, never because a request merely asked to write.
	const refresh = (): void => {
		if (tracker.written().length === 0 || plugin.store.revision === repaintedAt) return;
		repaintedAt = plugin.store.revision;
		plugin.refreshViews();
	};
	try {
		let body: unknown = undefined;
		if (write) {
			const raw = await req.readBody();
			if (raw.trim() !== "") {
				try {
					body = JSON.parse(raw);
				} catch {
					throw new HttpError(400, "Request body is not valid JSON");
				}
			}
		}

		const refused = checkBody?.(body);
		if (refused) return refused;

		const ctx: RequestContext = {
			method,
			path,
			params: match.params,
			query: url.searchParams,
			body,
			requestId,
			plugin,
			store: () => plugin.store,
			refresh,
			written: () => tracker.written(),
		};

		const result = await match.handler(ctx);
		const status = result instanceof Reply ? result.status : result === undefined ? 204 : 200;
		return json(status, result instanceof Reply ? result.body : result);
	} catch (err) {
		if (err instanceof HttpError) return error(err.status, err.message);
		// Method and path only — never headers, which carry the token, and never the body.
		(deps.log ?? console.error)(`[mmf/api] ${requestId} ${method} ${path} failed:`, err instanceof Error ? err.stack ?? err.message : err);
		return json(500, { error: "Internal error", requestId });
	} finally {
		// Whatever the handler wrote is on disk now, success or failure, so the views catch up even if it
		// forgot to ask — or threw half-way through. A ledger changed behind a view still showing the old
		// one is the bug this rules out.
		refresh();
		tracker.stop();
	}
}
