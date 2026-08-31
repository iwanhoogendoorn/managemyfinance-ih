import { describe, expect, it } from "vitest";
import { accountReviewProgress, reviewCounts } from "./review";
import type { Account, Transaction } from "./types";

let n = 0;
function tx(overrides: Partial<Transaction> = {}): Transaction {
	n++;
	return {
		id: `t-${n}`,
		date: "2026-01-01",
		accountId: "acc-a",
		description: "Shop",
		amount: -10,
		currency: "EUR",
		source: "manual",
		...overrides,
	};
}
function acc(id: string, name = id): Account {
	return { id, name, type: "debit", currency: "EUR" };
}

describe("reviewCounts", () => {
	it("treats an absent review state as still to review", () => {
		// That's the implicit state of everything an import brings in.
		expect(reviewCounts([tx()]).toReview).toBe(1);
	});

	it("separates the three states", () => {
		const c = reviewCounts([tx(), tx({ review: "approved" }), tx({ review: "flagged" })]);
		expect(c).toMatchObject({ total: 3, toReview: 1, approved: 1, flagged: 1 });
	});

	it("counts uncategorized regardless of review state", () => {
		// A row can be approved and still have no category; the Review page shows both.
		const c = reviewCounts([tx({ review: "approved" }), tx({ review: "approved", categoryId: "cat-food" })]);
		expect(c.approved).toBe(2);
		expect(c.uncategorized).toBe(1);
	});

	it("is all zeroes for nothing", () => {
		expect(reviewCounts([])).toEqual({ total: 0, toReview: 0, approved: 0, flagged: 0, uncategorized: 0 });
	});
});

describe("accountReviewProgress", () => {
	it("counts each account separately", () => {
		// The bug this exists for: one fully-approved account made a freshly imported one look done.
		const rows = [
			tx({ accountId: "acc-a", review: "approved" }),
			tx({ accountId: "acc-a", review: "approved" }),
			tx({ accountId: "acc-b" }),
		];
		const progress = accountReviewProgress(rows, [acc("acc-a"), acc("acc-b")]);
		const byId = Object.fromEntries(progress.map((p) => [p.account.id, p.counts]));
		expect(byId["acc-a"]).toMatchObject({ approved: 2, toReview: 0 });
		expect(byId["acc-b"]).toMatchObject({ approved: 0, toReview: 1 });
	});

	it("puts the account with outstanding work first", () => {
		const rows = [tx({ accountId: "acc-a", review: "approved" }), tx({ accountId: "acc-b" })];
		expect(accountReviewProgress(rows, [acc("acc-a"), acc("acc-b")])[0].account.id).toBe("acc-b");
	});

	it("counts a flagged row as outstanding, since it is parked rather than done", () => {
		const rows = [tx({ accountId: "acc-a", review: "approved" }), tx({ accountId: "acc-b", review: "flagged" })];
		expect(accountReviewProgress(rows, [acc("acc-a"), acc("acc-b")])[0].account.id).toBe("acc-b");
	});

	it("breaks a tie on uncategorized rows", () => {
		const rows = [
			tx({ accountId: "acc-a", review: "approved", categoryId: "cat-food" }),
			tx({ accountId: "acc-b", review: "approved" }),
		];
		expect(accountReviewProgress(rows, [acc("acc-a"), acc("acc-b")])[0].account.id).toBe("acc-b");
	});

	it("includes an account with nothing in it, at the bottom", () => {
		const progress = accountReviewProgress([tx({ accountId: "acc-a" })], [acc("acc-empty"), acc("acc-a")]);
		expect(progress.map((p) => p.account.id)).toEqual(["acc-a", "acc-empty"]);
		expect(progress[1].counts.total).toBe(0);
	});

	it("ignores rows whose account is not in the list", () => {
		const progress = accountReviewProgress([tx({ accountId: "acc-gone" })], [acc("acc-a")]);
		expect(progress).toHaveLength(1);
		expect(progress[0].counts.total).toBe(0);
	});
});
