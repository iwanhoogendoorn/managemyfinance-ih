import { describe, expect, it } from "vitest";
import { buildCategorySpendHistory } from "../history";
import { forecastSeasonalQuantile, seasonalityStrengthSpread, seasonalObservations, seasonalRatioForMonth } from "./seasonalQuantile";
import type { ForecastStore } from "../types";
import type { Account, Category, Transaction } from "../../types";

const CHECKING: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR" };
const FOOD = "cat-food";
const UTILITIES = "cat-utilities";

const CATEGORIES: Category[] = [
	{ id: FOOD, name: "Food", color: "#000", icon: "tag", aliases: [] },
	{ id: UTILITIES, name: "Utilities", color: "#000", icon: "tag", aliases: [] },
	// Needed for refund/income to be told apart at all — see semantics.ts's refundsDistinguishable().
	{ id: "cat-income", name: "Income", color: "#000", icon: "tag", aliases: [], kind: "income" },
];

let nextId = 0;
function tx(date: string, amount: number, categoryId: string): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, date, accountId: CHECKING.id, description: "test", amount, currency: "EUR", categoryId, source: "manual" };
}

/**
 * Eight years (2017–2024) of Food history: a flat €400/month baseline every Jan–Nov, and a December
 * that's consistently 15–30% higher every year except 2020, where a one-off €1,600 holiday blowout
 * stands far outside the other seven Decembers — the exact §21 "€1,600 Food September" shape, just in
 * December. Utilities gets a flat, barely-noisy €200/month with no real seasonal pattern at all, to
 * exercise the §30 fallback path instead.
 */
const DECEMBER_BY_YEAR: Record<number, number> = { 2017: 460, 2018: 470, 2019: 480, 2020: 1600, 2021: 490, 2022: 500, 2023: 510, 2024: 520 };
const UTILITIES_BY_MONTH = [200, 205, 198, 202, 199, 201, 203, 197, 200, 204, 199, 201];

function fixtureTransactions(): Transaction[] {
	const out: Transaction[] = [];
	for (let year = 2017; year <= 2024; year++) {
		for (let month = 1; month <= 12; month++) {
			const mm = String(month).padStart(2, "0");
			out.push(tx(`${year}-${mm}-15`, -(month === 12 ? DECEMBER_BY_YEAR[year] : 400), FOOD));
			out.push(tx(`${year}-${mm}-10`, -UTILITIES_BY_MONTH[month - 1], UTILITIES));
		}
	}
	return out;
}

function store(transactions: Transaction[] = fixtureTransactions()): ForecastStore {
	return { accounts: [CHECKING], categories: CATEGORIES, transactions };
}

const TARGET = { from: "2025-12-01", to: "2025-12-31", label: "December 2025" };

describe("seasonalRatioForMonth", () => {
	it("reads a normal December against its own year's median tracked month", () => {
		const byKey = new Map(
			Array.from({ length: 12 }, (_, i) => `2024-${String(i + 1).padStart(2, "0")}`).map((key, i) => [
				key,
				{ key, from: "", to: "", economicExpense: i === 11 ? 520 : 400, transactionCount: 1 },
			])
		);
		expect(seasonalRatioForMonth(byKey, "2024-12")).toBeCloseTo(1.3, 5);
	});

	it("refuses to compute a ratio from fewer than 8 tracked months in that year (§16)", () => {
		const byKey = new Map([
			["2024-11", { key: "2024-11", from: "", to: "", economicExpense: 400, transactionCount: 1 }],
			["2024-12", { key: "2024-12", from: "", to: "", economicExpense: 520, transactionCount: 1 }],
		]);
		expect(seasonalRatioForMonth(byKey, "2024-12")).toBeUndefined();
	});

	it("is undefined when the target month itself was never tracked", () => {
		expect(seasonalRatioForMonth(new Map(), "2024-12")).toBeUndefined();
	});
});

describe("forecastSeasonalQuantile — Food (seasonal path)", () => {
	const result = forecastSeasonalQuantile(store(), { categoryId: FOOD, target: TARGET, scope: "leaf" });

	it("uses the seasonal path, since December is a moderately strong, well-covered pattern", () => {
		expect(result.forecastable).toBe(true);
		expect(result.diagnostics.seasonality).toBe("moderate");
		expect(result.diagnostics.seasonalFactorP25).toBeCloseTo(1.1875, 5);
		expect(result.diagnostics.seasonalFactorP50).toBeCloseTo(1.225, 5);
		expect(result.diagnostics.seasonalFactorP75).toBeCloseTo(1.2625, 5);
	});

	it("fits a flat €400 baseline, undistracted by every year's December bump", () => {
		expect(result.diagnostics.baseline).toBeCloseTo(400, 5);
		expect(result.diagnostics.recentMonthsUsed).toBe(24);
	});

	it("flags 2020's €1,600 December and excludes it from the forecast by default", () => {
		expect(result.outliers).toHaveLength(1);
		expect(result.outliers[0]).toMatchObject({ id: "2020-12", amount: 1600, includedByDefault: false });
		expect(result.diagnostics.comparableObservations).toBe(8);
	});

	it("computes P25/P50/P75 as baseline × seasonal quantile, ordered low to high", () => {
		expect(result.p25?.amount).toBeCloseTo(475, 5);
		expect(result.p50?.amount).toBeCloseTo(490, 5);
		expect(result.p75?.amount).toBeCloseTo(505, 5);
		expect(result.p25!.amount).toBeLessThan(result.p50!.amount);
		expect(result.p50!.amount).toBeLessThan(result.p75!.amount);
	});

	it("recommends P50 and reports high confidence off eight comparable, low-volatility years", () => {
		expect(result.recommendedDefault).toBe("p50");
		expect(result.p50?.confidenceLabel).toBe("high");
		expect(result.diagnostics.volatility).toBe("low");
	});

	it("explains itself in plain language, including the excluded outlier", () => {
		expect(result.diagnostics.explanation.some((line) => line.includes("€400/month"))).toBe(true);
		expect(result.diagnostics.explanation.some((line) => line.includes("December 2020"))).toBe(true);
	});

	it("pulls the outlier back in and recomputes when the user overrides it to Include", () => {
		const included = forecastSeasonalQuantile(store(), {
			categoryId: FOOD,
			target: TARGET,
			scope: "leaf",
			outlierOverrides: { "2020-12": "include" },
		});
		// 2020's ratio of 4.0 pulls every quantile up once it's back in the sample.
		expect(included.p50!.amount).toBeGreaterThan(result.p50!.amount);
		expect(included.diagnostics.explanation.some((line) => line.includes("excluded"))).toBe(false);
	});
});

describe("forecastSeasonalQuantile — Utilities (fallback path)", () => {
	const result = forecastSeasonalQuantile(store(), { categoryId: UTILITIES, target: TARGET, scope: "leaf" });

	it("falls back to trend-adjusted recent history — Utilities has no real seasonal pattern", () => {
		expect(result.forecastable).toBe(true);
		expect(result.diagnostics.seasonality).toBe("weak");
		expect(result.diagnostics.seasonalFactorP50).toBeUndefined();
		expect(result.diagnostics.explanation.some((line) => line.includes("Not enough seasonal history"))).toBe(true);
	});

	it("still produces an ordered, low-volatility forecast from the flat recent months", () => {
		expect(result.p25!.amount).toBeLessThanOrEqual(result.p50!.amount);
		expect(result.p50!.amount).toBeLessThanOrEqual(result.p75!.amount);
		expect(result.diagnostics.volatility).toBe("low");
		expect(result.diagnostics.comparableObservations).toBe(24);
	});
});

describe("forecastSeasonalQuantile — edge cases", () => {
	it("is not forecastable at all for a completely untracked ledger", () => {
		const result = forecastSeasonalQuantile(store([]), { categoryId: FOOD, target: TARGET, scope: "leaf" });
		expect(result.forecastable).toBe(false);
		expect(result.reason).toMatch(/no spending history/i);
	});

	it("still forecasts €0 for a category that's tracked but never spent on — a real zero, not an error", () => {
		const result = forecastSeasonalQuantile(store(), { categoryId: "cat-never-used", target: TARGET, scope: "leaf" });
		expect(result.forecastable).toBe(true);
		expect(result.p50?.amount).toBe(0);
		expect(result.p50?.confidenceLabel).not.toBe("high");
	});

	it("prorates a pay-cycle target across the two calendar months it spans instead of declining it (§11, Phase G)", () => {
		const result = forecastSeasonalQuantile(store(), {
			categoryId: FOOD,
			target: { from: "2025-08-20", to: "2025-09-19", label: "Pay cycle" },
			scope: "leaf",
		});
		expect(result.forecastable).toBe(true);
		expect(result.diagnostics.explanation.some((line) => line.includes("August") && line.includes("September"))).toBe(true);
	});
});

describe("seasonalObservations and seasonalityStrengthSpread", () => {
	const byKey = new Map(buildCategorySpendHistory(store(), FOOD, "leaf").map((h) => [h.key, h]));

	it("returns one observation per comparable prior year, most recent first", () => {
		const observations = seasonalObservations(byKey, "2025-12");
		expect(observations[0].id).toBe("2024-12");
		expect(observations).toHaveLength(8);
	});

	it("reports a real spread across the year's twelve months, not just the target month", () => {
		// Eleven flat months at ratio 1.0 and one December well above it — a real spread, not zero.
		expect(seasonalityStrengthSpread(byKey, "2025-12")).toBeGreaterThan(0.1);
	});
});

describe("forecastSeasonalQuantile — pay-cycle proration (§11, Phase G)", () => {
	// A different merchant every month (coprime-length cycle) so nothing here accidentally forms its
	// own recurring series — `tx()` doesn't take a counterparty, so it's added on top here. Flat
	// €500/mo for years, then a single step to €600 for August 2025 only — deliberately not part of
	// the flat baseline the two ends of the pay cycle are compared against.
	const MERCHANTS = ["Alpha Market", "Bravo Grocer", "Charlie Foods", "Delta Mart", "Echo Deli", "Foxtrot Grocery", "Golf Foods"];
	function withMerchant(t: Transaction, i: number): Transaction {
		return { ...t, counterparty: MERCHANTS[i % MERCHANTS.length] };
	}
	function payCycleFixture(): Transaction[] {
		const out: Transaction[] = [];
		let idx = 0;
		for (let year = 2018; year <= 2024; year++) {
			for (let month = 1; month <= 12; month++) {
				out.push(withMerchant(tx(`${year}-${String(month).padStart(2, "0")}-15`, -500, FOOD), idx));
				idx++;
			}
		}
		for (let month = 1; month <= 7; month++) {
			out.push(withMerchant(tx(`2025-${String(month).padStart(2, "0")}-15`, -500, FOOD), idx));
			idx++;
		}
		out.push(withMerchant(tx("2025-08-15", -600, FOOD), idx));
		return out;
	}
	const target = { from: "2025-08-25", to: "2025-09-24", label: "Pay cycle" };
	const result = forecastSeasonalQuantile(store(payCycleFixture()), { categoryId: FOOD, target, scope: "leaf" });

	it("is forecastable for a target that spans two calendar months, rather than declining it", () => {
		expect(result.forecastable).toBe(true);
	});

	it("prorates by calendar-day overlap exactly as §11 specifies: Aug 25–31 (7/31) + Sep 1–24 (24/30)", () => {
		// Both standalone months read €500 here (the August step lands as its own excluded outlier in
		// both), so this pins the exact day-weighted arithmetic itself: 500×7/31 + 500×24/30.
		const expected = (500 * 7) / 31 + (500 * 24) / 30;
		expect(result.p50?.amount).toBeCloseTo(expected, 6);
	});

	it("names both months in the explanation instead of reading the whole range as one statistical month", () => {
		expect(result.diagnostics.explanation.some((line) => line.includes("August") && line.includes("September"))).toBe(true);
	});

	it("still flags the August step as an outlier in its own month's analysis", () => {
		expect(result.outliers.some((o) => o.id === "2025-08")).toBe(true);
	});

	it("adds a known commitment due inside the cycle in full, unprorated (§11: 'include the full €50')", () => {
		const subscription = {
			id: "sub-mealkit",
			name: "Meal Kit",
			category: "Food",
			cost: 50,
			currency: "EUR",
			billingCycle: "monthly" as const,
			paidVia: "private" as const,
			archived: false,
			nextDueDate: "2025-09-05",
		};
		const linked: Transaction[] = Array.from({ length: 12 }, (_, i) => ({
			...tx(`2024-${String(i + 1).padStart(2, "0")}-05`, -50, FOOD),
			counterparty: "Meal Kit",
			subscriptionId: "sub-mealkit",
		}));
		const storeWithSub: ForecastStore = { ...store(payCycleFixture()), transactions: [...payCycleFixture(), ...linked], subscriptions: [subscription] };
		const withCommitment = forecastSeasonalQuantile(storeWithSub, { categoryId: FOOD, target, scope: "leaf" });
		expect(withCommitment.diagnostics.knownCommitments).toBe(50);
	});

	it("excludes a commitment due after the cycle actually ends, even though it falls inside the same calendar month (§62)", () => {
		// The cycle runs Aug 25 – Sep 24; a subscription due Sep 30 is outside it, full stop — it must
		// not be included just because September is one of the two months being prorated.
		const subscription = {
			id: "sub-late",
			name: "Late Charge",
			category: "Food",
			cost: 75,
			currency: "EUR",
			billingCycle: "monthly" as const,
			paidVia: "private" as const,
			archived: false,
			nextDueDate: "2025-09-30",
		};
		// Day 28, valid in every month including February, so this stays a clean monthly series.
		const linked: Transaction[] = Array.from({ length: 12 }, (_, i) => ({
			...tx(`2024-${String(i + 1).padStart(2, "0")}-28`, -75, FOOD),
			counterparty: "Late Charge",
			subscriptionId: "sub-late",
		}));
		const storeWithSub: ForecastStore = { ...store(payCycleFixture()), transactions: [...payCycleFixture(), ...linked], subscriptions: [subscription] };
		const result = forecastSeasonalQuantile(storeWithSub, { categoryId: FOOD, target, scope: "leaf" });
		expect(result.diagnostics.knownCommitments).toBe(0);
	});

	it("counts one monthly commitment exactly once across the two prorated segments, never twice (§62)", () => {
		const subscription = {
			id: "sub-mealkit",
			name: "Meal Kit",
			category: "Food",
			cost: 50,
			currency: "EUR",
			billingCycle: "monthly" as const,
			paidVia: "private" as const,
			archived: false,
			nextDueDate: "2025-09-05",
		};
		const linked: Transaction[] = Array.from({ length: 12 }, (_, i) => ({
			...tx(`2024-${String(i + 1).padStart(2, "0")}-05`, -50, FOOD),
			counterparty: "Meal Kit",
			subscriptionId: "sub-mealkit",
		}));
		const storeWithSub: ForecastStore = { ...store(payCycleFixture()), transactions: [...payCycleFixture(), ...linked], subscriptions: [subscription] };
		const result = forecastSeasonalQuantile(storeWithSub, { categoryId: FOOD, target, scope: "leaf" });
		// A single monthly commitment inside a ~31-day cycle has exactly one due date in range —
		// €50, not €100.
		expect(result.diagnostics.knownCommitments).toBe(50);
	});
});
