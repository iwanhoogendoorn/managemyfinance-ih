import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Router, type RouteHandler } from "./router";
import * as routeModules from "./routes";

/**
 * docs/api.md is the API's contract with every client that isn't this repo, so it is checked against the
 * route table rather than trusted: a route added without a heading in the docs, or a heading left behind
 * for a route that was removed or renamed, fails the build here instead of surprising a client later.
 *
 * Each route is documented under a heading of exactly the form #### `METHOD /path` (the path relative
 * to /mmf/v1, `:name` segments as registered), which is what this reads.
 */

/** A Router that remembers what was registered on it, through the same register() every module exports. */
class RecordingRouter extends Router {
	registered: string[] = [];

	override add(method: string, pattern: string, handler: RouteHandler): void {
		this.registered.push(`${method.toUpperCase()} ${pattern}`);
		super.add(method, pattern, handler);
	}
}

function registeredRoutes(): string[] {
	const router = new RecordingRouter();
	for (const register of Object.values(routeModules)) register(router);
	return router.registered;
}

function documentedRoutes(): string[] {
	const docs = readFileSync(fileURLToPath(new URL("../../docs/api.md", import.meta.url)), "utf8");
	return Array.from(docs.matchAll(/^#{3,4} `(GET|POST|PUT|PATCH|DELETE) (\/[^`\s]*)`\s*$/gm), (m) => `${m[1]} ${m[2]}`);
}

describe("docs/api.md", () => {
	it("documents every registered route, and nothing that isn't one", () => {
		const registered = registeredRoutes();
		const documented = documentedRoutes();
		expect(registered.length).toBeGreaterThan(0);
		expect([...documented].sort()).toEqual([...registered].sort());
	});

	it("documents each route once", () => {
		const documented = documentedRoutes();
		expect(documented.filter((r, i) => documented.indexOf(r) !== i)).toEqual([]);
	});
});
