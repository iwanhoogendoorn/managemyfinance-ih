import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { CategoryRule } from "../types";
import { makeTestPlugin, send, type TestPlugin, type TestRequest } from "./testPlugin";

/** Two categories, one legacy regex rule (isRegex, no match) and one amount-narrowed rule that has
 *  stamped the row it filed. */
async function fixture(): Promise<TestPlugin> {
	const t = makeTestPlugin();
	await t.store.load();
	t.store.accounts = [{ id: "acc-1", name: "Checking", type: "debit", currency: "EUR" }];
	t.store.categories = [
		{ id: "cat-food", name: "Food", color: "#f00", icon: "tag", aliases: [] },
		{ id: "cat-subs", name: "Subscriptions", color: "#00f", icon: "tag", aliases: [] },
	];
	t.store.rules = [
		{ id: "rule-legacy", pattern: "^bakery", isRegex: true, categoryId: "cat-food" },
		{ id: "rule-apple", pattern: "Apple", match: "exact", amount: { op: "exactly", value: 9.99 }, categoryId: "cat-subs" },
	];
	await t.store.saveRules();
	await t.store.importTransactions([
		{
			id: "tx-1",
			date: "2024-03-01",
			accountId: "acc-1",
			description: "Apple",
			amount: -9.99,
			currency: "EUR",
			source: "manual",
			categoryId: "cat-subs",
			categoryRuleId: "rule-apple",
		},
	]);
	return t;
}

const RULES_FILE = "TestFinance/data/rules.json";
const LEDGER_FILE = "TestFinance/data/ledger/manual/2024.csv";

function call(t: TestPlugin, req: TestRequest) {
	return send(t, crypto, req);
}

function error(res: { json: unknown }): string {
	return (res.json as { error: string }).error;
}

describe("GET /rules", () => {
	it("lists rules in the order they are tried", async () => {
		const t = await fixture();
		const res = await call(t, { path: "/rules" });
		expect(res.status).toBe(200);
		expect((res.json as { rules: CategoryRule[] }).rules.map((r) => r.id)).toEqual(["rule-legacy", "rule-apple"]);
	});

	it("gets one, and 404s an unknown id", async () => {
		const t = await fixture();
		expect((await call(t, { path: "/rules/rule-apple" })).json).toMatchObject({ pattern: "Apple", match: "exact" });
		expect((await call(t, { path: "/rules/nope" })).status).toBe(404);
	});
});

describe("POST /rules", () => {
	it("creates a contains rule first in the list, 201 with written", async () => {
		const t = await fixture();
		const res = await call(t, { method: "POST", path: "/rules", body: { pattern: " Albert Heijn ", categoryId: "cat-food" } });
		expect(res.status).toBe(201);
		const { rule, written } = res.json as { rule: CategoryRule; written: string[] };
		expect(written).toEqual([RULES_FILE]);
		expect(rule).toMatchObject({ pattern: "Albert Heijn", match: "contains", categoryId: "cat-food" });
		expect(rule.id).toMatch(/^rule-/);
		expect("isRegex" in rule).toBe(false);
		await t.store.load();
		expect(t.store.rules[0]).toEqual(rule);
	});

	it("writes isRegex alongside match: regex, and keeps an amount condition", async () => {
		const t = await fixture();
		const res = await call(t, {
			method: "POST",
			path: "/rules",
			body: { pattern: "^spotify", match: "regex", categoryId: "cat-subs", amount: { op: "any-of", values: [9.99, 4.99] } },
		});
		expect(res.status).toBe(201);
		expect((res.json as { rule: CategoryRule }).rule).toMatchObject({
			match: "regex",
			isRegex: true,
			amount: { op: "any-of", value: 9.99, values: [9.99, 4.99] },
		});
	});

	it("doesn't re-file the ledger", async () => {
		const t = await fixture();
		await call(t, { method: "POST", path: "/rules", body: { pattern: "Apple", categoryId: "cat-food" } });
		expect(t.store.transactions[0].categoryId).toBe("cat-subs");
	});

	it.each([
		[{ categoryId: "cat-food" }, "pattern is required"],
		[{ pattern: "  ", categoryId: "cat-food" }, "pattern can't be empty"],
		[{ pattern: "x" }, "categoryId is required"],
		[{ pattern: "x", categoryId: "cat-nope" }, 'categoryId: no category "cat-nope"'],
		[{ pattern: "x", categoryId: "cat-food", match: "fuzzy" }, "match must be one of contains, exact, starts-with, regex"],
		[{ pattern: "(a+)+$", categoryId: "cat-food", match: "regex" }, "nests one repeat inside another"],
		[{ pattern: "([unclosed", categoryId: "cat-food", match: "regex" }, "isn't a regular expression"],
		[{ pattern: "x", categoryId: "cat-food", amount: { op: "around", value: 1 } }, "amount.op must be one of"],
		[{ pattern: "x", categoryId: "cat-food", amount: { op: "between", value: 1 } }, "amount.value2 must be a number"],
		[{ pattern: "x", categoryId: "cat-food", amount: { op: "exactly", value: 1, value2: 2 } }, 'only for op "between"'],
		[{ pattern: "x", categoryId: "cat-food", amount: { op: "any-of", values: [] } }, "non-empty list"],
		[{ pattern: "x", categoryId: "cat-food", amount: { op: "exactly", value: 1, currency: "EUR" } }, 'Unknown field "amount.currency"'],
		[{ pattern: "x", categoryId: "cat-food", isRegex: true }, 'Unknown field "isRegex"'],
	])("refuses %j with a 400", async (body, message) => {
		const t = await fixture();
		const res = await call(t, { method: "POST", path: "/rules", body });
		expect(res.status).toBe(400);
		expect(error(res)).toContain(message);
		expect(t.store.rules).toHaveLength(2);
	});
});

describe("PATCH /rules/:id", () => {
	it("changes only the fields sent, in place, and null drops the amount condition", async () => {
		const t = await fixture();
		const res = await call(t, { method: "PATCH", path: "/rules/rule-apple", body: { categoryId: "cat-food", amount: null } });
		expect(res.status).toBe(200);
		const { rule } = res.json as { rule: CategoryRule };
		expect(rule).toEqual({ id: "rule-apple", pattern: "Apple", match: "exact", categoryId: "cat-food" });
		await t.store.load();
		expect(t.store.rules.map((r) => r.id)).toEqual(["rule-legacy", "rule-apple"]);
		expect(t.store.rules[1]).toEqual(rule);
	});

	it("checks a legacy regex rule's new pattern as a regex", async () => {
		const t = await fixture();
		const res = await call(t, { method: "PATCH", path: "/rules/rule-legacy", body: { pattern: "(x*)*" } });
		expect(res.status).toBe(400);
		expect(error(res)).toContain("nests one repeat");
		expect(t.store.rules[0].pattern).toBe("^bakery");
	});

	it("checks the existing pattern when only match turns to regex", async () => {
		const t = await fixture();
		t.store.rules[1].pattern = "(a+)+";
		expect((await call(t, { method: "PATCH", path: "/rules/rule-apple", body: { match: "regex" } })).status).toBe(400);
	});

	it("moving off regex drops the legacy flag", async () => {
		const t = await fixture();
		const res = await call(t, { method: "PATCH", path: "/rules/rule-legacy", body: { match: "starts-with", pattern: "bakery" } });
		expect(res.status).toBe(200);
		expect((res.json as { rule: CategoryRule }).rule).toEqual({ id: "rule-legacy", pattern: "bakery", match: "starts-with", categoryId: "cat-food" });
	});

	it("unstamps rows the narrowed rule no longer matches, keeping their category", async () => {
		const t = await fixture();
		const res = await call(t, { method: "PATCH", path: "/rules/rule-apple", body: { amount: { op: "exactly", value: 4.99 } } });
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ unstamped: 1, written: expect.arrayContaining([RULES_FILE, LEDGER_FILE]) });
		await t.store.load();
		expect(t.store.transactions[0].categoryId).toBe("cat-subs");
		expect(t.store.transactions[0].categoryRuleId).toBeUndefined();
	});

	it("404s an unknown id and 400s bad bodies", async () => {
		const t = await fixture();
		expect((await call(t, { method: "PATCH", path: "/rules/nope", body: { pattern: "x" } })).status).toBe(404);
		for (const body of [{}, { pattern: null }, { categoryId: "cat-nope" }, { match: "glob" }, { priority: 1 }]) {
			expect((await call(t, { method: "PATCH", path: "/rules/rule-apple", body })).status).toBe(400);
		}
		expect(t.store.rules[1].categoryId).toBe("cat-subs");
	});
});

describe("DELETE /rules/:id", () => {
	it("deletes the rule and 404s an unknown one", async () => {
		const t = await fixture();
		const res = await call(t, { method: "DELETE", path: "/rules/rule-legacy" });
		expect(res.status).toBe(200);
		expect(res.json).toEqual({ deleted: "rule-legacy", written: [RULES_FILE] });
		await t.store.load();
		expect(t.store.rules.map((r) => r.id)).toEqual(["rule-apple"]);
		expect((await call(t, { method: "DELETE", path: "/rules/rule-legacy" })).status).toBe(404);
	});
});
