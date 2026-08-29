import { describe, it, expect } from "vitest";
import { buildCategorySpendHistory, trackedMonths } from "./history";
import type { ForecastStore } from "./types";
import type { Account, Category, Transaction } from "../types";

const CHECKING: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR" };
const INVESTING: Account = { id: "acc-investing", name: "Investing", type: "investing", currency: "EUR" };
const FOOD = "cat-food";
const GROCERIES = "cat-food-groceries";
const TRANSFERS = "cat-transfers";

let nextId = 0;
function tx(date: string, amount: number, categoryId: string | undefined, extra: Partial<Transaction> = {}): Transaction {
	nextId++;
	return {
		id: `tx-${nextId}`,
		date,
		accountId: CHECKING.id,
		description: "test",
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

const CATEGORIES: Category[] = [
	cat({ id: FOOD, name: "Food" }),
	cat({ id: GROCERIES, name: "Groceries", parentId: FOOD }),
	cat({ id: TRANSFERS, name: "Transfers" }),
	// Needed for refund/income to be told apart at all — see semantics.ts's refundsDistinguishable():
	// a vault with no income-kind category keeps the old sign-only reading, where a positive row is
	// always "income", never a refund.
	cat({ id: "cat-income", name: "Income", kind: "income" }),
];

function store(transactions: Transaction[]): ForecastStore {
	return { accounts: [CHECKING, INVESTING], categories: CATEGORIES, transactions };
}

describe("trackedMonths", () => {
	it("collects every month with any transaction at all, regardless of category", () => {
		const s = store([tx("2024-01-05", -10, FOOD), tx("2024-03-10", 500, undefined)]);
		expect(trackedMonths(s)).toEqual(new Set(["2024-01", "2024-03"]));
	});

	it("is empty for an empty ledger", () => {
		expect(trackedMonths(store([]))).toEqual(new Set());
	});
});

describe("buildCategorySpendHistory", () => {
	it("returns nothing at all for an empty ledger", () => {
		expect(buildCategorySpendHistory(store([]), FOOD, "leaf")).toEqual([]);
	});

	it("nets a refund against the expense it returned, rather than summing raw negative amounts", () => {
		const s = store([tx("2024-01-10", -600, GROCERIES), tx("2024-01-15", 100, GROCERIES)]);
		const history = buildCategorySpendHistory(s, GROCERIES, "leaf");
		const jan = history.find((h) => h.key === "2024-01")!;
		expect(jan.economicExpense).toBe(500);
		expect(jan.transactionCount).toBe(2); // both rows counted, even though the net is one figure
	});

	it("excludes an internal transfer from the history entirely", () => {
		const s = store([tx("2024-01-10", -200, TRANSFERS, { transferGroupId: "xfer-1" })]);
		const history = buildCategorySpendHistory(s, TRANSFERS, "leaf");
		expect(history.find((h) => h.key === "2024-01")?.economicExpense ?? 0).toBe(0);
	});

	it("excludes an investment buy (a trade, not spending) from the history", () => {
		const s: ForecastStore = {
			accounts: [CHECKING, INVESTING],
			categories: CATEGORIES,
			transactions: [tx("2024-01-10", -1000, FOOD, { accountId: INVESTING.id, action: "buy" })],
		};
		const history = buildCategorySpendHistory(s, FOOD, "leaf");
		expect(history.find((h) => h.key === "2024-01")?.economicExpense ?? 0).toBe(0);
	});

	it("excludes income (a positive amount in an income-kind category) from the expense history", () => {
		const s = store([tx("2024-01-10", 2000, "cat-income")]);
		const history = buildCategorySpendHistory(s, "cat-income", "leaf");
		expect(history.find((h) => h.key === "2024-01")?.economicExpense ?? 0).toBe(0);
	});

	it("distinguishes a tracked zero from an untracked month", () => {
		// The ledger has activity in Jan (Groceries) and Mar (Food, not Groceries) — Feb has no
		// ledger activity anywhere. Feb must never appear (nothing to observe); Mar must appear as a
		// real €0 for Groceries, since the ledger was genuinely active that month, just not there.
		const s = store([tx("2024-01-10", -50, GROCERIES), tx("2024-03-05", -20, FOOD)]);
		const history = buildCategorySpendHistory(s, GROCERIES, "leaf");
		const keys = history.map((h) => h.key);
		expect(keys).toEqual(["2024-01", "2024-03"]); // Feb is absent, not a manufactured zero
		expect(history.find((h) => h.key === "2024-03")!.economicExpense).toBe(0); // a real, tracked zero
	});

	it("leaf scope counts only the exact category, not its secondaries or its parent's own direct spend", () => {
		const s = store([tx("2024-01-10", -50, GROCERIES), tx("2024-01-12", -30, FOOD)]);
		const leafFood = buildCategorySpendHistory(s, FOOD, "leaf").find((h) => h.key === "2024-01")!;
		const leafGroceries = buildCategorySpendHistory(s, GROCERIES, "leaf").find((h) => h.key === "2024-01")!;
		expect(leafFood.economicExpense).toBe(30); // only the row tagged directly to Food
		expect(leafGroceries.economicExpense).toBe(50); // only the row tagged directly to Groceries
	});

	it("rollup scope sums a primary's own direct spend together with all of its secondaries'", () => {
		const s = store([tx("2024-01-10", -50, GROCERIES), tx("2024-01-12", -30, FOOD)]);
		const rollup = buildCategorySpendHistory(s, FOOD, "rollup").find((h) => h.key === "2024-01")!;
		expect(rollup.economicExpense).toBe(80);
	});

	it("converts foreign-currency spend at the transaction's own historical rate", () => {
		const s: ForecastStore = {
			accounts: [CHECKING],
			categories: CATEGORIES,
			transactions: [{ ...tx("2024-01-10", -100, FOOD), currency: "USD" }],
			fx: { baseCurrency: "EUR", rates: { USD: 0.9 } },
		};
		const jan = buildCategorySpendHistory(s, FOOD, "leaf").find((h) => h.key === "2024-01")!;
		expect(jan.economicExpense).toBeCloseTo(90, 6); // 100 USD * 0.9
	});

	it("carries each entry's own calendar range", () => {
		const s = store([tx("2024-02-10", -50, FOOD)]);
		const feb = buildCategorySpendHistory(s, FOOD, "leaf").find((h) => h.key === "2024-02")!;
		expect(feb).toMatchObject({ from: "2024-02-01", to: "2024-02-29" }); // 2024 is a leap year
	});
});
