import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { merchantKey } from "../import/merchantKey";
import type { MerchantEntry } from "../import/merchantMemory";
import { makeTestPlugin, send, type TestPlugin, type TestRequest } from "./testPlugin";

/** One merchant filed by a rule and reviewed, one with only a parked AI suggestion. */
async function fixture(): Promise<TestPlugin> {
	const t = makeTestPlugin();
	await t.store.load();
	t.store.categories = [
		{ id: "cat-food", name: "Food", color: "#f00", icon: "tag", aliases: [] },
		{ id: "cat-fuel", name: "Fuel", color: "#00f", icon: "tag", aliases: [] },
	];
	t.store.merchants = {
		"test grocer": { key: "test grocer", categoryId: "cat-food", source: "rule", at: "2024-01-01", reviewedAt: "2024-01-02" },
		"test garage": {
			key: "test garage",
			source: "ai",
			at: "2024-01-01",
			suggestion: { categoryId: "cat-fuel", confidence: 0.4, model: "test-model", at: "2024-01-01" },
		},
	};
	await t.store.saveMerchants();
	return t;
}

const MERCHANTS_FILE = "TestFinance/data/merchants.json";

function call(t: TestPlugin, req: TestRequest) {
	return send(t, crypto, req);
}

function merchant(res: { json: unknown }): MerchantEntry {
	return (res.json as { merchant: MerchantEntry }).merchant;
}

describe("GET /merchants", () => {
	it("lists entries by key", async () => {
		const t = await fixture();
		const res = await call(t, { path: "/merchants" });
		expect(res.status).toBe(200);
		expect((res.json as { merchants: MerchantEntry[] }).merchants.map((m) => m.key)).toEqual(["test garage", "test grocer"]);
	});

	it("gets one by its URL-encoded key, and 404s an unknown one", async () => {
		const t = await fixture();
		expect((await call(t, { path: "/merchants/test%20grocer" })).json).toMatchObject({ key: "test grocer", categoryId: "cat-food" });
		expect((await call(t, { path: "/merchants/nobody" })).status).toBe(404);
		// An inherited property name is not a merchant.
		expect((await call(t, { path: "/merchants/constructor" })).status).toBe(404);
	});
});

describe("POST /merchants", () => {
	it("remembers a new merchant as your own decision, 201", async () => {
		const t = await fixture();
		const res = await call(t, { method: "POST", path: "/merchants", body: { key: "corner bakery", categoryId: "cat-food" } });
		expect(res.status).toBe(201);
		expect((res.json as { written: string[] }).written).toEqual([MERCHANTS_FILE]);
		expect(merchant(res)).toMatchObject({ key: "corner bakery", categoryId: "cat-food", source: "user" });
		await t.store.load();
		expect(t.store.merchants["corner bakery"]?.categoryId).toBe("cat-food");
	});

	it("derives the key from a bank description the way an import would", async () => {
		const t = await fixture();
		const description = "CORNER BAKERY 0123 UTRECHT";
		const res = await call(t, { method: "POST", path: "/merchants", body: { description, categoryId: "cat-food" } });
		expect(res.status).toBe(201);
		expect(merchant(res).key).toBe(merchantKey({ description }));
	});

	it("answers 200 when the merchant was already known, and overrides a rule's decision", async () => {
		const t = await fixture();
		const res = await call(t, { method: "POST", path: "/merchants", body: { key: "test grocer", categoryId: "cat-fuel" } });
		expect(res.status).toBe(200);
		expect(merchant(res)).toMatchObject({ categoryId: "cat-fuel", source: "user", reviewedAt: "2024-01-02" });
	});

	it.each([
		[{ key: "x" }, "categoryId is required"],
		[{ categoryId: "cat-food" }, "key or description is required"],
		[{ key: "x", description: "X", categoryId: "cat-food" }, "not both"],
		[{ key: "x", categoryId: "cat-nope" }, 'no category "cat-nope"'],
		[{ key: "x", categoryId: "cat-food", source: "ai" }, 'Unknown field "source"'],
	])("refuses %j with a 400", async (body, message) => {
		const t = await fixture();
		const res = await call(t, { method: "POST", path: "/merchants", body });
		expect(res.status).toBe(400);
		expect((res.json as { error: string }).error).toContain(message);
		expect(Object.keys(t.store.merchants)).toHaveLength(2);
	});
});

describe("PATCH /merchants/:key", () => {
	it("re-files a merchant as your own decision", async () => {
		const t = await fixture();
		const res = await call(t, { method: "PATCH", path: "/merchants/test%20garage", body: { categoryId: "cat-fuel" } });
		expect(res.status).toBe(200);
		expect(merchant(res)).toMatchObject({ categoryId: "cat-fuel", source: "user" });
		expect(merchant(res).suggestion).toBeUndefined();
	});

	it("null takes the category away and keeps the entry", async () => {
		const t = await fixture();
		const res = await call(t, { method: "PATCH", path: "/merchants/test%20grocer", body: { categoryId: null } });
		expect(res.status).toBe(200);
		expect(merchant(res)).not.toHaveProperty("categoryId");
		expect(merchant(res)).toMatchObject({ key: "test grocer", source: "user", reviewedAt: "2024-01-02" });
	});

	it("marks and unmarks a merchant as reviewed", async () => {
		const t = await fixture();
		let res = await call(t, { method: "PATCH", path: "/merchants/test%20grocer", body: { reviewed: false } });
		expect(merchant(res)).not.toHaveProperty("reviewedAt");
		expect(merchant(res).categoryId).toBe("cat-food");
		res = await call(t, { method: "PATCH", path: "/merchants/test%20grocer", body: { reviewed: true } });
		expect(merchant(res)).toMatchObject({ categoryId: "cat-food", source: "user" });
		expect(merchant(res).reviewedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});

	it("404s an unknown key and 400s bad bodies", async () => {
		const t = await fixture();
		expect((await call(t, { method: "PATCH", path: "/merchants/nobody", body: { reviewed: true } })).status).toBe(404);
		for (const body of [{}, { categoryId: "cat-nope" }, { reviewed: "yes" }, { key: "renamed" }]) {
			expect((await call(t, { method: "PATCH", path: "/merchants/test%20grocer", body })).status).toBe(400);
		}
		expect(t.store.merchants["test grocer"].categoryId).toBe("cat-food");
	});
});

describe("POST /merchants/:key/dismiss", () => {
	it("drops a parked suggestion and remembers the dismissal", async () => {
		const t = await fixture();
		const res = await call(t, { method: "POST", path: "/merchants/test%20garage/dismiss" });
		expect(res.status).toBe(200);
		expect(merchant(res).suggestion).toBeUndefined();
		expect(merchant(res).dismissedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(merchant(res).categoryId).toBeUndefined();
		await t.store.load();
		expect(t.store.merchants["test garage"].dismissedAt).toBeDefined();
	});

	it("refuses a body", async () => {
		const t = await fixture();
		expect((await call(t, { method: "POST", path: "/merchants/test%20garage/dismiss", body: { categoryId: "cat-fuel" } })).status).toBe(400);
	});
});

describe("DELETE /merchants/:key", () => {
	it("forgets the merchant, and 404s an unknown one", async () => {
		const t = await fixture();
		const res = await call(t, { method: "DELETE", path: "/merchants/test%20grocer" });
		expect(res.status).toBe(200);
		expect(res.json).toEqual({ deleted: "test grocer", written: [MERCHANTS_FILE] });
		await t.store.load();
		expect(Object.keys(t.store.merchants)).toEqual(["test garage"]);
		expect((await call(t, { method: "DELETE", path: "/merchants/test%20grocer" })).status).toBe(404);
	});
});
