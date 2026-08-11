import { describe, it, expect, vi } from "vitest";

// shared.ts pulls in ui/dom for its small DOM primitives, which imports Obsidian's runtime. Only the pure
// calculations are under test here, so the module is stubbed rather than the whole app being booted.
vi.mock("obsidian", () => ({ setIcon: () => {} }));

import { committedPayments, incomeStability, projectMonthEnd, rawAccountFlows } from "./shared";
import { windowSummary, type KpiStore } from "../../kpi";
import { recurringSeries, type RecurringSeries } from "../../recurring";
import type { Account, Category, Subscription, Transaction } from "../../types";

// ---------- fixtures ----------

/** 11 Aug 2026, local components — every date below is pinned against it. */
const TODAY = new Date(2026, 7, 11);

const checking: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR", openingBalance: 8000 };
const savings: Account = { id: "acc-savings", name: "Savings", type: "saving", currency: "EUR", openingBalance: 0 };

const catFood: Category = { id: "cat-food", name: "Food", color: "#000", icon: "utensils", aliases: [] };
const catIncome: Category = { id: "cat-income", name: "Income", color: "#000", icon: "coins", aliases: [] };

let nextId = 0;
function tx(partial: Partial<Transaction> & Pick<Transaction, "date" | "amount">): Transaction {
	nextId++;
	return {
		id: `tx-${nextId}`,
		accountId: checking.id,
		description: "test",
		currency: "EUR",
		source: "manual",
		...partial,
	};
}

function store(transactions: Transaction[], overrides: Partial<KpiStore> = {}): KpiStore {
	return { accounts: [checking, savings], categories: [catFood, catIncome], transactions, ...overrides };
}

function sub(partial: Partial<Subscription> = {}): Subscription {
	return {
		id: "sub-1",
		name: "Netflix",
		category: "Streaming",
		cost: 12.99,
		billingCycle: "monthly",
		paidVia: "private",
		nextDueDate: "2026-08-20",
		...partial,
	};
}

/** A hand-built series, so a committedPayments assertion doesn't depend on detection re-deriving one. */
function series(partial: Partial<RecurringSeries> = {}): RecurringSeries {
	return {
		key: "gym",
		displayName: "Gym",
		direction: "debit",
		cycle: "monthly",
		accountId: checking.id,
		medianGapDays: 30,
		gapSpread: 0,
		medianAmount: 40,
		lastAmount: 40,
		firstDate: "2026-05-11",
		lastDate: "2026-07-11",
		expectedNextDate: "2026-08-11",
		occurrences: [],
		distinctMonths: 3,
		...partial,
	};
}

/** A €1,500/month standing order into savings, booked on both sides — the pair detector's bread and butter. */
function standingOrder(dates: string[]): Transaction[] {
	return dates.flatMap((date) => [
		tx({ date, amount: -1500, counterparty: "SPAARREKENING" }),
		tx({ date, amount: 1500, accountId: savings.id, counterparty: "VAN CHECKING" }),
	]);
}

// ---------- projectMonthEnd ----------

describe("projectMonthEnd", () => {
	it("does not subtract a pair-matched standing order from spend it was never in (regression: CRITICAL #1)", () => {
		// `windowSummary` strips transfers including pair-matched ones; `recurringSeries` has no pair
		// detection, so the same standing order was present in `recurringSpend` and absent from `spend`.
		// The subtraction went negative, Math.max(0, …) hid it, and the discretionary rate — the headline
		// forward-looking number — collapsed to €0/day for anyone whose standing order beats their
		// everyday spending.
		const groceries = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"].map((shop, i) =>
			tx({ date: `2026-06-${String(i + 1).padStart(2, "0")}`, amount: -90, counterparty: `SHOP ${shop}`, categoryId: catFood.id })
		);
		const s = store([...standingOrder(["2026-06-01", "2026-07-01", "2026-08-01"]), ...groceries]);
		const detected = recurringSeries(s);
		// The standing order really is detected as a monthly debit series — that is what made this bite.
		expect(detected.some((x) => x.key === "spaarrekening")).toBe(true);

		const projection = projectMonthEnd(s, [], detected, undefined, TODAY);
		expect(projection.dailyDiscretionary).toBeCloseTo(900 / 90, 6);
		expect(projection.discretionary).toBeCloseTo((900 / 90) * projection.remainingDays, 6);
		expect(projection.remainingDays).toBe(20);
	});

	it("still nets a genuine recurring charge out of the discretionary rate", () => {
		// The other half of the contract: a real merchant charge is counted once, in scheduledOut, and must
		// not be counted a second time in the daily rate.
		const gym = ["2026-05-15", "2026-06-15", "2026-07-15"].map((date) => tx({ date, amount: -300, counterparty: "GYM" }));
		const s = store([...gym, tx({ date: "2026-07-20", amount: -90, counterparty: "SHOP A", categoryId: catFood.id })]);
		const detected = recurringSeries(s);
		const projection = projectMonthEnd(s, [], detected, undefined, TODAY);
		// 600 of gym charges fall inside the 90-day window, plus the €90 shop — only the shop is discretionary.
		expect(projection.dailyDiscretionary).toBeCloseTo(90 / 90, 6);
	});
});

// ---------- committedPayments ----------

describe("committedPayments", () => {
	it("keeps a recurring debit due today, exactly as it keeps a subscription due today (review MINOR #12)", () => {
		const dueToday = series({ expectedNextDate: "2026-08-11" });
		const subDueToday = sub({ nextDueDate: "2026-08-11", accountId: checking.id });
		const out = committedPayments([subDueToday], [dueToday], "2026-08-31", undefined, TODAY);
		expect(out.map((c) => c.source).sort()).toEqual(["recurring", "subscription"]);
		expect(out.every((c) => c.date === "2026-08-11")).toBe(true);
	});

	it("drops what is already in the past on both branches", () => {
		const yesterday = series({ expectedNextDate: "2026-08-10" });
		const subYesterday = sub({ nextDueDate: "2026-08-10", endDate: "2026-08-10", accountId: checking.id });
		expect(committedPayments([subYesterday], [yesterday], "2026-08-31", undefined, TODAY)).toEqual([]);
	});

	it("stops at the `until` bound", () => {
		const nextMonth = series({ expectedNextDate: "2026-09-01" });
		expect(committedPayments([], [nextMonth], "2026-08-31", undefined, TODAY)).toEqual([]);
	});
});

// ---------- incomeStability ----------

describe("incomeStability", () => {
	it("averages over the months that had income, not over a window padded with zeros (regression: MAJOR #5)", () => {
		// Six months of a salary paid to the cent used to read "€1,500/mo on average, ±100% month to
		// month" — the six empty months before the ledger started halved the mean and invented the spread.
		const salary = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"].map((month) =>
			tx({ date: `${month}-25`, amount: 3000, categoryId: catIncome.id })
		);
		const stability = incomeStability(store(salary), undefined, TODAY);
		expect(stability).toBeDefined();
		expect(stability!.mean).toBeCloseTo(3000, 6);
		expect(stability!.cv).toBeCloseTo(0, 6);
		expect(stability!.label).toBe("Steady");
	});

	it("still calls a genuinely lumpy income irregular", () => {
		const amounts = [500, 6000, 800, 5200, 400, 7000];
		const lumpy = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"].map((month, i) =>
			tx({ date: `${month}-25`, amount: amounts[i], categoryId: catIncome.id })
		);
		expect(incomeStability(store(lumpy), undefined, TODAY)!.label).toBe("Irregular");
	});

	it("stays undefined below six months of income", () => {
		const salary = ["2026-05", "2026-06", "2026-07"].map((month) => tx({ date: `${month}-25`, amount: 3000, categoryId: catIncome.id }));
		expect(incomeStability(store(salary), undefined, TODAY)).toBeUndefined();
	});
});

// ---------- rawAccountFlows ----------

describe("rawAccountFlows", () => {
	const window = { from: "2025-08-01", to: "2026-07-31" };

	it("reports the contributions windowSummary is right to hide (regression: MAJOR #4 root)", () => {
		const s = store([
			...standingOrder(["2025-09-01", "2025-10-01", "2025-11-01"]),
			tx({ date: "2026-01-05", amount: 40, accountId: savings.id, type: "Interest" }),
			tx({ date: "2026-02-10", amount: -1000, accountId: savings.id, counterparty: "NAAR CHECKING", type: "Withdrawal" }),
		]);

		// windowSummary is *correct* to see almost nothing here: every contribution is a pair-matched
		// transfer and the withdrawal carries a marker, so all it can report is the interest. A savings
		// page built on it therefore reads "€0 contributed" for someone saving €1,500 a month.
		expect(windowSummary(s, window.from, window.to, [savings.id])).toMatchObject({ income: 40, expenses: 0, txCount: 1 });

		const flows = rawAccountFlows(s, savings.id, window);
		expect(flows.inflow).toBeCloseTo(4540, 6);
		expect(flows.outflow).toBeCloseTo(1000, 6);
		expect(flows.interest).toBeCloseTo(40, 6);
		expect(flows.net).toBeCloseTo(3540, 6);
		// What the goal card actually wants: money you put in under your own steam.
		expect(flows.inflow - flows.interest).toBeCloseTo(4500, 6);
	});

	it("scopes to the account and to the window", () => {
		const s = store([
			...standingOrder(["2026-07-01"]),
			tx({ date: "2026-08-01", amount: 999, accountId: savings.id }), // outside the window
		]);
		expect(rawAccountFlows(s, savings.id, window)).toEqual({ inflow: 1500, outflow: 0, interest: 0, net: 1500 });
		expect(rawAccountFlows(s, checking.id, window)).toEqual({ inflow: 0, outflow: 1500, interest: 0, net: -1500 });
	});

	it("returns zeros for an account with nothing in the window", () => {
		expect(rawAccountFlows(store([]), savings.id, window)).toEqual({ inflow: 0, outflow: 0, interest: 0, net: 0 });
	});
});
