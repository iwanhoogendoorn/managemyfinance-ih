import { describe, it, expect } from "vitest";
import { suggestedBudget, budgetStatuses, budgetSummary, currentMonth, elapsedFraction } from "./budgets";
import type { KpiStore } from "./kpi";
import type { Transaction } from "./types";

const ACCOUNT_ID = "acc-checking";
const CAT_FOOD = "cat-food";

let nextId = 0;
function tx(date: string, amount: number, categoryId = CAT_FOOD): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, date, accountId: ACCOUNT_ID, amount, currency: "EUR", categoryId, description: "test", source: "manual" };
}

function store(transactions: Transaction[]): KpiStore {
	return {
		accounts: [{ id: ACCOUNT_ID, name: "Checking", type: "debit", currency: "EUR" }],
		categories: [{ id: CAT_FOOD, name: "Food", color: "#000", icon: "utensils", aliases: [] }],
		transactions,
	};
}

describe("currentMonth", () => {
	it("returns a YYYY-MM string", () => {
		expect(currentMonth()).toMatch(/^\d{4}-\d{2}$/);
	});
});

describe("suggestedBudget", () => {
	it("averages the last 3 months' spend and rounds to the nearest €5", () => {
		const s = store([
			tx("2024-03-05", -100),
			tx("2024-04-05", -120),
			tx("2024-05-05", -95),
		]);
		// avg = (100+120+95)/3 = 105 -> already a multiple of 5
		expect(suggestedBudget(s, CAT_FOOD, "2024-06")).toBe(105);
	});

	it("rounds a non-multiple-of-5 average to the nearest 5", () => {
		const s = store([tx("2024-05-05", -101), tx("2024-04-05", -101), tx("2024-03-05", -101)]);
		expect(suggestedBudget(s, CAT_FOOD, "2024-06")).toBe(100); // 101 rounds down to 100
	});

	it("returns undefined when there's no transaction history at all", () => {
		expect(suggestedBudget(store([]), CAT_FOOD, "2024-06")).toBeUndefined();
	});

	it("does not count months before the user's earliest transaction as zero-spend", () => {
		// Only one month of history exists; a naive 3-month average would wrongly divide by 3.
		const s = store([tx("2024-05-05", -300)]);
		expect(suggestedBudget(s, CAT_FOOD, "2024-06")).toBe(300);
	});

	it("returns undefined when average spend is zero or negative (nothing to suggest)", () => {
		const s = store([tx("2024-05-05", 50)]); // positive amount, not an expense
		expect(suggestedBudget(s, CAT_FOOD, "2024-06")).toBeUndefined();
	});

	it("only considers the given category", () => {
		const s = store([tx("2024-05-05", -100, "cat-other")]);
		expect(suggestedBudget(s, CAT_FOOD, "2024-06")).toBeUndefined();
	});
});

describe("budgetStatuses", () => {
	it("computes spent/remaining/pct/tone for budgeted categories only", () => {
		const s = store([tx("2024-06-05", -40), tx("2024-06-10", -20)]);
		const categories = [{ id: CAT_FOOD, budget: 100 }, { id: "cat-unbudgeted", budget: undefined }];
		const statuses = budgetStatuses(s, categories, "2024-06");
		expect(statuses).toHaveLength(1);
		expect(statuses[0]).toMatchObject({ categoryId: CAT_FOOD, budget: 100, spent: 60, remaining: 40, tone: "good" });
	});

	it("flags warn at 80%+ and bad at 100%+ of budget", () => {
		const warnStore = store([tx("2024-06-05", -85)]);
		expect(budgetStatuses(warnStore, [{ id: CAT_FOOD, budget: 100 }], "2024-06")[0].tone).toBe("warn");

		const badStore = store([tx("2024-06-05", -120)]);
		const bad = budgetStatuses(badStore, [{ id: CAT_FOOD, budget: 100 }], "2024-06")[0];
		expect(bad.tone).toBe("bad");
		expect(bad.remaining).toBe(-20);
	});

	it("scopes spend to the given month only", () => {
		const s = store([tx("2024-05-05", -999), tx("2024-06-05", -10)]);
		const [status] = budgetStatuses(s, [{ id: CAT_FOOD, budget: 100 }], "2024-06");
		expect(status.spent).toBe(10);
	});
});

describe("elapsedFraction", () => {
	it("reports a completed month as fully elapsed", () => {
		expect(elapsedFraction("2024-05", new Date(2024, 5, 10))).toBe(1);
	});

	it("reports a future month as not started", () => {
		expect(elapsedFraction("2024-07", new Date(2024, 5, 10))).toBe(0);
	});

	it("reports day-of-month over days-in-month for the live month", () => {
		expect(elapsedFraction("2024-06", new Date(2024, 5, 15))).toBeCloseTo(15 / 30, 10);
		expect(elapsedFraction("2024-02", new Date(2024, 1, 10))).toBeCloseTo(10 / 29, 10); // leap year
	});

	it("is never zero on the 1st, so a pace ratio stays finite", () => {
		expect(elapsedFraction("2024-06", new Date(2024, 5, 1))).toBeCloseTo(1 / 30, 10);
	});
});

describe("budgetStatuses pacing", () => {
	it("warns on the 3rd about a budget spent at double the sustainable rate (regression: no pacing)", () => {
		// €20 of a €100 budget on the 3rd of a 30-day month scored "good" before pacing — but that pace
		// finishes the month at €200.
		const s = store([tx("2024-06-01", -20)]);
		const [status] = budgetStatuses(s, [{ id: CAT_FOOD, budget: 100 }], "2024-06", new Date(2024, 5, 3));
		expect(status.pct).toBeCloseTo(0.2, 10);
		expect(status.pace).toBeCloseTo(2, 10);
		expect(status.projected).toBeCloseTo(200, 10);
		expect(status.tone).toBe("warn");
	});

	it("leaves a genuinely on-track category alone", () => {
		const s = store([tx("2024-06-01", -10)]);
		const [status] = budgetStatuses(s, [{ id: CAT_FOOD, budget: 100 }], "2024-06", new Date(2024, 5, 15));
		expect(status.pace).toBeCloseTo(0.2, 10);
		expect(status.tone).toBe("good");
	});

	it("reserves 'bad' for actually being over, not merely projected over", () => {
		const projected = store([tx("2024-06-01", -90)]);
		expect(budgetStatuses(projected, [{ id: CAT_FOOD, budget: 100 }], "2024-06", new Date(2024, 5, 15))[0].tone).toBe("warn");

		const over = store([tx("2024-06-01", -120)]);
		expect(budgetStatuses(over, [{ id: CAT_FOOD, budget: 100 }], "2024-06", new Date(2024, 5, 15))[0].tone).toBe("bad");
	});

	it("collapses to the original absolute thresholds for a completed month", () => {
		const s = store([tx("2024-06-05", -85)]);
		const [status] = budgetStatuses(s, [{ id: CAT_FOOD, budget: 100 }], "2024-06", new Date(2024, 6, 20));
		expect(status.elapsed).toBe(1);
		expect(status.pace).toBe(status.pct);
		expect(status.tone).toBe("warn");
	});
});

describe("budgetSummary", () => {
	const CAT_FUN = "cat-fun";

	function multiStore(transactions: ReturnType<typeof tx>[]) {
		const s = store(transactions);
		s.categories = [
			{ id: CAT_FOOD, name: "Food", color: "#000", icon: "utensils", aliases: [] },
			{ id: CAT_FUN, name: "Fun", color: "#000", icon: "party", aliases: [] },
		];
		return s;
	}

	it("scores the month on overall pace, not raw spend", () => {
		// Half of a €600 total spent halfway through a 30-day month is exactly on pace — even though a
		// raw "50% of budget used" reading says nothing about whether that's early or late.
		const s = multiStore([tx("2024-06-05", -150), tx("2024-06-06", -150, CAT_FUN)]);
		const summary = budgetSummary(s, [{ id: CAT_FOOD, budget: 300 }, { id: CAT_FUN, budget: 300 }], "2024-06", new Date(2024, 5, 15));
		expect(summary.totalBudget).toBe(600);
		expect(summary.totalSpent).toBe(300);
		expect(summary.pace).toBeCloseTo(1, 10);

		// Same spend a fortnight later is only half the pace.
		const later = budgetSummary(s, [{ id: CAT_FOOD, budget: 300 }, { id: CAT_FUN, budget: 300 }], "2024-06", new Date(2024, 5, 30));
		expect(later.pace).toBeCloseTo(0.5, 10);
	});

	it("separates categories already over from those merely on pace to go over", () => {
		const s = multiStore([tx("2024-06-05", -400), tx("2024-06-06", -200, CAT_FUN)]);
		const summary = budgetSummary(s, [{ id: CAT_FOOD, budget: 300 }, { id: CAT_FUN, budget: 300 }], "2024-06", new Date(2024, 5, 15));
		expect(summary.overCount).toBe(1); // Food, at 400/300
		expect(summary.projectedOverCount).toBe(1); // Fun, at 200/300 halfway through
	});

	it("surfaces spend leaving through categories with no limit set", () => {
		const s = multiStore([tx("2024-06-05", -100), tx("2024-06-06", -250, CAT_FUN)]);
		const summary = budgetSummary(s, [{ id: CAT_FOOD, budget: 300 }], "2024-06", new Date(2024, 5, 15));
		expect(summary.totalSpent).toBe(100);
		expect(summary.unbudgetedSpend).toBe(250);
	});

	it("stays at zero pace when nothing is budgeted at all", () => {
		const s = multiStore([tx("2024-06-05", -100)]);
		const summary = budgetSummary(s, [], "2024-06", new Date(2024, 5, 15));
		expect(summary.pace).toBe(0);
		expect(summary.unbudgetedSpend).toBe(100);
	});
});

describe("budgets with subcategories", () => {
	const CAT_GROCERIES = "cat-groceries";
	const CAT_RESTAURANTS = "cat-restaurants";

	/** Food, with two subcategories under it. */
	function nestedStore(transactions: Transaction[]): KpiStore {
		return {
			accounts: [{ id: ACCOUNT_ID, name: "Checking", type: "debit", currency: "EUR" }],
			categories: [
				{ id: CAT_FOOD, name: "Food", color: "#000", icon: "utensils", aliases: [] },
				{ id: CAT_GROCERIES, name: "Groceries", color: "#000", icon: "cart", aliases: [], parentId: CAT_FOOD },
				{ id: CAT_RESTAURANTS, name: "Restaurants", color: "#000", icon: "utensils", aliases: [], parentId: CAT_FOOD },
			],
			transactions,
		};
	}

	it("counts subcategory spend against the parent's budget", () => {
		// The trap this pins: set a €700 Food budget, then file everything under Food › Groceries, and
		// a non-rolling-up implementation reports €0 spent forever while you sail past the limit.
		const s = nestedStore([
			tx("2026-03-04", -200, CAT_GROCERIES),
			tx("2026-03-11", -150, CAT_RESTAURANTS),
			tx("2026-03-18", -50, CAT_FOOD),
		]);
		const [status] = budgetStatuses(s, [{ id: CAT_FOOD, budget: 700 }], "2026-03", new Date("2026-03-31T12:00:00"));
		expect(status.spent).toBe(400);
		expect(status.pct).toBeCloseTo(400 / 700, 6);
	});

	it("still measures a subcategory's own budget against only its own spend", () => {
		const s = nestedStore([
			tx("2026-03-04", -200, CAT_GROCERIES),
			tx("2026-03-11", -150, CAT_RESTAURANTS),
		]);
		const [status] = budgetStatuses(s, [{ id: CAT_GROCERIES, budget: 300 }], "2026-03", new Date("2026-03-31T12:00:00"));
		expect(status.spent).toBe(200);
	});

	it("suggests a parent budget from the whole family's history, matching what it'll be measured against", () => {
		const s = nestedStore([
			tx("2026-01-10", -100, CAT_GROCERIES),
			tx("2026-01-20", -100, CAT_RESTAURANTS),
			tx("2026-02-10", -100, CAT_GROCERIES),
			tx("2026-02-20", -100, CAT_RESTAURANTS),
		]);
		// Two complete months at €200 each → €200, rounded to the nearest €5.
		expect(suggestedBudget(s, CAT_FOOD, "2026-03", 3)).toBe(200);
	});
});
