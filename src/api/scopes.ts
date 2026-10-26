import { API_BASE } from "./router";

/**
 * Remote write scopes: a narrow set of writes a client on another device may make while the broad
 * "Allow writes from other devices" switch stays off.
 *
 * The case it exists for is a bot that imports a bank export and files what came in. That needs three
 * things — import a file, set a row's category or review status, take an import back — and nothing
 * else: not accounts, not rules, not a row's amount or date. Turning on every remote write to get
 * those three would hand the same token the power to delete an account, so the scopes are their own
 * setting with their own, much smaller, reach.
 *
 * Pure functions over a method and a path, so the policy is tested without a server. The pipeline
 * asks `scopedRoute` before any route runs, and `outOfScopeFields` once the body is parsed.
 */

export type ScopedRoute = "import" | "patch-transaction" | "undo-import";

/** The writes a scoped remote client may make, as METHOD + path relative to API_BASE. */
const SCOPED: { route: ScopedRoute; method: string; pattern: RegExp }[] = [
	{ route: "import", method: "POST", pattern: /^\/import$/ },
	{ route: "patch-transaction", method: "PATCH", pattern: /^\/transactions\/[^/]+$/ },
	// Both spellings: /imports/:batchId/undo is the history's own, /import/:batchId/undo an alias.
	{ route: "undo-import", method: "POST", pattern: /^\/imports?\/[^/]+\/undo$/ },
];

/** The only fields a scoped client may send in PATCH /transactions/:id. */
export const SCOPED_PATCH_FIELDS: readonly string[] = ["categoryId", "review"];

/** Which scoped write a request is, or undefined when it's outside the scopes. Trailing slashes and
 *  anything not under the API base are outside. */
export function scopedRoute(method: string, fullPath: string): ScopedRoute | undefined {
	if (!fullPath.startsWith(`${API_BASE}/`)) return undefined;
	const rest = fullPath.slice(API_BASE.length);
	const upper = method.toUpperCase();
	return SCOPED.find((s) => s.method === upper && s.pattern.test(rest))?.route;
}

/** Fields in a scoped PATCH body that the scope doesn't allow — empty when the body is in scope (or
 *  isn't an object at all, which the route itself then refuses as a 400). */
export function outOfScopeFields(body: unknown): string[] {
	if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
	return Object.keys(body).filter((k) => !SCOPED_PATCH_FIELDS.includes(k));
}
