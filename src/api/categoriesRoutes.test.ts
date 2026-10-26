import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Category } from "../types";
import { makeTestPlugin, send, type TestPlugin, type TestRequest } from "./testPlugin";

/**
 * Food (primary, budgeted as a breakdown) with Groceries and Dining under it, Transport with no
 * children, and two rows tagged Groceries and Food.
 */
async function fixture(): Promise<TestPlugin> {
	const t = makeTestPlugin();
	await t.store.load();
	t.store.accounts = [{ id: "acc-1", name: "Checking", type: "debit", currency: "EUR" }];
	t.store.categories = [
		{ id: "cat-food", name: "Food", color: "#ff0000", icon: "utensils", aliases: [], budgetMode: "breakdown" },
		{ id: "cat-groceries", name: "Groceries", color: "#ff0000", icon: "utensils", aliases: ["supermarket"], parentId: "cat-food" },
		{ id: "cat-dining", name: "Dining", color: "#ff0000", icon: "utensils", aliases: [], parentId: "cat-food" },
		{ id: "cat-transport", name: "Transport", color: "#0000ff", icon: "car", aliases: [] },
	];
	await t.store.saveCategories();
	await t.store.importTransactions([
		{ id: "tx-1", date: "2024-03-01", accountId: "acc-1", description: "Shop", amount: -5, currency: "EUR", source: "manual", categoryId: "cat-groceries" },
		{ id: "tx-2", date: "2024-03-02", accountId: "acc-1", description: "Cafe", amount: -6, currency: "EUR", source: "manual", categoryId: "cat-food" },
		{ id: "tx-3", date: "2024-03-03", accountId: "acc-1", description: "Train", amount: -7, currency: "EUR", source: "manual", categoryId: "cat-transport" },
	]);
	return t;
}

const CATEGORIES_FILE = "TestFinance/data/categories.json";

function call(t: TestPlugin, req: TestRequest) {
	return send(t, crypto, req);
}

function byId(t: TestPlugin, id: string): Category | undefined {
	return t.store.categories.find((c) => c.id === id);
}

describe("GET /categories", () => {
	it("lists primaries and secondaries in one list", async () => {
		const t = await fixture();
		const res = await call(t, { path: "/categories" });
		expect(res.status).toBe(200);
		const { categories } = res.json as { categories: Category[] };
		expect(categories.map((c) => c.id)).toEqual(["cat-food", "cat-groceries", "cat-dining", "cat-transport"]);
	});

	it("gets one, and 404s an unknown id", async () => {
		const t = await fixture();
		expect((await call(t, { path: "/categories/cat-groceries" })).json).toMatchObject({ name: "Groceries", parentId: "cat-food" });
		expect((await call(t, { path: "/categories/nope" })).status).toBe(404);
	});
});

describe("POST /categories", () => {
	it("creates a primary with the default colour and icon, 201 with written", async () => {
		const t = await fixture();
		const res = await call(t, { method: "POST", path: "/categories", body: { name: "Health", kind: "expense", essential: true } });
		expect(res.status).toBe(201);
		const { category, written } = res.json as { category: Category; written: string[] };
		expect(written).toEqual([CATEGORIES_FILE]);
		expect(category).toMatchObject({ name: "Health", color: "#64748b", icon: "tag", aliases: [], kind: "expense", essential: true });
		expect(category.id).toMatch(/^cat-/);
		// A reload seeds default secondaries for a new primary exactly as it does for one made in Settings.
		await t.store.load();
		expect(byId(t, category.id)).toMatchObject(category);
	});

	it("creates a secondary that inherits its parent's look", async () => {
		const t = await fixture();
		const res = await call(t, { method: "POST", path: "/categories", body: { name: "Snacks", parentId: "cat-food" } });
		expect(res.status).toBe(201);
		expect((res.json as { category: Category }).category).toMatchObject({ parentId: "cat-food", color: "#ff0000", icon: "utensils" });
	});

	it.each([
		[{}, "name is required"],
		[{ name: "X", parentId: "cat-groceries" }, "is itself a subcategory"],
		[{ name: "X", parentId: "cat-nope" }, 'no category "cat-nope"'],
		[{ name: "X", parentId: "cat-food", budgetMode: "breakdown" }, "budgetMode applies to primary categories only"],
		[{ name: "X", budgetHistory: { "2024-13": 5 } }, "budgetHistory keys must be months"],
		[{ name: "X", kind: "savings" }, "kind must be one of expense, income"],
		[{ name: "X", colour: "#fff" }, 'Unknown field "colour"'],
	])("refuses %j with a 400", async (body, message) => {
		const t = await fixture();
		const res = await call(t, { method: "POST", path: "/categories", body });
		expect(res.status).toBe(400);
		expect((res.json as { error: string }).error).toContain(message);
		expect(t.store.categories).toHaveLength(4);
	});
});

describe("PATCH /categories/:id", () => {
	it("changes only the fields sent; null clears an optional one", async () => {
		const t = await fixture();
		const res = await call(t, {
			method: "PATCH",
			path: "/categories/cat-food",
			body: { name: "Food & drink", budgetMode: null, budgetHistory: { "2024-03": 400 } },
		});
		expect(res.status).toBe(200);
		expect((res.json as { category: Category }).category).toEqual({
			id: "cat-food",
			name: "Food & drink",
			color: "#ff0000",
			icon: "utensils",
			aliases: [],
			budgetHistory: { "2024-03": 400 },
		});
		await t.store.load();
		expect(byId(t, "cat-food")?.name).toBe("Food & drink");
	});

	it("clearing aliases leaves an empty list rather than none", async () => {
		const t = await fixture();
		const res = await call(t, { method: "PATCH", path: "/categories/cat-groceries", body: { aliases: null } });
		expect((res.json as { category: Category }).category.aliases).toEqual([]);
	});

	it("moves a secondary to another primary, and to the top level with null", async () => {
		const t = await fixture();
		let res = await call(t, { method: "PATCH", path: "/categories/cat-dining", body: { parentId: "cat-transport" } });
		expect(res.status).toBe(200);
		expect(byId(t, "cat-dining")?.parentId).toBe("cat-transport");
		res = await call(t, { method: "PATCH", path: "/categories/cat-dining", body: { parentId: null } });
		expect(res.status).toBe(200);
		expect("parentId" in (byId(t, "cat-dining") as Category)).toBe(false);
	});

	it("moving a primary under another drops its budgetMode, and refuses to set it in the same call", async () => {
		const t = await fixture();
		await call(t, { method: "PATCH", path: "/categories/cat-transport", body: { budgetMode: "total" } });
		const refused = await call(t, { method: "PATCH", path: "/categories/cat-transport", body: { parentId: "cat-food", budgetMode: "total" } });
		expect(refused.status).toBe(400);
		expect(byId(t, "cat-transport")?.parentId).toBeUndefined();
		const res = await call(t, { method: "PATCH", path: "/categories/cat-transport", body: { parentId: "cat-food" } });
		expect(res.status).toBe(200);
		expect(byId(t, "cat-transport")).toMatchObject({ parentId: "cat-food" });
		expect("budgetMode" in (byId(t, "cat-transport") as Category)).toBe(false);
	});

	it.each([
		["cat-food", { parentId: "cat-transport" }, "has 2 subcategories"],
		["cat-transport", { parentId: "cat-groceries" }, "is itself a subcategory"],
		["cat-transport", { parentId: "cat-transport" }, "can't be its own parent"],
		["cat-transport", { parentId: "cat-nope" }, 'no category "cat-nope"'],
	])("refuses an illegal move of %s with a 400", async (id, body, message) => {
		const t = await fixture();
		const before = JSON.stringify(t.store.categories);
		const res = await call(t, { method: "PATCH", path: `/categories/${id}`, body });
		expect(res.status).toBe(400);
		expect((res.json as { error: string }).error).toContain(message);
		expect(JSON.stringify(t.store.categories)).toBe(before);
	});

	it("sending the parent it already has is not an error", async () => {
		const t = await fixture();
		const res = await call(t, { method: "PATCH", path: "/categories/cat-dining", body: { parentId: "cat-food", name: "Eating out" } });
		expect(res.status).toBe(200);
		expect(byId(t, "cat-dining")).toMatchObject({ parentId: "cat-food", name: "Eating out" });
	});

	it("archiving a primary takes its secondaries with it, and restoring brings them back", async () => {
		const t = await fixture();
		let res = await call(t, { method: "PATCH", path: "/categories/cat-food", body: { archived: true } });
		expect(res.status).toBe(200);
		expect((res.json as { written: string[] }).written).toEqual([CATEGORIES_FILE]);
		expect(t.store.categories.filter((c) => c.archived).map((c) => c.id)).toEqual(["cat-food", "cat-groceries", "cat-dining"]);
		// Archiving never touches a transaction.
		expect(t.store.transactions.find((x) => x.id === "tx-1")?.categoryId).toBe("cat-groceries");
		res = await call(t, { method: "PATCH", path: "/categories/cat-food", body: { archived: false } });
		expect(t.store.categories.some((c) => "archived" in c)).toBe(false);
	});

	it("404s an unknown id and 400s bad bodies", async () => {
		const t = await fixture();
		expect((await call(t, { method: "PATCH", path: "/categories/nope", body: { name: "X" } })).status).toBe(404);
		for (const body of [{}, { name: null }, { colour: "#000" }, { archived: "yes" }]) {
			expect((await call(t, { method: "PATCH", path: "/categories/cat-food", body })).status).toBe(400);
		}
	});
});

describe("DELETE /categories/:id", () => {
	it("deletes an unused category", async () => {
		const t = await fixture();
		t.store.categories.push({ id: "cat-unused", name: "Unused", color: "#000", icon: "tag", aliases: [] });
		const res = await call(t, { method: "DELETE", path: "/categories/cat-unused" });
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ deleted: "cat-unused", written: [CATEGORIES_FILE] });
		expect(byId(t, "cat-unused")).toBeUndefined();
	});

	it("refuses with 409 while transactions are tagged with it or its subcategories", async () => {
		const t = await fixture();
		const res = await call(t, { method: "DELETE", path: "/categories/cat-food" });
		expect(res.status).toBe(409);
		expect((res.json as { error: string }).error).toMatch(/2 transactions are tagged with "Food" or its subcategories/);
		expect(t.store.categories).toHaveLength(4);
	});

	it("?moveTo moves the rows and deletes a primary together with its secondaries", async () => {
		const t = await fixture();
		const res = await call(t, { method: "DELETE", path: "/categories/cat-food?moveTo=cat-transport" });
		expect(res.status).toBe(200);
		expect(res.json).toEqual({
			deleted: "cat-food",
			deletedSubcategories: ["cat-groceries", "cat-dining"],
			transactions: { affected: 2, movedTo: "cat-transport" },
			written: expect.arrayContaining(["TestFinance/data/ledger/manual/2024.csv", CATEGORIES_FILE]),
		});
		await t.store.load();
		expect(t.store.categories.map((c) => c.id)).toEqual(["cat-transport"]);
		expect(t.store.transactions.map((x) => x.categoryId)).toEqual(["cat-transport", "cat-transport", "cat-transport"]);
	});

	it("?moveTo=none leaves the rows uncategorized; a secondary goes alone", async () => {
		const t = await fixture();
		const res = await call(t, { method: "DELETE", path: "/categories/cat-groceries?moveTo=none" });
		expect(res.status).toBe(200);
		expect(t.store.categories.map((c) => c.id)).toEqual(["cat-food", "cat-dining", "cat-transport"]);
		expect(t.store.transactions.find((x) => x.id === "tx-1")?.categoryId).toBeUndefined();
	});

	it("refuses a moveTo that doesn't exist or is being deleted", async () => {
		const t = await fixture();
		expect((await call(t, { method: "DELETE", path: "/categories/cat-food?moveTo=cat-nope" })).status).toBe(400);
		expect((await call(t, { method: "DELETE", path: "/categories/cat-food?moveTo=cat-dining" })).status).toBe(400);
		expect(t.store.categories).toHaveLength(4);
	});

	it("404s an unknown id", async () => {
		expect((await call(await fixture(), { method: "DELETE", path: "/categories/nope" })).status).toBe(404);
	});
});
