import type FinancePlugin from "../main";
import type { FinanceStore } from "../store";

/**
 * Method + path matching for the local API, and the vocabulary every route module speaks.
 *
 * Deliberately knows nothing about sockets, auth or Node: a route is a function from a request context
 * to a value, so each endpoint can be tested by calling it, and the plumbing in server.ts/pipeline.ts
 * can change without touching a single route. Endpoint groups live in their own files under src/api/
 * and add themselves to the router through `register(router)` — see routes.ts.
 */

/** Every API path is served under this prefix; routes register paths relative to it ("/health"). */
export const API_BASE = "/mmf/v1";

/**
 * A failure a handler means to report, with the status to report it under. Anything else thrown is a
 * bug and becomes a 500 whose message is never shown to the client.
 */
export class HttpError extends Error {
	constructor(public status: number, message: string) {
		super(message);
		this.name = "HttpError";
	}
}

/**
 * A response with a status other than 200 — `reply(201, created)` for a POST that made something.
 * A handler that returns anything else returns it as a 200 body.
 */
export class Reply {
	constructor(public status: number, public body: unknown) {}
}

export function reply(status: number, body: unknown): Reply {
	return new Reply(status, body);
}

export interface RequestContext {
	method: string;
	/** The full request path, base included, without the query string. */
	path: string;
	/** Values for the route's `:name` segments, already URI-decoded. */
	params: Record<string, string>;
	query: URLSearchParams;
	/** The parsed JSON body. `undefined` when the request had none — GET and HEAD never do. */
	body: unknown;
	/** Correlates a 500 with the stack logged under "[mmf/api]". */
	requestId: string;
	plugin: FinancePlugin;
	/**
	 * The store as it is right now. A function rather than a value because switching portfolio reloads
	 * `plugin.store` in place, and a reference captured at the start of a slow request — or, worse,
	 * cached when the server started — would read or write the wrong portfolio's data.
	 */
	store(): FinanceStore;
	/** Repaints every open Finance view. Call it after every successful write. */
	refresh(): void;
}

export type RouteHandler = (ctx: RequestContext) => unknown | Promise<unknown>;

interface Route {
	method: string;
	pattern: string;
	segments: string[];
	handler: RouteHandler;
}

export type RouteMatch =
	| { kind: "found"; handler: RouteHandler; params: Record<string, string> }
	/** The path exists, but not for this method — a 405, not a 404. */
	| { kind: "method"; allowed: string[] }
	| { kind: "none" };

function split(path: string): string[] {
	return path.split("/").filter((s) => s !== "");
}

/** How well a route fits a path: a literal segment beats a `:param` at the first place they differ, so
 *  `/transactions/batches` wins over `/transactions/:id` whichever file registered first. */
function specificity(route: Route): string {
	return route.segments.map((s) => (s.startsWith(":") ? "0" : "1")).join("");
}

export class Router {
	private routes: Route[] = [];

	/**
	 * Registers a handler for METHOD + a path relative to API_BASE. `:name` segments capture. Two
	 * modules claiming the same method and shape is a programming error, so it throws at startup
	 * rather than letting whichever loaded last silently win.
	 */
	add(method: string, pattern: string, handler: RouteHandler): void {
		const upper = method.toUpperCase();
		const segments = split(pattern);
		const shape = segments.map((s) => (s.startsWith(":") ? ":" : s)).join("/");
		const clash = this.routes.find(
			(r) => r.method === upper && r.segments.map((s) => (s.startsWith(":") ? ":" : s)).join("/") === shape
		);
		if (clash) throw new Error(`[mmf/api] ${upper} ${pattern} is already registered as ${clash.pattern}`);
		this.routes.push({ method: upper, pattern, segments, handler });
	}

	get(pattern: string, handler: RouteHandler): void {
		this.add("GET", pattern, handler);
	}

	post(pattern: string, handler: RouteHandler): void {
		this.add("POST", pattern, handler);
	}

	patch(pattern: string, handler: RouteHandler): void {
		this.add("PATCH", pattern, handler);
	}

	put(pattern: string, handler: RouteHandler): void {
		this.add("PUT", pattern, handler);
	}

	delete(pattern: string, handler: RouteHandler): void {
		this.add("DELETE", pattern, handler);
	}

	/**
	 * Finds the handler for a full request path (base included). HEAD is answered by the GET route —
	 * the pipeline drops the body — so no module has to register it.
	 */
	match(method: string, fullPath: string): RouteMatch {
		const upper = method.toUpperCase();
		const wanted = upper === "HEAD" ? "GET" : upper;
		const base = split(API_BASE);
		const parts = split(fullPath);
		if (parts.length < base.length || base.some((b, i) => parts[i] !== b)) return { kind: "none" };
		const rest = parts.slice(base.length);

		const candidates: { route: Route; params: Record<string, string> }[] = [];
		for (const route of this.routes) {
			const params = matchSegments(route.segments, rest);
			if (params) candidates.push({ route, params });
		}
		if (candidates.length === 0) return { kind: "none" };

		const forMethod = candidates.filter((c) => c.route.method === wanted);
		if (forMethod.length === 0) {
			const allowed = Array.from(new Set(candidates.map((c) => c.route.method)));
			if (allowed.includes("GET")) allowed.push("HEAD");
			return { kind: "method", allowed: allowed.sort() };
		}
		forMethod.sort((a, b) => specificity(b.route).localeCompare(specificity(a.route)));
		return { kind: "found", handler: forMethod[0].route.handler, params: forMethod[0].params };
	}
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | null {
	if (pattern.length !== parts.length) return null;
	const params: Record<string, string> = {};
	for (let i = 0; i < pattern.length; i++) {
		const seg = pattern[i];
		if (seg.startsWith(":")) {
			let value: string;
			try {
				value = decodeURIComponent(parts[i]);
			} catch {
				// A malformed escape can't be the id of anything, so it simply doesn't match.
				return null;
			}
			params[seg.slice(1)] = value;
		} else if (seg !== parts[i]) {
			return null;
		}
	}
	return params;
}
