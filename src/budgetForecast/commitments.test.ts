import { describe, it, expect } from "vitest";
import { detectForecastCommitments, knownRecurringShare, recurringAttributedMonthlySpend } from "./commitments";
import type { CategoryPeriodSpend, ForecastStore } from "./types";
import type { Account, Category, Subscription, Transaction } from "../types";

const CHECKING: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR" };
const ENTERTAINMENT = "cat-entertainment";
const FOOD = "cat-food";

let nextId = 0;
function tx(date: string, amount: number, categoryId: string | undefined, extra: Partial<Transaction> = {}): Transaction {
	nextId++;
	return {
		id: `tx-${nextId}`,
		date,
		accountId: CHECKING.id,
		description: extra.counterparty ?? "test",
		amount,
		currency: "EUR",
		categoryId,
		source: "manual",
		...extra,
	};
}

function cat(overrides: Partial<Category> & { id: string }): Category {
	return { name: overrides.id, color: "#000", icon: "tag", aliases: [], ...overrides };
}

const CATEGORIES: Category[] = [cat({ id: ENTERTAINMENT, name: "Entertainment" }), cat({ id: FOOD, name: "Food" })];

function sub(over: Partial<Subscription> & { id: string; name: string; cost: number; billingCycle: Subscription["billingCycle"]; nextDueDate: string }): Subscription {
	return { category: "Streaming", currency: "EUR", paidVia: "private", archived: false, ...over };
}

function store(transactions: Transaction[], subscriptions: Subscription[] = [], over: Partial<ForecastStore> = {}): ForecastStore {
	return { accounts: [CHECKING], categories: CATEGORIES, transactions, subscriptions, ...over };
}

describe("detectForecastCommitments — subscriptions", () => {
	it("projects an active, category-linked subscription's next due date into the target range", () => {
		const netflix = sub({ id: "sub-netflix", name: "Netflix", cost: 15, billingCycle: "monthly", nextDueDate: "2026-09-05" });
		const s = store([tx("2026-08-05", -15, ENTERTAINMENT, { subscriptionId: "sub-netflix" })], [netflix]);

		expect(detectForecastCommitments(s, ENTERTAINMENT, { from: "2026-09-01", to: "2026-09-30" })).toEqual([
			{ id: "sub:sub-netflix:2026-09-05", categoryId: ENTERTAINMENT, expectedDate: "2026-09-05", amount: 15, source: "subscription", confidence: "high" },
		]);
	});

	it("rolls a stale anchor date forward by whole cycles to find the occurrence inside the target", () => {
		const netflix = sub({ id: "sub-netflix", name: "Netflix", cost: 15, billingCycle: "monthly", nextDueDate: "2026-01-05" });
		const s = store([tx("2026-01-05", -15, ENTERTAINMENT, { subscriptionId: "sub-netflix" })], [netflix]);

		const result = detectForecastCommitments(s, ENTERTAINMENT, { from: "2026-09-01", to: "2026-09-30" });
		expect(result).toHaveLength(1);
		expect(result[0].expectedDate).toBe("2026-09-05");
	});

	it("produces nothing when the due date falls outside the target range", () => {
		const netflix = sub({ id: "sub-netflix", name: "Netflix", cost: 15, billingCycle: "monthly", nextDueDate: "2026-10-05" });
		const s = store([tx("2026-09-05", -15, ENTERTAINMENT, { subscriptionId: "sub-netflix" })], [netflix]);
		expect(detectForecastCommitments(s, ENTERTAINMENT, { from: "2026-09-01", to: "2026-09-30" })).toEqual([]);
	});

	it("ignores an archived subscription", () => {
		const netflix = sub({ id: "sub-netflix", name: "Netflix", cost: 15, billingCycle: "monthly", nextDueDate: "2026-09-05", archived: true });
		const s = store([tx("2026-08-05", -15, ENTERTAINMENT, { subscriptionId: "sub-netflix" })], [netflix]);
		expect(detectForecastCommitments(s, ENTERTAINMENT, { from: "2026-09-01", to: "2026-09-30" })).toEqual([]);
	});

	it("skips an occurrence past the subscription's own end date", () => {
		const netflix = sub({ id: "sub-netflix", name: "Netflix", cost: 15, billingCycle: "monthly", nextDueDate: "2026-09-05", endDate: "2026-09-01" });
		const s = store([tx("2026-08-05", -15, ENTERTAINMENT, { subscriptionId: "sub-netflix" })], [netflix]);
		expect(detectForecastCommitments(s, ENTERTAINMENT, { from: "2026-09-01", to: "2026-09-30" })).toEqual([]);
	});

	it("never attributes a subscription to a category none of its linked payments were filed under", () => {
		const netflix = sub({ id: "sub-netflix", name: "Netflix", cost: 15, billingCycle: "monthly", nextDueDate: "2026-09-05" });
		const s = store([tx("2026-08-05", -15, FOOD, { subscriptionId: "sub-netflix" })], [netflix]);
		expect(detectForecastCommitments(s, ENTERTAINMENT, { from: "2026-09-01", to: "2026-09-30" })).toEqual([]);
	});

	it("selects every occurrence inside a target wider than the billing cycle", () => {
		const gym = sub({ id: "sub-gym", name: "Gym", cost: 20, billingCycle: "weekly", nextDueDate: "2026-09-07" });
		const s = store([tx("2026-08-31", -20, ENTERTAINMENT, { subscriptionId: "sub-gym" })], [gym]);

		const result = detectForecastCommitments(s, ENTERTAINMENT, { from: "2026-09-01", to: "2026-09-30" });
		expect(result.map((c) => c.expectedDate)).toEqual(["2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28"]);
	});

	it("converts a foreign-currency subscription's cost at the current rate", () => {
		const netflix = sub({ id: "sub-netflix", name: "Netflix", cost: 10, currency: "USD", billingCycle: "monthly", nextDueDate: "2026-09-05" });
		const s = store([tx("2026-08-05", -10, ENTERTAINMENT, { subscriptionId: "sub-netflix", currency: "USD" })], [netflix], {
			fx: { baseCurrency: "EUR", rates: { USD: 0.9 } },
		});

		const result = detectForecastCommitments(s, ENTERTAINMENT, { from: "2026-09-01", to: "2026-09-30" });
		expect(result[0].amount).toBeCloseTo(9, 5);
	});

	it("returns nothing for an open-ended target range", () => {
		const netflix = sub({ id: "sub-netflix", name: "Netflix", cost: 15, billingCycle: "monthly", nextDueDate: "2026-09-05" });
		const s = store([tx("2026-08-05", -15, ENTERTAINMENT, { subscriptionId: "sub-netflix" })], [netflix]);
		expect(detectForecastCommitments(s, ENTERTAINMENT, { from: "2026-09-01", to: "" })).toEqual([]);
	});
});

describe("detectForecastCommitments — recurring series", () => {
	function gymTx(date: string): Transaction {
		return tx(date, -45, ENTERTAINMENT, { counterparty: "Fitness Studio" });
	}

	it("projects a stable, unlinked recurring merchant forward with moderate confidence", () => {
		const s = store([gymTx("2026-06-10"), gymTx("2026-07-10"), gymTx("2026-08-10")]);

		const result = detectForecastCommitments(s, ENTERTAINMENT, { from: "2026-09-01", to: "2026-09-30" });
		expect(result).toEqual([
			{ id: "series:fitness studio:2026-09-10", categoryId: ENTERTAINMENT, expectedDate: "2026-09-10", amount: 45, source: "recurring-series", confidence: "moderate" },
		]);
	});

	it("does not attribute a series to a category most of its own transactions weren't filed under", () => {
		const wrongCategory = [tx("2026-06-10", -45, FOOD, { counterparty: "Fitness Studio" }), tx("2026-07-10", -45, FOOD, { counterparty: "Fitness Studio" }), tx("2026-08-10", -45, FOOD, { counterparty: "Fitness Studio" })];
		const s = store(wrongCategory);
		expect(detectForecastCommitments(s, ENTERTAINMENT, { from: "2026-09-01", to: "2026-09-30" })).toEqual([]);
	});

	it("counts a merchant once when it is both an explicit subscription and a detectable series", () => {
		const netflix = sub({ id: "sub-netflix", name: "Netflix", cost: 15, billingCycle: "monthly", nextDueDate: "2026-09-05" });
		const s = store(
			[
				tx("2026-06-05", -15, ENTERTAINMENT, { counterparty: "Netflix", subscriptionId: "sub-netflix" }),
				tx("2026-07-05", -15, ENTERTAINMENT, { counterparty: "Netflix", subscriptionId: "sub-netflix" }),
				tx("2026-08-05", -15, ENTERTAINMENT, { counterparty: "Netflix", subscriptionId: "sub-netflix" }),
			],
			[netflix]
		);

		const result = detectForecastCommitments(s, ENTERTAINMENT, { from: "2026-09-01", to: "2026-09-30" });
		expect(result).toHaveLength(1);
		expect(result[0].source).toBe("subscription");
	});
});

describe("recurringAttributedMonthlySpend", () => {
	it("sums a linked subscription's own historical payments, per month", () => {
		const netflix = sub({ id: "sub-netflix", name: "Netflix", cost: 15, billingCycle: "monthly", nextDueDate: "2026-09-05" });
		const s = store(
			[
				tx("2026-06-05", -15, ENTERTAINMENT, { subscriptionId: "sub-netflix" }),
				tx("2026-07-05", -15, ENTERTAINMENT, { subscriptionId: "sub-netflix" }),
			],
			[netflix]
		);
		expect(recurringAttributedMonthlySpend(s, ENTERTAINMENT)).toEqual(
			new Map([
				["2026-06", 15],
				["2026-07", 15],
			])
		);
	});

	it("sums a stable unlinked series' own historical occurrences, per month", () => {
		const s = store([
			tx("2026-06-10", -45, ENTERTAINMENT, { counterparty: "Fitness Studio" }),
			tx("2026-07-10", -45, ENTERTAINMENT, { counterparty: "Fitness Studio" }),
			tx("2026-08-10", -45, ENTERTAINMENT, { counterparty: "Fitness Studio" }),
		]);
		expect(recurringAttributedMonthlySpend(s, ENTERTAINMENT)).toEqual(
			new Map([
				["2026-06", 45],
				["2026-07", 45],
				["2026-08", 45],
			])
		);
	});

	it("attributes nothing to a category with no identified recurring source at all", () => {
		const s = store([tx("2026-06-10", -12, ENTERTAINMENT, { counterparty: "Cinema" })]);
		expect(recurringAttributedMonthlySpend(s, ENTERTAINMENT)).toEqual(new Map());
	});
});

describe("knownRecurringShare", () => {
	function spend(key: string, economicExpense: number): CategoryPeriodSpend {
		return { key, from: "", to: "", economicExpense, transactionCount: 1 };
	}

	it("is the recurring-attributed share of total spend, over exactly history's own months", () => {
		const history = [spend("2026-06", 100), spend("2026-07", 100)];
		const attributed = new Map([
			["2026-06", 15],
			["2026-07", 15],
			// A month outside `history`'s own window must never leak into the denominator or numerator.
			["2026-08", 500],
		]);
		expect(knownRecurringShare(history, attributed)).toBeCloseTo(0.15, 5);
	});

	it("is 0 when there's no economic spend at all to divide by", () => {
		expect(knownRecurringShare([spend("2026-06", 0)], new Map([["2026-06", 5]]))).toBe(0);
	});

	it("never exceeds 1, even if a month's attributed raw amount outweighs its net economic expense", () => {
		const history = [spend("2026-06", 10)];
		const attributed = new Map([["2026-06", 50]]);
		expect(knownRecurringShare(history, attributed)).toBe(1);
	});
});
