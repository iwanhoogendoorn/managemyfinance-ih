import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { merchantKey } from "../import/merchantKey";
import { reviewCounts } from "../review";
import type { Transaction } from "../types";
import { send } from "./testPlugin";
import { ledger, makeLedgerPlugin, snapshot } from "./transactionsFixture";

interface Queue {
	items: Transaction[];
	total: number;
	nextOffset: number | null;
	counts: ReturnType<typeof reviewCounts>;
}

interface Bulk {
	applied: number;
	changed: number;
	failed: { ref: string; error: string }[];
	written: number;
}

const ids = (q: { items: Transaction[] }): string[] => q.items.map((t) => t.id);
const row = (t: Awaited<ReturnType<typeof makeLedgerPlugin>>, id: string): Transaction => t.store.transactions.find((x) => x.id === id)!;

describe("GET /mmf/v1/review", () => {
	it("lists new and flagged rows newest first, with review.ts's counts for the whole ledger", async () => {
		const t = await makeLedgerPlugin();
		const res = await send(t, crypto, { path: "/review" });
		expect(res.status).toBe(200);
		const queue = res.json as Queue;
		expect(ids(queue)).toEqual(["t-08", "t-09", "t-07", "t-06", "t-04", "t-02", "t-01", "t-undated"]);
		expect(queue.total).toBe(8);
		expect(queue.nextOffset).toBeNull();
		expect(queue.counts).toEqual(reviewCounts(t.store.transactions));
		expect(queue.counts).toEqual({ total: 10, toReview: 7, approved: 2, flagged: 1, uncategorized: 6 });
	});

	it("narrows to one pile, and scopes the counts to an account when one is asked for", async () => {
		const t = await makeLedgerPlugin();
		expect(ids((await send(t, crypto, { path: "/review?review=flagged" })).json as Queue)).toEqual(["t-04"]);
		const cc = (await send(t, crypto, { path: "/review?account=acc-cc" })).json as Queue;
		expect(ids(cc)).toEqual(["t-09", "t-07"]);
		expect(cc.counts).toEqual({ total: 2, toReview: 2, approved: 0, flagged: 0, uncategorized: 2 });
	});

	it("takes the same filters and paging as /transactions", async () => {
		const t = await makeLedgerPlugin();
		const page = (await send(t, crypto, { path: "/review?q=grocer&limit=2" })).json as Queue;
		expect(ids(page)).toEqual(["t-08", "t-02"]);
		expect(page).toMatchObject({ total: 3, nextOffset: 2 });
		expect((await send(t, crypto, { path: "/review?limit=5000" })).status).toBe(400);
	});

	it("refuses to widen the queue to approved rows", async () => {
		const t = await makeLedgerPlugin();
		const res = await send(t, crypto, { path: "/review?review=new,approved" });
		expect(res.status).toBe(400);
		expect(res.json).toEqual({ error: "review may only be new or flagged here" });
	});
});

describe("POST /mmf/v1/review/approve", () => {
	const approve = (body: unknown) => ({ method: "POST", path: "/review/approve", body });

	it("approves every id in one ledger pass, counts already-approved rows as applied, and refreshes", async () => {
		const t = await makeLedgerPlugin();
		const res = await send(t, crypto, approve({ ids: ["t-01", "t-04", "t-03", "t-01"] }));
		expect(res.status).toBe(200);
		const body = res.json as Bulk;
		expect(body).toMatchObject({ applied: 3, changed: 2, failed: [] });
		// One generic/2024 ledger file holds all three rows, so one rewrite — plus merchants.json, because
		// t-03 was the Landlord merchant's only row and approving it confirms that merchant.
		expect(body.written).toBe(2);
		expect(t.store.merchants[merchantKey(row(t, "t-03"))!]?.reviewedAt).toEqual(expect.any(String));
		expect(["t-01", "t-04", "t-03"].map((id) => row(t, id).review)).toEqual(["approved", "approved", "approved"]);
		expect(row(t, "t-02").review).toBeUndefined();
		expect(t.reviewChanges).toHaveLength(1);
		expect(t.refreshes()).toBe(1);
	});

	it("reports unknown ids per ref and still approves the rest", async () => {
		const t = await makeLedgerPlugin();
		const body = (await send(t, crypto, approve({ ids: ["t-01", "gone-1", "t-02", "gone-2"] }))).json as Bulk;
		expect(body.applied).toBe(2);
		expect(body.failed).toEqual([
			{ ref: "gone-1", error: "Transaction not found" },
			{ ref: "gone-2", error: "Transaction not found" },
		]);
		expect(row(t, "t-01").review).toBe("approved");
		expect(row(t, "t-02").review).toBe("approved");
	});

	it("writes nothing when every id is unknown", async () => {
		const t = await makeLedgerPlugin();
		const before = t.store.revision;
		const body = (await send(t, crypto, approve({ ids: ["gone"] }))).json as Bulk;
		expect(body).toEqual({ applied: 0, changed: 0, failed: [{ ref: "gone", error: "Transaction not found" }], written: 0 });
		// Only the pipeline's own post-write bump; no file was touched.
		expect(t.store.revision).toBe(before + 1);
	});

	it("confirms a merchant once its last row is approved, as the Review page does", async () => {
		const rows = ledger();
		for (const id of ["t-01", "t-02", "t-08"]) rows.find((r) => r.id === id)!.categoryId = "cat-food";
		const t = await makeLedgerPlugin(rows);
		const key = merchantKey(rows[0])!;

		await send(t, crypto, approve({ ids: ["t-01", "t-02"] }));
		expect(t.store.merchants[key]?.reviewedAt).toBeUndefined();
		await send(t, crypto, approve({ ids: ["t-08"] }));
		expect(t.store.merchants[key]).toMatchObject({ categoryId: "cat-food", reviewedAt: expect.any(String) });
	});

	it.each([
		[{}, "ids must be a non-empty array of transaction ids"],
		[{ ids: [] }, "ids must be a non-empty array of transaction ids"],
		[{ ids: "t-01" }, "ids must be a non-empty array of transaction ids"],
		[{ ids: ["t-01", 2] }, "ids must contain only transaction ids"],
		[["t-01"], "Body must be a JSON object"],
	])("refuses %j with a 400", async (body, error) => {
		const t = await makeLedgerPlugin();
		const before = snapshot(t.store.transactions);
		const res = await send(t, crypto, approve(body));
		expect(res.status).toBe(400);
		expect(res.json).toEqual({ error });
		expect(snapshot(t.store.transactions)).toEqual(before);
	});

	it("refuses a body that is not JSON, and a GET", async () => {
		const t = await makeLedgerPlugin();
		expect((await send(t, crypto, approve("{nope"))).status).toBe(400);
		expect((await send(t, crypto, { path: "/review/approve" })).status).toBe(405);
	});
});

describe("POST /mmf/v1/review/recategorise", () => {
	const recategorise = (body: unknown) => ({ method: "POST", path: "/review/recategorise", body });

	it("sets the category and approves in one patch, teaches merchant memory, confirms the merchant", async () => {
		const t = await makeLedgerPlugin();
		const key = merchantKey(row(t, "t-01"))!;
		const res = await send(t, crypto, recategorise({ ids: ["t-01", "t-02", "t-08"], categoryId: "cat-food-super" }));
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ applied: 3, changed: 3, failed: [], written: expect.any(Number) });
		for (const id of ["t-01", "t-02", "t-08"]) expect(row(t, id)).toMatchObject({ categoryId: "cat-food-super", review: "approved" });
		// A hand decision replaces the rule's: provenance comes off with it.
		expect(row(t, "t-08").categoryRuleId).toBeUndefined();
		expect(t.store.merchants[key]).toMatchObject({ categoryId: "cat-food-super", source: "user", reviewedAt: expect.any(String) });
		expect(t.reviewChanges).toHaveLength(1);
		expect(t.refreshes()).toBe(1);
	});

	it("reports unknown ids per ref and recategorises the rest", async () => {
		const t = await makeLedgerPlugin();
		const body = (await send(t, crypto, recategorise({ ids: ["t-09", "gone"], categoryId: "cat-fun" }))).json as Bulk;
		expect(body.applied).toBe(1);
		expect(body.failed).toEqual([{ ref: "gone", error: "Transaction not found" }]);
		expect(row(t, "t-09")).toMatchObject({ categoryId: "cat-fun", review: "approved" });
	});

	it.each([
		[{ ids: ["t-01"] }, "categoryId must be a category id"],
		[{ ids: ["t-01"], categoryId: "cat-nope" }, "Category cat-nope not found"],
		[{ ids: ["t-01"], categoryId: "cat-old" }, "Category cat-old is archived"],
		[{ ids: [], categoryId: "cat-fun" }, "ids must be a non-empty array of transaction ids"],
		[null, "Body must be a JSON object"],
	])("refuses %j with a 400 and writes nothing", async (body, error) => {
		const t = await makeLedgerPlugin();
		const before = snapshot(t.store.transactions);
		const res = await send(t, crypto, recategorise(body));
		expect(res.status).toBe(400);
		expect(res.json).toEqual({ error });
		expect(snapshot(t.store.transactions)).toEqual(before);
		expect(t.store.merchants).toEqual({});
		expect(t.refreshes()).toBe(0);
	});

	it("refuses writes from another device when remote writes are off", async () => {
		const t = await makeLedgerPlugin();
		t.settings.apiBind = "tailscale";
		const res = await send(t, crypto, { ...recategorise({ ids: ["t-01"], categoryId: "cat-fun" }), remoteAddress: "100.100.1.2" });
		expect(res.status).toBe(403);
		expect(row(t, "t-01").categoryId).toBeUndefined();
	});
});
