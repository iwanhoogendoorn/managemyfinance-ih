import { describe, expect, it } from "vitest";
import { forecastGuardrail } from "./guardrail";
import type { ForecastStore } from "../types";
import type { Account, Category, Subscription, Transaction } from "../../types";

const CHECKING: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR" };
const FEES = "cat-fees";
const CATEGORIES: Category[] = [{ id: FEES, name: "Fees & Charges", color: "#000", icon: "tag", aliases: [] }];

let nextId = 0;
function tx(date: string, amount: number, categoryId: string, counterparty: string, extra: Partial<Transaction> = {}): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, date, accountId: CHECKING.id, description: counterparty, counterparty, amount, currency: "EUR", categoryId, source: "manual", ...extra };
}

const ACCOUNT_FEE: Subscription = {
	id: "sub-fee",
	name: "Bank Fee",
	category: "Finance",
	cost: 8,
	currency: "EUR",
	billingCycle: "monthly",
	paidVia: "private",
	archived: false,
	nextDueDate: "2025-01-05",
};

// A known €8/mo mandatory account fee (linked) plus avoidable extra charges from six different
// one-off-looking sources averaging exactly €23/mo — the spec's own §37 worked example numbers.
const AVOIDABLE_MERCHANTS = ["ATM Surcharge", "Foreign Transaction Fee", "Overdraft Fee", "Late Payment Fee", "Card Replacement Fee", "Wire Transfer Fee"];

function fixtureTransactions(): Transaction[] {
	const out: Transaction[] = [];
	for (let month = 1; month <= 12; month++) {
		const mm = String(month).padStart(2, "0");
		out.push(tx(`2024-${mm}-01`, -8, FEES, "Bank Fee", { subscriptionId: "sub-fee" }));
		out.push(tx(`2024-${mm}-15`, -23, FEES, AVOIDABLE_MERCHANTS[(month - 1) % AVOIDABLE_MERCHANTS.length]));
	}
	return out;
}

function store(transactions: Transaction[] = fixtureTransactions()): ForecastStore {
	return { accounts: [CHECKING], categories: CATEGORIES, transactions, subscriptions: [ACCOUNT_FEE] };
}

const TARGET = { from: "2025-01-01", to: "2025-01-31", label: "January 2025" };

describe("forecastGuardrail — Fees & Charges (the spec's own worked example, §37)", () => {
	const result = forecastGuardrail(store(), { categoryId: FEES, target: TARGET, scope: "leaf" });

	it("suggests only the known mandatory fee, not the avoidable average on top of it", () => {
		expect(result.p50?.amount).toBe(8);
		expect(result.p25?.amount).toBe(8);
		expect(result.p75?.amount).toBe(8);
	});

	it("surfaces the avoidable average as diagnostic context only, never folded into the suggestion", () => {
		expect(result.diagnostics.baseline).toBeCloseTo(23, 5);
		expect(result.diagnostics.knownCommitments).toBe(8);
		expect(result.diagnostics.explanation.some((line) => line.includes("€8"))).toBe(true);
		expect(result.diagnostics.explanation.some((line) => line.includes("€23"))).toBe(true);
	});

	it("gives every scenario the same amount and confidence — a guardrail, not a spread", () => {
		expect(result.p25?.confidenceScore).toBe(result.p50?.confidenceScore);
		expect(result.p75?.confidenceScore).toBe(result.p50?.confidenceScore);
	});
});

describe("forecastGuardrail — no known mandatory fee at all", () => {
	it("suggests €0 when nothing mandatory was ever identified", () => {
		const soloTx = [tx("2024-06-15", -12, FEES, "ATM Surcharge"), tx("2024-09-20", -18, FEES, "Overdraft Fee")];
		const result = forecastGuardrail(store(soloTx), { categoryId: FEES, target: TARGET, scope: "leaf" });
		expect(result.p50?.amount).toBe(0);
		expect(result.diagnostics.explanation[0]).toMatch(/no known mandatory/i);
	});

	it("is not forecastable at all with no history whatsoever", () => {
		const emptyStore: ForecastStore = { accounts: [CHECKING], categories: CATEGORIES, transactions: [] };
		const result = forecastGuardrail(emptyStore, { categoryId: FEES, target: TARGET, scope: "leaf" });
		expect(result.forecastable).toBe(false);
	});
});
