import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import FinancePlugin from "../main";
import { merchantKey } from "../import/merchantKey";
import type { Transaction } from "../types";
import { send } from "./testPlugin";
import { ledger, makeLedgerPlugin, snapshot } from "./transactionsFixture";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./transactionsRoutes";

interface Page {
	items: Transaction[];
	total: number;
	nextOffset: number | null;
}

async function list(query = ""): Promise<Page> {
	const t = await makeLedgerPlugin();
	const res = await send(t, crypto, { path: `/transactions${query}` });
	expect(res.status).toBe(200);
	return res.json as Page;
}

const ids = (page: Page): string[] => page.items.map((t) => t.id);

describe("GET /mmf/v1/transactions", () => {
	it("lists every row newest first, id breaking ties, with the total and no next page", async () => {
		const page = await list();
		expect(ids(page)).toEqual(["t-08", "t-09", "t-07", "t-06", "t-05", "t-04", "t-03", "t-02", "t-01", "t-undated"]);
		expect(page.total).toBe(10);
		expect(page.nextOffset).toBeNull();
	});

	it("filters by account", async () => {
		expect(ids(await list("?account=acc-cc"))).toEqual(["t-09", "t-07"]);
		expect((await list("?account=nope")).total).toBe(0);
	});

	it("filters by an inclusive from/to date range and leaves undated rows out", async () => {
		expect(ids(await list("?from=2024-02-01&to=2024-02-28"))).toEqual(["t-05", "t-04", "t-03"]);
		expect(ids(await list("?from=2024-03-10"))).toEqual(["t-08", "t-09", "t-07"]);
		expect(ids(await list("?to=2024-01-20"))).toEqual(["t-02", "t-01"]);
	});

	it("filters by category, a primary also matching its subcategories", async () => {
		expect(ids(await list("?category=cat-food"))).toEqual(["t-08", "t-05"]);
		expect(ids(await list("?category=cat-food-super"))).toEqual(["t-05"]);
		expect(ids(await list("?category=cat-rent"))).toEqual(["t-03"]);
	});

	it("filters to uncategorised rows, or to categorised ones", async () => {
		expect(ids(await list("?uncategorised=true"))).toEqual(["t-09", "t-07", "t-06", "t-02", "t-01", "t-undated"]);
		expect(ids(await list("?uncategorised=false"))).toEqual(["t-08", "t-05", "t-04", "t-03"]);
	});

	it("searches description, counterparty and notes case-insensitively", async () => {
		expect(ids(await list("?q=grocer"))).toEqual(["t-08", "t-02", "t-01"]);
		expect(ids(await list("?q=STATIONERY"))).toEqual(["t-09"]);
		expect(ids(await list("?q=birthday"))).toEqual(["t-04"]);
		expect(ids(await list("?q=%20housing%20co%20"))).toEqual(["t-03"]);
	});

	it("filters by review status, absent counting as new, comma or repeated", async () => {
		expect(ids(await list("?review=approved"))).toEqual(["t-05", "t-03"]);
		expect(ids(await list("?review=flagged"))).toEqual(["t-04"]);
		expect((await list("?review=new")).total).toBe(7);
		expect(ids(await list("?review=approved,flagged"))).toEqual(["t-05", "t-04", "t-03"]);
		expect(ids(await list("?review=approved&review=flagged"))).toEqual(["t-05", "t-04", "t-03"]);
	});

	it("combines filters", async () => {
		expect(ids(await list("?account=acc-chk&uncategorised=true&q=grocer&from=2024-01-10"))).toEqual(["t-02"]);
	});

	it("pages with limit and offset, nextOffset pointing at the next page until the end", async () => {
		const first = await list("?limit=4");
		expect(ids(first)).toEqual(["t-08", "t-09", "t-07", "t-06"]);
		expect(first).toMatchObject({ total: 10, nextOffset: 4 });
		const second = await list("?limit=4&offset=4");
		expect(ids(second)).toEqual(["t-05", "t-04", "t-03", "t-02"]);
		expect(second.nextOffset).toBe(8);
		const last = await list("?limit=4&offset=8");
		expect(ids(last)).toEqual(["t-01", "t-undated"]);
		expect(last.nextOffset).toBeNull();
		const past = await list("?offset=50");
		expect(past).toEqual({ items: [], total: 10, nextOffset: null });
	});

	it("defaults the page to 200 rows and caps it at 1000", async () => {
		const many = Array.from({ length: 1205 }, (_, i) => ({
			id: `bulk-${String(i).padStart(4, "0")}`,
			date: "2024-05-01",
			accountId: "acc-chk",
			description: `Synthetic row ${i}`,
			amount: -1,
			currency: "EUR",
			source: "generic" as const,
		}));
		const t = await makeLedgerPlugin(many);
		const byDefault = (await send(t, crypto, { path: "/transactions" })).json as Page;
		expect(byDefault.items).toHaveLength(DEFAULT_LIMIT);
		expect(byDefault.nextOffset).toBe(DEFAULT_LIMIT);
		const max = (await send(t, crypto, { path: `/transactions?limit=${MAX_LIMIT}` })).json as Page;
		expect(max.items).toHaveLength(MAX_LIMIT);
		expect(max).toMatchObject({ total: 1205, nextOffset: MAX_LIMIT });
		const over = await send(t, crypto, { path: `/transactions?limit=${MAX_LIMIT + 1}` });
		expect(over.status).toBe(400);
	});

	it.each([
		["from=2024-13-01", "from must be a date in YYYY-MM-DD form"],
		["to=2024-02-30", "to must be a date in YYYY-MM-DD form"],
		["from=1-1-2024", "from must be a date in YYYY-MM-DD form"],
		["from=2024-03-01&to=2024-02-01", "from must not be after to"],
		["uncategorised=yes", "uncategorised must be true or false"],
		["review=done", "review must be one of new, approved, flagged"],
		["limit=0", "limit must be between 1 and 1000"],
		["limit=ten", "limit must be a whole number"],
		["offset=-1", "offset must be a whole number"],
	])("refuses ?%s with a 400", async (query, error) => {
		const t = await makeLedgerPlugin();
		const res = await send(t, crypto, { path: `/transactions?${query}` });
		expect(res.status).toBe(400);
		expect(res.json).toEqual({ error });
	});

	it("needs the token like every other route", async () => {
		const t = await makeLedgerPlugin();
		expect((await send(t, crypto, { path: "/transactions", token: null })).status).toBe(401);
	});
});

describe("GET /mmf/v1/transactions/:id", () => {
	it("returns one transaction", async () => {
		const t = await makeLedgerPlugin();
		const res = await send(t, crypto, { path: "/transactions/t-04" });
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ id: "t-04", categoryId: "cat-fun", review: "flagged", notes: "Birthday outing" });
	});

	it("decodes the id and 404s an unknown one", async () => {
		const t = await makeLedgerPlugin(ledger().concat({ ...ledger()[0], id: "odd id/1" }));
		expect((await send(t, crypto, { path: "/transactions/odd%20id%2F1" })).status).toBe(200);
		const res = await send(t, crypto, { path: "/transactions/missing" });
		expect(res.status).toBe(404);
		expect(res.json).toEqual({ error: "Transaction missing not found" });
	});
});

describe("PATCH /mmf/v1/transactions/:id", () => {
	const patch = (path: string, body: unknown) => ({ method: "PATCH", path: `/transactions/${path}`, body });

	it("changes a category exactly as the UI's assignCategory does: fan-out, merchant memory, provenance, review hook", async () => {
		// Precondition: the three GROCER BROTHERS rows really are one merchant, or there is no fan-out to see.
		const rows = ledger();
		const key = merchantKey(rows[0]);
		expect(key).toBeDefined();
		expect(merchantKey(rows[1])).toBe(key);
		expect(merchantKey(rows[7])).toBe(key);

		// The UI path, on its own store: what the transaction detail modal runs.
		const ui = await makeLedgerPlugin();
		const uiTx = ui.store.transactions.find((t) => t.id === "t-01")!;
		const uiAlso = await FinancePlugin.prototype.assignCategory.call(ui.plugin, uiTx, "cat-food-super");

		// The API path, on an identical store.
		const api = await makeLedgerPlugin();
		const res = await send(api, crypto, patch("t-01", { categoryId: "cat-food-super" }));
		expect(res.status).toBe(200);
		const body = res.json as { transaction: Transaction; alsoCategorised: number; written: number };

		expect(snapshot(api.store.transactions)).toEqual(snapshot(ui.store.transactions));
		expect(api.store.merchants).toEqual(ui.store.merchants);
		expect(api.reviewChanges).toEqual(ui.reviewChanges);
		expect(body.alsoCategorised).toBe(uiAlso);

		// And what that behaviour actually is, so "identical" can't mean "identically broken".
		const byId = (id: string) => api.store.transactions.find((t) => t.id === id)!;
		expect(body.transaction).toMatchObject({ id: "t-01", categoryId: "cat-food-super" });
		expect(byId("t-02").categoryId).toBe("cat-food-super");
		expect(body.alsoCategorised).toBe(1);
		// t-08 was filed elsewhere by a rule (not blank, not the merchant's previous category): left alone.
		expect(byId("t-08")).toMatchObject({ categoryId: "cat-food", categoryRuleId: "rule-grocer" });
		expect(api.store.merchants[key!]).toMatchObject({ categoryId: "cat-food-super", source: "user" });
		expect(api.reviewChanges.length).toBeGreaterThan(0);
		expect(body.written).toBeGreaterThan(0);
		expect(api.refreshes()).toBe(1);
	});

	it("clears stale rule provenance when the category is changed by hand", async () => {
		const t = await makeLedgerPlugin();
		const res = await send(t, crypto, patch("t-08", { categoryId: "cat-food-super" }));
		expect(res.status).toBe(200);
		const row = t.store.transactions.find((x) => x.id === "t-08")!;
		expect(row.categoryId).toBe("cat-food-super");
		expect(row.categoryRuleId).toBeUndefined();
	});

	it("clears a category with null, without teaching merchant memory", async () => {
		const t = await makeLedgerPlugin();
		const res = await send(t, crypto, patch("t-08", { categoryId: null }));
		expect(res.status).toBe(200);
		expect((res.json as { transaction: Transaction }).transaction.categoryId).toBeUndefined();
		const row = t.store.transactions.find((x) => x.id === "t-08")!;
		expect(row.categoryId).toBeUndefined();
		expect(row.categoryRuleId).toBeUndefined();
		expect(t.store.merchants).toEqual({});
	});

	it("treats re-sending the current category as no change", async () => {
		const t = await makeLedgerPlugin();
		const before = t.store.revision;
		const res = await send(t, crypto, patch("t-03", { categoryId: "cat-rent" }));
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ alsoCategorised: 0, written: 0 });
		expect(t.store.merchants).toEqual({});
		// The pipeline's own post-write refresh still counts it, so a poller never sees a stale revision.
		expect(t.store.revision).toBe(before + 1);
	});

	it("sets, trims and clears notes", async () => {
		const t = await makeLedgerPlugin();
		const set = await send(t, crypto, patch("t-01", { notes: "  weekly shop  " }));
		expect((set.json as { transaction: Transaction }).transaction.notes).toBe("weekly shop");
		expect(set.json).toMatchObject({ written: 1 });
		await send(t, crypto, patch("t-04", { notes: null }));
		expect(t.store.transactions.find((x) => x.id === "t-04")!.notes).toBeUndefined();
		await send(t, crypto, patch("t-01", { notes: "   " }));
		expect(t.store.transactions.find((x) => x.id === "t-01")!.notes).toBeUndefined();
	});

	it("persists the change to the ledger file, not just memory", async () => {
		const t = await makeLedgerPlugin();
		await send(t, crypto, patch("t-01", { notes: "on disk", categoryId: "cat-food" }));
		await t.store.load();
		expect(t.store.transactions.find((x) => x.id === "t-01")).toMatchObject({ notes: "on disk", categoryId: "cat-food" });
	});

	it("sets a debt-payment split on a payment into a loan or credit card, and clears it with null", async () => {
		const t = await makeLedgerPlugin();
		const res = await send(t, crypto, patch("t-06", { principalAmount: 200, interestAmount: 45.5, feeAmount: 4.5 }));
		expect(res.status).toBe(200);
		expect((res.json as { transaction: Transaction }).transaction).toMatchObject({ principalAmount: 200, interestAmount: 45.5, feeAmount: 4.5 });

		const partial = await send(t, crypto, patch("t-07", { feeAmount: 0 }));
		expect(partial.status).toBe(200);
		const cleared = await send(t, crypto, patch("t-07", { principalAmount: null, interestAmount: null, feeAmount: null }));
		expect(cleared.status).toBe(200);
		const row = t.store.transactions.find((x) => x.id === "t-07")!;
		expect([row.principalAmount, row.interestAmount, row.feeAmount]).toEqual([undefined, undefined, undefined]);
	});

	it("allows clearing a split even on a row that no longer qualifies for one", async () => {
		const rows = ledger();
		rows[0].interestAmount = 5;
		const t = await makeLedgerPlugin(rows);
		expect((await send(t, crypto, patch("t-01", { interestAmount: null }))).status).toBe(200);
	});

	it.each([
		["t-01", { interestAmount: 5 }, "A principal/interest/fee split only applies to a payment into a loan, mortgage or credit card account"],
		["t-09", { feeAmount: 1 }, "A principal/interest/fee split only applies to a payment into a loan, mortgage or credit card account"],
		["t-06", { principalAmount: 200, interestAmount: 50.01 }, "The split (250.01) is more than the transaction amount (250.00)"],
		["t-07", { feeAmount: 5 }, "The split (125.00) is more than the transaction amount (120.00)"],
		["t-06", { interestAmount: -1 }, "interestAmount must be a number of zero or more, or null"],
		["t-06", { feeAmount: "3" }, "feeAmount must be a number of zero or more, or null"],
		["t-01", { amount: 5 }, "Cannot change amount through the API — only categoryId, notes and the debt-payment split"],
		["t-01", { review: "approved", date: "2024-01-01" }, "Cannot change review, date through the API — only categoryId, notes and the debt-payment split"],
		["t-01", {}, "Nothing to change — send categoryId, notes or a debt-payment split field"],
		["t-01", [], "Body must be a JSON object"],
		["t-01", { categoryId: "cat-nope" }, "Category cat-nope not found"],
		["t-01", { categoryId: "cat-old" }, "Category cat-old is archived"],
		["t-01", { categoryId: 7 }, "categoryId must be a category id"],
		["t-01", { notes: 7 }, "notes must be a string or null"],
	])("refuses PATCH %s %j with a 400 and writes nothing", async (id, body, error) => {
		const t = await makeLedgerPlugin();
		const before = snapshot(t.store.transactions);
		const res = await send(t, crypto, patch(id, body));
		expect(res.status).toBe(400);
		expect(res.json).toEqual({ error });
		expect(snapshot(t.store.transactions)).toEqual(before);
		expect(t.refreshes()).toBe(0);
	});

	it("validates every field before writing any: a bad split leaves the category untouched", async () => {
		const t = await makeLedgerPlugin();
		const res = await send(t, crypto, patch("t-06", { categoryId: "cat-rent", interestAmount: 999 }));
		expect(res.status).toBe(400);
		expect(t.store.transactions.find((x) => x.id === "t-06")!.categoryId).toBeUndefined();
		expect(t.store.merchants).toEqual({});
	});

	it("keeps an archived category the row already has", async () => {
		const rows = ledger();
		rows[0].categoryId = "cat-old";
		const t = await makeLedgerPlugin(rows);
		expect((await send(t, crypto, patch("t-01", { categoryId: "cat-old", notes: "still old" }))).status).toBe(200);
	});

	it("404s an unknown transaction", async () => {
		const t = await makeLedgerPlugin();
		const res = await send(t, crypto, patch("missing", { notes: "x" }));
		expect(res.status).toBe(404);
		expect(res.json).toEqual({ error: "Transaction missing not found" });
	});

	it("reads and writes whichever store the plugin holds now, never one captured earlier", async () => {
		const t = await makeLedgerPlugin();
		const other = await makeLedgerPlugin(ledger().slice(0, 2));
		(t.plugin as unknown as { store: unknown }).store = other.store;
		expect(((await send(t, crypto, { path: "/transactions" })).json as Page).total).toBe(2);
		await send(t, crypto, patch("t-01", { notes: "switched" }));
		expect(other.store.transactions.find((x) => x.id === "t-01")!.notes).toBe("switched");
		expect(t.store.transactions.find((x) => x.id === "t-01")!.notes).toBeUndefined();
	});
});
