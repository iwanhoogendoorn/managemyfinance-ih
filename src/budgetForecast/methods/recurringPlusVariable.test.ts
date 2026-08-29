import { describe, expect, it } from "vitest";
import { forecastRecurringPlusVariable } from "./recurringPlusVariable";
import type { ForecastStore } from "../types";
import type { Account, Category, Subscription, Transaction } from "../../types";

const CHECKING: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR" };
const ENTERTAINMENT = "cat-entertainment";

const CATEGORIES: Category[] = [{ id: ENTERTAINMENT, name: "Entertainment", color: "#000", icon: "tag", aliases: [] }];

let nextId = 0;
function tx(date: string, amount: number, categoryId: string, counterparty: string, extra: Partial<Transaction> = {}): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, date, accountId: CHECKING.id, description: counterparty, counterparty, amount, currency: "EUR", categoryId, source: "manual", ...extra };
}

const NETFLIX: Subscription = {
	id: "sub-netflix",
	name: "Netflix",
	category: "Streaming",
	cost: 35,
	currency: "EUR",
	billingCycle: "monthly",
	paidVia: "private",
	archived: false,
	nextDueDate: "2025-01-05",
};

/**
 * Three years of Entertainment: a €35/mo linked Netflix subscription plus variable spending
 * averaging €70/mo across five different one-off-looking merchants (a 5-long cycle against 12
 * calendar months, deliberately coprime so no month-of-year ever lands on the same phase two years
 * running — otherwise the fixture would accidentally manufacture its own seasonality). Matches the
 * spec's own §32 worked example: known €35 + variable P50 €70 = P50 €105.
 */
const VARIABLE_MERCHANTS = ["Cinema City", "Bowling Alley", "Concert Hall", "Theme Park", "Escape Room"];
const VARIABLE_AMOUNTS = [60, 65, 70, 75, 80];

function fixtureTransactions(): Transaction[] {
	const out: Transaction[] = [];
	let cycleIndex = 0;
	for (let year = 2022; year <= 2024; year++) {
		for (let month = 1; month <= 12; month++) {
			const mm = String(month).padStart(2, "0");
			out.push(tx(`${year}-${mm}-05`, -35, ENTERTAINMENT, "Netflix", { subscriptionId: "sub-netflix" }));
			const idx = cycleIndex % VARIABLE_MERCHANTS.length;
			out.push(tx(`${year}-${mm}-15`, -VARIABLE_AMOUNTS[idx], ENTERTAINMENT, VARIABLE_MERCHANTS[idx]));
			cycleIndex++;
		}
	}
	return out;
}

function store(transactions: Transaction[] = fixtureTransactions(), subscriptions: Subscription[] = [NETFLIX]): ForecastStore {
	return { accounts: [CHECKING], categories: CATEGORIES, transactions, subscriptions };
}

const TARGET = { from: "2025-01-01", to: "2025-01-31", label: "January 2025" };

describe("forecastRecurringPlusVariable — Entertainment", () => {
	const result = forecastRecurringPlusVariable(store(), { categoryId: ENTERTAINMENT, target: TARGET, scope: "leaf" });

	it("reproduces the spec's own worked example exactly: known €35 + variable P50 €70 = €105 (§32)", () => {
		expect(result.diagnostics.knownCommitments).toBe(35);
		expect(result.diagnostics.baseline).toBeCloseTo(70, 5);
		expect(result.p50?.amount).toBeCloseTo(105, 5);
	});

	it("subtracts the identified recurring charge out of history before forecasting the residual", () => {
		// Raw Entertainment spend is €105/mo (35 + 70); the residual baseline must read as the €70
		// variable component alone, not the unadjusted €105 total.
		expect(result.diagnostics.baseline).not.toBeCloseTo(105, 1);
	});

	it("orders P25 below P50 below P75", () => {
		expect(result.p25!.amount).toBeLessThanOrEqual(result.p50!.amount);
		expect(result.p50!.amount).toBeLessThanOrEqual(result.p75!.amount);
	});

	it("still reports the outcome under its own method name in diagnostics and outliers", () => {
		expect(result.method).toBe("recurring-plus-variable");
		expect(result.diagnostics.method).toBe("recurring-plus-variable");
	});

	it("is forecastable for a pay-cycle target too, sharing the same proration engine as seasonal-quantile (§11, Phase G)", () => {
		const payCycle = forecastRecurringPlusVariable(store(), { categoryId: ENTERTAINMENT, target: { from: "2025-01-20", to: "2025-02-19", label: "Pay cycle" }, scope: "leaf" });
		expect(payCycle.forecastable).toBe(true);
		expect(payCycle.diagnostics.explanation.some((line) => line.includes("January") && line.includes("February"))).toBe(true);
	});
});

describe("forecastRecurringPlusVariable — no identified recurring source", () => {
	it("forecasts the raw total when nothing recurring was ever identified — residual equals the total", () => {
		const soloTx: Transaction[] = [];
		for (let year = 2022; year <= 2024; year++) {
			for (let month = 1; month <= 12; month++) {
				const idx = ((year - 2022) * 12 + month) % VARIABLE_MERCHANTS.length;
				soloTx.push(tx(`${year}-${String(month).padStart(2, "0")}-15`, -VARIABLE_AMOUNTS[idx], ENTERTAINMENT, VARIABLE_MERCHANTS[idx]));
			}
		}
		const result = forecastRecurringPlusVariable(store(soloTx, []), { categoryId: ENTERTAINMENT, target: TARGET, scope: "leaf" });
		expect(result.diagnostics.knownCommitments).toBe(0);
		expect(result.diagnostics.baseline).toBeCloseTo(70, 5);
	});
});

describe("forecastRecurringPlusVariable — Bills & Utilities (budget_spec.md §57)", () => {
	// A required-tests fixture straight from the spec: winter energy high, summer energy low, internet
	// fixed. September must combine the known internet charge with September's *own* seasonal energy
	// level — not an unadjusted trailing summer average, which would badly understate it.
	const UTILITIES = "cat-utilities";
	const UTIL_CATEGORIES: Category[] = [{ id: UTILITIES, name: "Bills & Utilities", color: "#000", icon: "tag", aliases: [] }];
	const INTERNET: Subscription = {
		id: "sub-internet",
		name: "Internet Co",
		category: "Utilities",
		cost: 40,
		currency: "EUR",
		billingCycle: "monthly",
		paidVia: "private",
		archived: false,
		nextDueDate: "2025-09-05",
	};
	// A different merchant every month so the seasonal energy spend never accidentally forms its own
	// recurring series and gets treated as "known" the way the internet charge correctly is.
	const ENERGY_MERCHANTS = ["Power Co A", "Power Co B", "Power Co C", "Power Co D", "Power Co E", "Power Co F", "Power Co G"];

	function utilitiesFixture(): Transaction[] {
		const out: Transaction[] = [];
		let idx = 0;
		for (let year = 2017; year <= 2024; year++) {
			for (let month = 1; month <= 12; month++) {
				const mm = String(month).padStart(2, "0");
				out.push(tx(`${year}-${mm}-05`, -40, UTILITIES, "Internet Co", { subscriptionId: "sub-internet" }));
				// Summer (Jun/Jul/Aug) is a low €100 energy month; every other month, September
				// included, is a high €300 winter-shaped month.
				const isSummer = month >= 6 && month <= 8;
				out.push(tx(`${year}-${mm}-15`, -(isSummer ? 100 : 300), UTILITIES, ENERGY_MERCHANTS[idx % ENERGY_MERCHANTS.length]));
				idx++;
			}
		}
		return out;
	}

	it("combines the known internet charge with September's own seasonal energy level, not a trailing summer average", () => {
		const store: ForecastStore = { accounts: [CHECKING], categories: UTIL_CATEGORIES, transactions: utilitiesFixture(), subscriptions: [INTERNET] };
		const target = { from: "2025-09-01", to: "2025-09-30", label: "September 2025" };
		const result = forecastRecurringPlusVariable(store, { categoryId: UTILITIES, target, scope: "leaf" });

		expect(result.diagnostics.knownCommitments).toBe(40);
		// A naive trailing 3-month (Jun/Jul/Aug) summer average would read €100 energy + €40 internet =
		// €140 — this must land well above that, since September isn't a summer month.
		expect(result.p50!.amount).toBeGreaterThan(140);
	});
});
