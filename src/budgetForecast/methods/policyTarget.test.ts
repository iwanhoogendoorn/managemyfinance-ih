import { describe, expect, it } from "vitest";
import { forecastPolicyTarget } from "./policyTarget";
import type { ForecastStore } from "../types";
import type { Account, Category, Transaction } from "../../types";

const CHECKING: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR" };
const CHARITY = "cat-charity";
const CATEGORIES: Category[] = [{ id: CHARITY, name: "Charity", color: "#000", icon: "tag", aliases: [] }];

let nextId = 0;
function tx(date: string, amount: number, categoryId: string, counterparty: string): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, date, accountId: CHECKING.id, description: counterparty, counterparty, amount, currency: "EUR", categoryId, source: "manual" };
}

function store(transactions: Transaction[]): ForecastStore {
	return { accounts: [CHECKING], categories: CATEGORIES, transactions };
}

const TARGET = { from: "2025-01-01", to: "2025-01-31", label: "January 2025" };

describe("forecastPolicyTarget — Charity", () => {
	it("never pre-selects a recommended scenario — history is context, not a recommendation (§38)", () => {
		const transactions = Array.from({ length: 12 }, (_, i) => tx(`2024-${String(i + 1).padStart(2, "0")}-10`, -50, CHARITY, "Red Cross"));
		const result = forecastPolicyTarget(store(transactions), { categoryId: CHARITY, target: TARGET, scope: "leaf" });
		expect(result.recommendedDefault).toBeUndefined();
	});

	it("still returns real historical quantiles, just framed as context rather than a suggestion", () => {
		const amounts = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 20, 40];
		const transactions = amounts.map((amount, i) => tx(`2024-${String(i + 1).padStart(2, "0")}-10`, -amount, CHARITY, "Various"));
		const result = forecastPolicyTarget(store(transactions), { categoryId: CHARITY, target: TARGET, scope: "leaf" });

		expect(result.p50?.amount).toBeGreaterThan(0);
		expect(result.p25!.amount).toBeLessThanOrEqual(result.p50!.amount);
		expect(result.p50!.amount).toBeLessThanOrEqual(result.p75!.amount);
		expect(result.diagnostics.explanation.some((line) => line.includes("not a statistical forecast") || line.includes("not a recommendation"))).toBe(true);
	});

	it("never suggests less than a known recurring commitment already in place", () => {
		// A flat, low history but a much larger recurring donation identified via a stable series —
		// the floor must win even though it sits above every historical quantile.
		const transactions: Transaction[] = [tx("2024-02-10", -10, CHARITY, "Small Local Charity"), tx("2024-08-10", -15, CHARITY, "One-off Fundraiser")];
		for (let month = 1; month <= 12; month++) {
			transactions.push(tx(`2024-${String(month).padStart(2, "0")}-01`, -200, CHARITY, "Monthly Pledge"));
		}
		const result = forecastPolicyTarget(store(transactions), { categoryId: CHARITY, target: TARGET, scope: "leaf" });
		expect(result.diagnostics.knownCommitments).toBe(200);
		expect(result.p25!.amount).toBeGreaterThanOrEqual(200);
	});

	it("is not forecastable at all with no history whatsoever", () => {
		const result = forecastPolicyTarget(store([]), { categoryId: CHARITY, target: TARGET, scope: "leaf" });
		expect(result.forecastable).toBe(false);
	});
});
