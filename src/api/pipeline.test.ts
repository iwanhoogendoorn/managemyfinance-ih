import * as crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { handleApiRequest } from "./pipeline";
import { HttpError, reply, Router } from "./router";
import { makeTestPlugin, send, TEST_TOKEN, type TestPlugin } from "./testPlugin";

/**
 * The request pipeline end to end, minus the socket: who may connect, the token, the remote-write
 * switch, the error format and the headers every response carries. These are the rules every
 * endpoint inherits, so they are pinned here once rather than re-tested per endpoint.
 */

function testRouter(): Router {
	const router = new Router();
	router.get("/things", () => ({ things: [] }));
	// Writes nothing — the shape of a dry run, or a write whose input matched what was already there.
	router.post("/things", (ctx) => {
		ctx.refresh();
		return reply(201, { got: ctx.body, written: ctx.written() });
	});
	router.post("/accounts", async (ctx) => {
		const store = ctx.store();
		store.accounts.push({ id: "acc-new", name: "New", type: "debit", currency: "EUR" } as never);
		await store.saveAccounts();
		return { written: ctx.written() };
	});
	router.post("/two-files", async (ctx) => {
		const store = ctx.store();
		await store.saveAccounts();
		ctx.refresh();
		await store.saveRules();
		await store.saveAccounts();
		return { written: ctx.written() };
	});
	router.post("/half", async (ctx) => {
		await ctx.store().saveRules();
		throw new Error("failed after writing");
	});
	router.get("/explode", () => {
		throw new Error(`kaboom with ${TEST_TOKEN}`);
	});
	router.get("/missing/:id", (ctx) => {
		throw new HttpError(404, `No thing ${ctx.params.id}`);
	});
	router.delete("/things/:id", () => undefined);
	return router;
}

let t: TestPlugin;
let router: Router;
beforeEach(() => {
	t = makeTestPlugin();
	router = testRouter();
});

describe("authentication", () => {
	it("refuses a request with no token", async () => {
		const res = await send(t, crypto, { path: "/things", token: null }, router);
		expect(res.status).toBe(401);
		expect(res.json).toEqual({ error: "Missing or invalid bearer token" });
		expect(res.headers["WWW-Authenticate"]).toMatch(/^Bearer/);
	});

	it("refuses a wrong token", async () => {
		const res = await send(t, crypto, { path: "/things", token: "nope" }, router);
		expect(res.status).toBe(401);
	});

	it("accepts the right token", async () => {
		const res = await send(t, crypto, { path: "/things" }, router);
		expect(res.status).toBe(200);
		expect(res.json).toEqual({ things: [] });
	});

	it("refuses everything while no token is configured", async () => {
		t.settings.apiToken = undefined;
		expect((await send(t, crypto, { path: "/things", token: "" }, router)).status).toBe(401);
	});

	it("checks the token before revealing whether a route exists", async () => {
		expect((await send(t, crypto, { path: "/does-not-exist", token: null }, router)).status).toBe(401);
	});

	it("doesn't put the revision on an unauthenticated response", async () => {
		const res = await send(t, crypto, { path: "/things", token: null }, router);
		expect(res.headers["x-mmf-revision"]).toBeUndefined();
	});
});

describe("who may connect, and who may write", () => {
	it("refuses a LAN client outright", async () => {
		const res = await send(t, crypto, { path: "/things", remoteAddress: "192.168.1.30" }, router);
		expect(res.status).toBe(403);
		expect(res.json).toEqual({ error: "Client not allowed" });
	});

	it("blocks a write from another device while remote writes are off, before the handler runs", async () => {
		t.settings.apiBind = "tailscale";
		const res = await send(t, crypto, { method: "POST", path: "/accounts", body: {}, remoteAddress: "100.64.0.9" }, router);
		expect(res.status).toBe(403);
		expect((res.json as { error: string }).error).toMatch(/Allow writes from other devices/);
		expect(t.store.accounts).toHaveLength(0);
	});

	it("still lets another device read while remote writes are off", async () => {
		t.settings.apiBind = "tailscale";
		expect((await send(t, crypto, { path: "/things", remoteAddress: "100.64.0.9" }, router)).status).toBe(200);
	});

	it("allows the write once remote writes are on", async () => {
		t.settings.apiBind = "tailscale";
		t.settings.apiAllowRemoteWrites = true;
		const res = await send(t, crypto, { method: "POST", path: "/accounts", body: {}, remoteAddress: "100.64.0.9" }, router);
		expect(res.status).toBe(200);
		expect(t.store.accounts).toHaveLength(1);
	});

	it("treats a write relayed through tailscale serve on loopback as remote", async () => {
		const res = await send(t, crypto, { method: "POST", path: "/things", body: {}, headers: { "x-forwarded-for": "100.64.0.9" } }, router);
		expect(res.status).toBe(403);
	});

	it("always allows writes from this machine", async () => {
		expect((await send(t, crypto, { method: "POST", path: "/things", body: { a: 1 } }, router)).status).toBe(201);
	});
});

describe("error format", () => {
	it("400 for a body that isn't JSON", async () => {
		const res = await send(t, crypto, { method: "POST", path: "/things", body: "{not json" }, router);
		expect(res.status).toBe(400);
		expect(res.json).toEqual({ error: "Request body is not valid JSON" });
	});

	it("404 for an unknown route, and for a handler's own not-found", async () => {
		const unknown = await send(t, crypto, { path: "/nowhere" }, router);
		expect(unknown.status).toBe(404);
		expect(unknown.json).toEqual({ error: "Not found" });
		const entity = await send(t, crypto, { path: "/missing/x1" }, router);
		expect(entity.status).toBe(404);
		expect(entity.json).toEqual({ error: "No thing x1" });
	});

	it("405 'Cannot <METHOD> <path>' with an Allow header", async () => {
		const res = await send(t, crypto, { method: "PATCH", path: "/things" }, router);
		expect(res.status).toBe(405);
		expect(res.json).toEqual({ error: "Cannot PATCH /mmf/v1/things" });
		expect(res.headers.Allow).toBe("GET, HEAD, POST");
	});

	it("413 when the body reader refuses an oversized body", async () => {
		const res = await handleApiRequest(
			{ router, plugin: t.plugin, crypto },
			{
				method: "POST",
				url: "/mmf/v1/things",
				headers: { authorization: `Bearer ${TEST_TOKEN}` },
				remoteAddress: "127.0.0.1",
				readBody: async () => {
					throw new HttpError(413, "Request body is larger than 1 MB");
				},
			}
		);
		expect(res.status).toBe(413);
		expect(JSON.parse(res.body)).toEqual({ error: "Request body is larger than 1 MB" });
	});

	it("500 hides the message, returns a requestId, and logs the stack without the token header", async () => {
		const logged: unknown[][] = [];
		const res = await send(t, crypto, { path: "/explode" }, router, (...args) => logged.push(args));
		expect(res.status).toBe(500);
		const body = res.json as { error: string; requestId: string };
		expect(body.error).toBe("Internal error");
		expect(body.requestId).toEqual(expect.any(String));
		expect(Object.keys(body)).toEqual(["error", "requestId"]);
		expect(logged).toHaveLength(1);
		const line = logged[0].map(String).join(" ");
		expect(line).toContain("[mmf/api]");
		expect(line).toContain(body.requestId);
		expect(line).toContain("GET /mmf/v1/explode");
		expect(line).not.toContain("Bearer");
	});
});

describe("headers and revision", () => {
	it("sends no-store and nosniff on every response, refused or not", async () => {
		for (const req of [{ path: "/things" }, { path: "/things", token: null }, { path: "/nowhere" }, { path: "/explode" }]) {
			const res = await send(t, crypto, req, router, () => undefined);
			expect(res.headers["Cache-Control"]).toBe("no-store");
			expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
		}
	});

	it("puts x-mmf-revision on every authenticated response, errors included", async () => {
		for (const req of [{ path: "/things" }, { path: "/nowhere" }, { method: "PATCH", path: "/things" }]) {
			const res = await send(t, crypto, req, router);
			expect(res.headers["x-mmf-revision"]).toMatch(/^\d+$/);
		}
	});

	it("increases the revision after a write, and the write's own response already shows it", async () => {
		const before = Number((await send(t, crypto, { path: "/things" }, router)).headers["x-mmf-revision"]);
		const write = await send(t, crypto, { method: "POST", path: "/accounts", body: {} }, router);
		const after = Number(write.headers["x-mmf-revision"]);
		expect(after).toBeGreaterThan(before);
		expect(Number((await send(t, crypto, { path: "/things" }, router)).headers["x-mmf-revision"])).toBe(after);
	});

	it("counts a write made outside the API too", async () => {
		const before = Number((await send(t, crypto, { path: "/things" }, router)).headers["x-mmf-revision"]);
		await t.store.saveRules();
		expect(Number((await send(t, crypto, { path: "/things" }, router)).headers["x-mmf-revision"])).toBeGreaterThan(before);
	});

	it("refreshes the views after a write that wrote something, not after a read, a failed parse or a no-op", async () => {
		await send(t, crypto, { path: "/things" }, router);
		expect(t.refreshes()).toBe(0);
		await send(t, crypto, { method: "POST", path: "/accounts", body: "{bad" }, router);
		expect(t.refreshes()).toBe(0);
		await send(t, crypto, { method: "POST", path: "/things", body: {} }, router);
		expect(t.refreshes()).toBe(0);
		await send(t, crypto, { method: "POST", path: "/accounts", body: {} }, router);
		expect(t.refreshes()).toBe(1);
	});

	it("repaints again at the end only if the handler wrote more after its own refresh()", async () => {
		await send(t, crypto, { method: "POST", path: "/two-files", body: {} }, router);
		expect(t.refreshes()).toBe(2);
	});

	it("still repaints when a handler throws after writing", async () => {
		const res = await send(t, crypto, { method: "POST", path: "/half", body: {} }, router, () => undefined);
		expect(res.status).toBe(500);
		expect(t.refreshes()).toBe(1);
	});

	it("answers a handler that returns nothing with an empty 204", async () => {
		const res = await send(t, crypto, { method: "DELETE", path: "/things/1" }, router);
		expect(res.status).toBe(204);
		expect(res.body).toBe("");
	});
});

describe("ctx.written()", () => {
	it("lists exactly the files the handler wrote, once each, in first-write order", async () => {
		const res = await send(t, crypto, { method: "POST", path: "/two-files", body: {} }, router);
		expect((res.json as { written: string[] }).written).toEqual(["TestFinance/data/accounts.json", "TestFinance/data/rules.json"]);
	});

	it("leaves out writes made before the request started", async () => {
		await t.store.saveRules();
		await t.store.saveCategories();
		const res = await send(t, crypto, { method: "POST", path: "/accounts", body: {} }, router);
		expect((res.json as { written: string[] }).written).toEqual(["TestFinance/data/accounts.json"]);
	});

	it("is empty for a no-op POST, which leaves the revision where it was", async () => {
		await t.store.saveRules();
		const before = (await send(t, crypto, { path: "/things" }, router)).headers["x-mmf-revision"];
		const res = await send(t, crypto, { method: "POST", path: "/things", body: { dryRun: true } }, router);
		expect(res.status).toBe(201);
		expect((res.json as { written: string[] }).written).toEqual([]);
		expect(res.headers["x-mmf-revision"]).toBe(before);
		expect(String(t.store.revision)).toBe(before);
	});

	it("stops recording once the request is over", async () => {
		await send(t, crypto, { method: "POST", path: "/accounts", body: {} }, router);
		expect((t.store as unknown as { writeLog: unknown[] }).writeLog).toEqual([]);
	});
});
