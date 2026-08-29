import { describe, expect, it } from "vitest";
import { adaptiveSignalsFor, chooseAdaptiveMethod, type AdaptiveSignals } from "./adaptiveHybrid";
import type { ForecastStore } from "../types";
import type { Account, Category, Subscription, Transaction } from "../../types";

function signals(over: Partial<AdaptiveSignals>): AdaptiveSignals {
	return { knownRecurringShare: 0, sparseMonthRatio: 0, seasonality: "unknown", usableSeasonalYears: 0, residualVolatility: 0, ...over };
}

describe("chooseAdaptiveMethod (§35's decision tree)", () => {
	it("picks fixed-commitment when almost everything is recurring and the residual is stable", () => {
		expect(chooseAdaptiveMethod(signals({ knownRecurringShare: 0.9, residualVolatility: 0.05 }))).toBe("fixed-commitment");
	});

	it("does not pick fixed-commitment when the recurring share is high but the residual is still volatile", () => {
		expect(chooseAdaptiveMethod(signals({ knownRecurringShare: 0.9, residualVolatility: 0.6 }))).not.toBe("fixed-commitment");
	});

	it("picks sinking-fund once half the tracked months are exactly zero", () => {
		expect(chooseAdaptiveMethod(signals({ sparseMonthRatio: 0.5 }))).toBe("sinking-fund");
	});

	it("picks recurring-plus-variable for a meaningful but not overwhelming recurring share", () => {
		expect(chooseAdaptiveMethod(signals({ knownRecurringShare: 0.3 }))).toBe("recurring-plus-variable");
	});

	it("falls back to seasonal-quantile for a purely variable category with no other signal", () => {
		expect(chooseAdaptiveMethod(signals({}))).toBe("seasonal-quantile");
	});

	it("checks fixed-commitment before sinking-fund — a stable subscription-only category isn't sparse just because it's small", () => {
		expect(chooseAdaptiveMethod(signals({ knownRecurringShare: 0.9, residualVolatility: 0.05, sparseMonthRatio: 0.6 }))).toBe("fixed-commitment");
	});
});

const CHECKING: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR" };
const AUTO = "cat-auto";

const CATEGORIES: Category[] = [{ id: AUTO, name: "Auto & Transport", color: "#000", icon: "tag", aliases: [] }];

let nextId = 0;
function tx(date: string, amount: number, categoryId: string, counterparty: string, extra: Partial<Transaction> = {}): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, date, accountId: CHECKING.id, description: counterparty, counterparty, amount, currency: "EUR", categoryId, source: "manual", ...extra };
}

describe("adaptiveSignalsFor", () => {
	it("reads a high recurring share off a linked subscription that dominates the category", () => {
		const insurance: Subscription = { id: "sub-ins", name: "Car Insurer", category: "Other", cost: 100, currency: "EUR", billingCycle: "monthly", paidVia: "private", archived: false, nextDueDate: "2025-01-05" };
		const transactions: Transaction[] = [];
		for (let month = 1; month <= 12; month++) {
			transactions.push(tx(`2024-${String(month).padStart(2, "0")}-05`, -100, AUTO, "Car Insurer", { subscriptionId: "sub-ins" }));
		}
		const store: ForecastStore = { accounts: [CHECKING], categories: CATEGORIES, transactions, subscriptions: [insurance] };

		const result = adaptiveSignalsFor(store, AUTO, "leaf");
		expect(result.knownRecurringShare).toBeCloseTo(1, 5);
		expect(result.residualVolatility).toBe(0);
	});

	it("reads high sparsity off a category with mostly untracked-zero months", () => {
		// Two real charges; the filler category spreads real tracked months across a much longer window
		// than Auto & Transport itself has any activity in.
		const transactions: Transaction[] = [tx("2024-03-10", -50, AUTO, "Garage"), tx("2024-09-10", -60, AUTO, "Garage")];
		for (let month = 1; month <= 12; month++) {
			transactions.push(tx(`2024-${String(month).padStart(2, "0")}-20`, -5, "cat-filler", "Grocery Store"));
		}
		const store: ForecastStore = {
			accounts: [CHECKING],
			categories: [...CATEGORIES, { id: "cat-filler", name: "Filler", color: "#000", icon: "tag", aliases: [] }],
			transactions,
		};

		const result = adaptiveSignalsFor(store, AUTO, "leaf");
		expect(result.sparseMonthRatio).toBeGreaterThanOrEqual(0.5);
		expect(result.knownRecurringShare).toBe(0);
	});
});
