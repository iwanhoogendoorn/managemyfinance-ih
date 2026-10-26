import type FinancePlugin from "../main";
import { bearerToken, tokenMatches, type TokenCrypto } from "./auth";
import { isClientAllowed, isLocalRequest, isReadMethod } from "./bind";
import { HttpError, Reply, type RequestContext, type Router } from "./router";

/**
 * Everything between "a request arrived" and "this is the response", with no socket in sight.
 *
 * server.ts turns a Node request into an ApiRequest and writes the ApiResponse back; this decides what
 * the response is. Keeping the two apart is what lets every rule below — who may connect, the token,
 * the remote-write switch, the error format, the headers — be tested by calling a function.
 *
 * The order is deliberate: who is asking, then whether they hold the token, then whether they may
 * write, and only then which route and what body. An unauthenticated caller learns nothing about which
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

async function authenticated(deps: PipelineDeps, req: ApiRequest, method: string): Promise<ApiResponse> {
	const { plugin, router } = deps;
	const settings = plugin.settings;
	const write = !isReadMethod(method);

	if (write && !settings.apiAllowRemoteWrites && !isLocalRequest(req.remoteAddress, req.headers)) {
		return error(403, "Writes from other devices are turned off (Settings → Local API → Allow writes from other devices)");
	}

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

		let refreshed = false;
		const ctx: RequestContext = {
			method,
			path,
			params: match.params,
			query: url.searchParams,
			body,
			requestId,
			plugin,
			store: () => plugin.store,
			refresh: () => {
				if (refreshed) return;
				refreshed = true;
				// Counted as a change even when the write never reached a store file (a settings field,
				// say), so a client polling the revision is never told "unchanged" after a write.
				plugin.store.revision++;
				plugin.refreshViews();
			},
		};

		const result = await match.handler(ctx);
		const status = result instanceof Reply ? result.status : result === undefined ? 204 : 200;
		// A successful write repaints the open views even if its handler forgot to ask: a ledger that
		// changed behind a view still showing the old one is the bug this rules out.
		if (write && status < 300) ctx.refresh();
		return json(status, result instanceof Reply ? result.body : result);
	} catch (err) {
		if (err instanceof HttpError) return error(err.status, err.message);
		// Method and path only — never headers, which carry the token, and never the body.
		(deps.log ?? console.error)(`[mmf/api] ${requestId} ${method} ${path} failed:`, err instanceof Error ? err.stack ?? err.message : err);
		return json(500, { error: "Internal error", requestId });
	}
}
