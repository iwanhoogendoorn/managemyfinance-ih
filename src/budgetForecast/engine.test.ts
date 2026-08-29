import { describe, expect, it } from "vitest";
import { runBudgetForecast } from "./engine";
import type { ForecastStore } from "./types";
import type { Account, Category, Transaction } from "../types";

const CHECKING: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR" };

let nextId = 0;
function tx(date: string, amount: number, categoryId: string, counterparty: string): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, date, accountId: CHECKING.id, description: counterparty, counterparty, amount, currency: "EUR", categoryId, source: "manual" };
}

const TARGET = { from: "2025-01-01", to: "2025-01-31", label: "January 2025" };

describe("runBudgetForecast — resolution order", () => {
	it("resolves a default primary's method and dispatches to it", () => {
		const FOOD = "cat-food";
		const categories: Category[] = [{ id: FOOD, name: "Food", color: "#000", icon: "tag", aliases: [] }];
		const transactions = Array.from({ length: 12 }, (_, i) => tx(`2024-${String(i + 1).padStart(2, "0")}-10`, -100, FOOD, "Supermarket"));
		const store: ForecastStore = { accounts: [CHECKING], categories, transactions };

		const result = runBudgetForecast(store, { categoryId: FOOD, target: TARGET, scope: "leaf" });
		expect(result.method).toBe("seasonal-quantile");
	});

	it("an explicit per-category override wins over the default profile", () => {
		const FOOD = "cat-food";
		const categories: Category[] = [{ id: FOOD, name: "Food", color: "#000", icon: "tag", aliases: [] }];
		const transactions = Array.from({ length: 12 }, (_, i) => tx(`2024-${String(i + 1).padStart(2, "0")}-01`, -100, FOOD, "Supermarket"));
		const store: ForecastStore = { accounts: [CHECKING], categories, transactions };

		const result = runBudgetForecast(store, { categoryId: FOOD, target: TARGET, scope: "leaf" }, { method: "sinking-fund" });
		expect(result.method).toBe("sinking-fund");
	});

	it("sends a category matching no default name at all through the adaptive classifier", () => {
		const CUSTOM = "cat-custom";
		const categories: Category[] = [{ id: CUSTOM, name: "My Hobby Fund", color: "#000", icon: "tag", aliases: [] }];
		// A different merchant every month so this never accidentally forms its own recurring series —
		// genuinely variable, one-off-looking spending, the case this test means to cover. Trailing
		// digits alone won't do it: normalizeMerchantKey strips a short trailing digit run as a branch
		// number, which would silently collapse "Shop 0".."Shop 11" back into one merchant key.
		const NAMES = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel", "India", "Juliet", "Kilo", "Lima"];
		const transactions = Array.from({ length: 12 }, (_, i) => tx(`2024-${String(i + 1).padStart(2, "0")}-10`, -40, CUSTOM, `${NAMES[i]} Hobby Shop`));
		const store: ForecastStore = { accounts: [CHECKING], categories, transactions };

		const result = runBudgetForecast(store, { categoryId: CUSTOM, target: TARGET, scope: "leaf" });
		// No recurring share, no sparsity, no seasonality — the adaptive classifier's own default rung.
		expect(result.method).toBe("seasonal-quantile");
	});

	it("resolves an adaptive-hybrid primary (Auto & Transport) to whichever concrete method its own history actually looks like", () => {
		const AUTO = "cat-auto";
		const categories: Category[] = [{ id: AUTO, name: "Auto & Transport", color: "#000", icon: "tag", aliases: [] }];
		// A stable monthly amount at one merchant reads as fixed-commitment territory: high recurring
		// share (it becomes its own detected series) and zero residual volatility.
		const transactions = Array.from({ length: 12 }, (_, i) => tx(`2024-${String(i + 1).padStart(2, "0")}-01`, -45, AUTO, "Car Insurer"));
		const store: ForecastStore = { accounts: [CHECKING], categories, transactions };

		const result = runBudgetForecast(store, { categoryId: AUTO, target: TARGET, scope: "leaf" });
		expect(result.method).toBe("fixed-commitment");
	});
});

describe("runBudgetForecast — non-budgetable and unimplemented methods", () => {
	it("returns Cash/ATM's exact spec reason rather than forecasting a spending target", () => {
		const CASH = "cat-cash";
		const categories: Category[] = [{ id: CASH, name: "Cash/ATM", color: "#000", icon: "tag", aliases: [] }];
		const transactions = [tx("2024-06-10", -200, CASH, "ATM Withdrawal")];
		const store: ForecastStore = { accounts: [CHECKING], categories, transactions };

		const result = runBudgetForecast(store, { categoryId: CASH, target: TARGET, scope: "leaf" });
		expect(result.forecastable).toBe(false);
		expect(result.reason).toMatch(/cash movements/i);
	});

	it("returns Transfers' exact spec reason rather than forecasting a spending target", () => {
		const TRANSFERS = "cat-transfers";
		const categories: Category[] = [{ id: TRANSFERS, name: "Transfers", color: "#000", icon: "tag", aliases: [] }];
		const store: ForecastStore = { accounts: [CHECKING], categories, transactions: [tx("2024-06-10", -500, TRANSFERS, "Savings")] };

		const result = runBudgetForecast(store, { categoryId: TRANSFERS, target: TARGET, scope: "leaf" });
		expect(result.forecastable).toBe(false);
		expect(result.reason).toMatch(/movements between your own accounts/i);
	});

	it("is honest that income-target isn't implemented yet, rather than silently running expense semantics on income", () => {
		const INCOME = "cat-income";
		const categories: Category[] = [{ id: INCOME, name: "Income", color: "#000", icon: "tag", aliases: [], kind: "income" }];
		const store: ForecastStore = { accounts: [CHECKING], categories, transactions: [tx("2024-06-10", 3000, INCOME, "Employer")] };

		const result = runBudgetForecast(store, { categoryId: INCOME, target: TARGET, scope: "leaf" });
		expect(result.forecastable).toBe(false);
		expect(result.method).toBe("income-target");
	});

	it("is honest that debt-schedule isn't implemented yet, rather than running ordinary expense history over a loan", () => {
		const LOAN = "cat-loan";
		const categories: Category[] = [{ id: LOAN, name: "Loan", color: "#000", icon: "tag", aliases: [] }];
		const store: ForecastStore = { accounts: [CHECKING], categories, transactions: [tx("2024-06-10", -300, LOAN, "Loan Payment")] };

		const result = runBudgetForecast(store, { categoryId: LOAN, target: TARGET, scope: "leaf" });
		expect(result.forecastable).toBe(false);
		expect(result.method).toBe("debt-schedule");
	});
});

describe("runBudgetForecast — outlier override merging", () => {
	it("merges a persisted per-category override's include/exclude ids with the request's own", () => {
		const FOOD = "cat-food";
		const categories: Category[] = [{ id: FOOD, name: "Food", color: "#000", icon: "tag", aliases: [] }];
		// Eight years of a stable December bump plus one wildly high December, same shape as the
		// seasonal-quantile fixtures — enough to produce a real flagged outlier to override.
		// A different merchant every month so this never accidentally forms a recurring series of its
		// own — that would add a known commitment on top and confuse this test's before/after
		// comparison. A trailing year/month digit suffix alone won't do it: normalizeMerchantKey strips
		// a short trailing digit run as a branch number, silently collapsing them back into one key.
		// Seven names against 12 calendar months (coprime) so the same month-of-year never lands on the
		// same merchant two years running either — otherwise even a merchant tied to one month would
		// eventually form its own yearly series. Only 4 comparable Decembers (the minimum this test can
		// use and still have `forecastSeasonalQuantile` treat the pattern as seasonal at all) so the one
		// outlier year carries enough weight in an R7 quantile to visibly move P75 once included.
		const MERCHANTS = ["Alpha Market", "Bravo Grocer", "Charlie Foods", "Delta Mart", "Echo Deli", "Foxtrot Grocery", "Golf Foods"];
		const transactions: Transaction[] = [];
		let monthIndex = 0;
		for (let year = 2021; year <= 2024; year++) {
			for (let month = 1; month <= 12; month++) {
				const amount = month === 12 ? (year === 2021 ? 1600 : 480) : 400;
				transactions.push(tx(`${year}-${String(month).padStart(2, "0")}-15`, -amount, FOOD, MERCHANTS[monthIndex % MERCHANTS.length]));
				monthIndex++;
			}
		}
		const store: ForecastStore = { accounts: [CHECKING], categories, transactions };
		const target = { from: "2025-12-01", to: "2025-12-31", label: "December 2025" };

		const withoutOverride = runBudgetForecast(store, { categoryId: FOOD, target, scope: "leaf" });
		expect(withoutOverride.outliers.some((o) => o.id === "2021-12")).toBe(true);

		const withOverride = runBudgetForecast(store, { categoryId: FOOD, target, scope: "leaf" }, { includeOutlierIds: ["2021-12"] });
		expect(withOverride.p75!.amount).toBeGreaterThan(withoutOverride.p75!.amount);
	});
});
