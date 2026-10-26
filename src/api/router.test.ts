import { describe, expect, it } from "vitest";
import { Router, type RouteHandler } from "./router";

/**
 * Route matching on its own, with no pipeline: the part every endpoint module depends on and that a
 * subtle mistake would break for all of them at once.
 */

const noop: RouteHandler = () => null;

describe("Router.match", () => {
	it("matches a literal path under the base and nothing outside it", () => {
		const router = new Router();
		router.get("/health", noop);
		expect(router.match("GET", "/mmf/v1/health").kind).toBe("found");
		expect(router.match("GET", "/mmf/v1/health/").kind).toBe("found");
		expect(router.match("GET", "/health").kind).toBe("none");
		expect(router.match("GET", "/mmf/v2/health").kind).toBe("none");
		expect(router.match("GET", "/mmf/v1/nope").kind).toBe("none");
	});

	it("captures and decodes :params", () => {
		const router = new Router();
		router.get("/accounts/:id/transactions/:txId", noop);
		const m = router.match("GET", "/mmf/v1/accounts/acc%201/transactions/tx-9");
		expect(m).toMatchObject({ kind: "found", params: { id: "acc 1", txId: "tx-9" } });
	});

	it("doesn't match a malformed escape instead of throwing", () => {
		const router = new Router();
		router.get("/accounts/:id", noop);
		expect(router.match("GET", "/mmf/v1/accounts/%E0%A4%A").kind).toBe("none");
	});

	it("reports 405 territory, with the allowed methods, when only the method is wrong", () => {
		const router = new Router();
		router.get("/accounts", noop);
		router.post("/accounts", noop);
		expect(router.match("DELETE", "/mmf/v1/accounts")).toEqual({ kind: "method", allowed: ["GET", "HEAD", "POST"] });
	});

	it("answers HEAD with the GET route", () => {
		const router = new Router();
		const get: RouteHandler = () => "get";
		router.get("/health", get);
		expect(router.match("HEAD", "/mmf/v1/health")).toMatchObject({ kind: "found", handler: get });
	});

	it("prefers a literal segment over a :param regardless of registration order", () => {
		const router = new Router();
		const byId: RouteHandler = () => "id";
		const batches: RouteHandler = () => "batches";
		router.get("/transactions/:id", byId);
		router.get("/transactions/batches", batches);
		expect(router.match("GET", "/mmf/v1/transactions/batches")).toMatchObject({ handler: batches });
		expect(router.match("GET", "/mmf/v1/transactions/tx-1")).toMatchObject({ handler: byId, params: { id: "tx-1" } });
	});

	it("refuses two registrations of the same method and shape", () => {
		const router = new Router();
		router.get("/accounts/:id", noop);
		expect(() => router.get("/accounts/:accountId", noop)).toThrow(/already registered/);
		// A different method on the same path is fine.
		expect(() => router.patch("/accounts/:id", noop)).not.toThrow();
	});
});
