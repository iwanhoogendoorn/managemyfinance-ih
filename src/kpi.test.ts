import { describe, it, expect } from "vitest";
import {
	summarizeByYear,
	summarizeByMonth,
	yearSummaryFor,
	netWorth,
	categoryTotals,
	categorySpend,
	accountStats,
	averageMonthlyExpenses,
	investingHoldings,
	investingActivityByYear,
	realizedPLByYear,
	fiProjection,
	detectTransferPairs,
	monthKeys,
	balanceSeries,
	windowSummary,
	burnRate,
	categoryChildren,
	topLevelCategories,
	categoryFamily,
	rollUpCategorySpend,
	quarterOf,
	shiftQuarter,
	quarterRange,
	isoWeekOf,
	shiftIsoWeek,
	isoWeekRange,
	type KpiStore,
} from "./kpi";
import type { Account, Category, Transaction } from "./types";

// ---------- fixtures ----------

const checking: Account = { id: "acc-checking", name: "Checking", type: "debit", currency: "EUR", openingBalance: 0 };
const checking2: Account = { id: "acc-checking-2", name: "Joint", type: "debit", currency: "EUR", openingBalance: 0 };
const savings: Account = { id: "acc-savings", name: "Savings", type: "saving", currency: "EUR", openingBalance: 0 };
const investing: Account = { id: "acc-investing", name: "Investing", type: "investing", currency: "EUR", openingBalance: 0 };

const catFood: Category = { id: "cat-food", name: "Food", color: "#000", icon: "utensils", aliases: [] };
const catIncome: Category = { id: "cat-income", name: "Income", color: "#000", icon: "coins", aliases: [] };
const catTransfers: Category = { id: "cat-transfers", name: "Transfers", color: "#000", icon: "arrow", aliases: [] };
const catCashAtm: Category = { id: "cat-cash-atm", name: "Cash/ATM", color: "#000", icon: "atm", aliases: [] };

let nextId = 0;
function tx(partial: Partial<Transaction> & Pick<Transaction, "date" | "accountId" | "amount">): Transaction {
	nextId++;
	return {
		id: `tx-${nextId}`,
		description: partial.description ?? "test",
		currency: "EUR",
		source: "manual",
		...partial,
	};
}

function store(overrides: Partial<KpiStore> = {}): KpiStore {
	return {
		accounts: [checking, savings, investing],
		categories: [catFood, catIncome, catTransfers, catCashAtm],
		transactions: [],
		...overrides,
	};
}

// ---------- isTransfer (exercised indirectly via summarizeByYear/summarizeByMonth/categoryTotals) ----------

describe("transfer detection", () => {
	it("excludes a transaction categorized as Transfers from both income and expenses", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: 100, categoryId: catTransfers.id }),
				tx({ date: "2024-01-02", accountId: checking.id, amount: -40, categoryId: catFood.id }),
			],
		});
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(0);
		expect(year.expenses).toBe(40);
	});

	it("matches the transfer category name case-insensitively and trimmed", () => {
		const weirdCasing: Category = { ...catTransfers, id: "cat-weird", name: "  TRANSFERS  " };
		const s = store({
			categories: [weirdCasing],
			transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: 100, categoryId: weirdCasing.id })],
		});
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(0);
	});

	it("treats a saving account's ING-style Withdrawal/Deposit `type` as a transfer even when miscategorized", () => {
		// Regression: this exact pattern (withdrawal from a savings account tagged "Cash/ATM" instead of
		// "Transfers") was found live in a user's ledger and caused real income to look near-zero.
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: savings.id, amount: -50, categoryId: catCashAtm.id, type: "Withdrawal" }),
				tx({ date: "2024-01-02", accountId: savings.id, amount: 50, categoryId: catTransfers.id, type: "Deposit" }),
			],
		});
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(0);
		expect(year.expenses).toBe(0);
	});

	it("treats an investing account's Trade-Republic-style deposit/withdraw `action` as a transfer", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: investing.id, amount: 500, action: "deposit" })],
		});
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(0);
	});

	it("does NOT treat an uncategorized checking-account transaction as a transfer", () => {
		// There's no account-to-account link on Transaction, so a genuine uncategorized transfer between
		// two everyday accounts is indistinguishable from real income/expense — documented limitation.
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: 100 })],
		});
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(100);
	});

	it("does not treat a plain Withdrawal/Deposit type on an everyday (non-saving/investing) account as a transfer", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: -50, type: "Withdrawal" })],
		});
		const [year] = summarizeByYear(s);
		expect(year.expenses).toBe(50);
	});
});

// ---------- summarizeByYear ----------

describe("summarizeByYear", () => {
	it("buckets income and expenses per year and computes net/savingsRate", () => {
		const s = store({
			transactions: [
				tx({ date: "2023-01-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
				tx({ date: "2023-01-02", accountId: checking.id, amount: -600, categoryId: catFood.id }),
				tx({ date: "2024-01-01", accountId: checking.id, amount: 2000, categoryId: catIncome.id }),
			],
		});
		const years = summarizeByYear(s);
		expect(years.map((y) => y.year)).toEqual(["2023", "2024"]);
		expect(years[0]).toMatchObject({ income: 1000, expenses: 600, net: 400, savingsRate: 0.4 });
		expect(years[1]).toMatchObject({ income: 2000, expenses: 0 });
	});

	it("the final year's netWorthEOY always equals netWorth(store) — every transaction counted exactly once", () => {
		const s = store({
			accounts: [{ ...checking, openingBalance: 500 }],
			transactions: [
				tx({ date: "2022-06-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
				tx({ date: "2022-06-02", accountId: checking.id, amount: -300, categoryId: catFood.id }),
				tx({ date: "2023-06-01", accountId: checking.id, amount: 50, categoryId: catTransfers.id }),
				tx({ date: "2024-06-01", accountId: checking.id, amount: -75, categoryId: catFood.id }),
			],
		});
		const years = summarizeByYear(s);
		expect(years.at(-1)!.netWorthEOY).toBeCloseTo(netWorth(s), 6);
	});

	it("an early year's netWorthEOY never includes a later year's transfers (regression: 2016 showing ~60K)", () => {
		const s = store({
			accounts: [{ ...checking, openingBalance: 100 }],
			transactions: [
				tx({ date: "2016-01-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
				tx({ date: "2016-01-02", accountId: checking.id, amount: -500, categoryId: catFood.id }),
				tx({ date: "2016-01-03", accountId: checking.id, amount: 200, categoryId: catTransfers.id }),
				// A large transfer that only happens in a later year must not leak backward into 2016.
				tx({ date: "2020-01-01", accountId: checking.id, amount: -900, categoryId: catTransfers.id }),
				tx({ date: "2020-01-02", accountId: checking.id, amount: 2000, categoryId: catIncome.id }),
				tx({ date: "2020-01-03", accountId: checking.id, amount: -300, categoryId: catFood.id }),
			],
		});
		const years = summarizeByYear(s);
		const y2016 = years.find((y) => y.year === "2016")!;
		// opening 100 + income 1000 - expenses 500 + that year's own +200 transfer = 800, NOT dragged
		// down by 2020's -900 transfer.
		expect(y2016.netWorthEOY).toBe(800);
		const y2020 = years.find((y) => y.year === "2020")!;
		expect(y2020.netWorthEOY).toBeCloseTo(netWorth(s), 6);
	});

	it("savingsRate is clamped to [-100%, 100%] instead of blowing up when income is near zero (regression)", () => {
		const s = store({
			transactions: [
				tx({ date: "2018-01-01", accountId: checking.id, amount: 0.02, categoryId: catIncome.id }),
				tx({ date: "2018-01-02", accountId: checking.id, amount: -1000, categoryId: catFood.id }),
			],
		});
		const [year] = summarizeByYear(s);
		expect(year.savingsRate).toBe(-1);
	});

	it("savingsRate is 0 when there's no income at all (not NaN/Infinity)", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: -100, categoryId: catFood.id })],
		});
		const [year] = summarizeByYear(s);
		expect(year.savingsRate).toBe(0);
	});

	it("scopes to a single account when accountId is given", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
				tx({ date: "2024-01-01", accountId: savings.id, amount: 5000, categoryId: catIncome.id }),
			],
		});
		const [year] = summarizeByYear(s, checking.id);
		expect(year.income).toBe(1000);
	});
});

describe("yearSummaryFor", () => {
	it("returns the matching year", () => {
		const years = summarizeByYear(
			store({ transactions: [tx({ date: "2024-03-01", accountId: checking.id, amount: 100 })] })
		);
		expect(yearSummaryFor(years, "2024")?.income).toBe(100);
	});

	it("returns undefined for a year with no data, rather than silently falling back to the last year", () => {
		const years = summarizeByYear(
			store({ transactions: [tx({ date: "2020-03-01", accountId: checking.id, amount: 100 })] })
		);
		expect(yearSummaryFor(years, "2099")).toBeUndefined();
	});
});

// ---------- summarizeByMonth ----------

describe("summarizeByMonth", () => {
	it("always returns all 12 months, even with no activity", () => {
		const months = summarizeByMonth(store(), "2024");
		expect(months).toHaveLength(12);
		expect(months.map((m) => m.month)).toEqual(["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"]);
	});

	it("buckets by month and excludes other years / transfers", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-03-15", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
				tx({ date: "2024-03-20", accountId: checking.id, amount: -200, categoryId: catFood.id }),
				tx({ date: "2024-04-01", accountId: checking.id, amount: -50, categoryId: catFood.id }),
				tx({ date: "2023-03-01", accountId: checking.id, amount: 9999, categoryId: catIncome.id }),
				tx({ date: "2024-03-10", accountId: checking.id, amount: 300, categoryId: catTransfers.id }),
			],
		});
		const months = summarizeByMonth(s, "2024");
		expect(months[2]).toMatchObject({ income: 1000, expenses: 200 }); // March
		expect(months[3]).toMatchObject({ income: 0, expenses: 50 }); // April
	});
});

// ---------- netWorth ----------

describe("netWorth", () => {
	it("sums opening balances plus every transaction amount", () => {
		const s = store({
			accounts: [{ ...checking, openingBalance: 100 }, { ...savings, openingBalance: 50 }],
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: 200 }),
				tx({ date: "2024-01-02", accountId: savings.id, amount: -20 }),
			],
		});
		expect(netWorth(s)).toBe(330);
	});

	it("scopes to a single account", () => {
		const s = store({
			accounts: [{ ...checking, openingBalance: 100 }, { ...savings, openingBalance: 50 }],
			transactions: [tx({ date: "2024-01-01", accountId: checking.id, amount: 200 })],
		});
		expect(netWorth(s, checking.id)).toBe(300);
		expect(netWorth(s, savings.id)).toBe(50);
	});

	it("excludes future-dated transactions from the balance you have today (regression: B2)", () => {
		const s = store({
			accounts: [{ ...checking, openingBalance: 100 }],
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: 200 }),
				tx({ date: "2099-01-01", accountId: checking.id, amount: 5000 }),
			],
		});
		expect(netWorth(s)).toBe(300);
	});

	it("honours an explicit asOf cutoff, inclusive of that day", () => {
		const s = store({
			accounts: [{ ...checking, openingBalance: 0 }],
			transactions: [
				tx({ date: "2024-06-29", accountId: checking.id, amount: 10 }),
				tx({ date: "2024-06-30", accountId: checking.id, amount: 20 }),
				tx({ date: "2024-07-01", accountId: checking.id, amount: 40 }),
			],
		});
		expect(netWorth(s, undefined, "2024-06-30")).toBe(30);
	});
});

// ---------- categoryTotals ----------

describe("categoryTotals", () => {
	it("sums only expenses, grouped by category, excluding transfers and income", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: -30, categoryId: catFood.id }),
				tx({ date: "2024-01-02", accountId: checking.id, amount: -20, categoryId: catFood.id }),
				tx({ date: "2024-01-03", accountId: checking.id, amount: 500, categoryId: catIncome.id }),
				tx({ date: "2024-01-04", accountId: checking.id, amount: -100, categoryId: catTransfers.id }),
				tx({ date: "2024-01-05", accountId: checking.id, amount: -15 }), // uncategorized
			],
		});
		const totals = categoryTotals(s);
		expect(totals.get(catFood.id)).toBe(50);
		expect(totals.get(catIncome.id)).toBeUndefined();
		expect(totals.get(catTransfers.id)).toBeUndefined();
		expect(totals.get("uncategorized")).toBe(15);
	});

	it("filters by year", () => {
		const s = store({
			transactions: [
				tx({ date: "2023-01-01", accountId: checking.id, amount: -30, categoryId: catFood.id }),
				tx({ date: "2024-01-01", accountId: checking.id, amount: -10, categoryId: catFood.id }),
			],
		});
		expect(categoryTotals(s, "2024").get(catFood.id)).toBe(10);
	});
});

// ---------- accountStats ----------

describe("accountStats", () => {
	it("counts transactions and reports net worth for one account", () => {
		const s = store({
			accounts: [{ ...checking, openingBalance: 100 }],
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: 50 }),
				tx({ date: "2024-01-02", accountId: checking.id, amount: -20 }),
				tx({ date: "2024-01-03", accountId: savings.id, amount: 999 }),
			],
		});
		expect(accountStats(s, checking.id)).toEqual({ count: 2, netWorth: 130 });
	});
});

// ---------- averageMonthlyExpenses ----------

describe("averageMonthlyExpenses", () => {
	it("averages expenses across months that had any spend, excluding transfers", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-05", accountId: checking.id, amount: -100, categoryId: catFood.id }),
				tx({ date: "2024-02-05", accountId: checking.id, amount: -300, categoryId: catFood.id }),
				tx({ date: "2024-02-06", accountId: checking.id, amount: -500, categoryId: catTransfers.id }),
			],
		});
		expect(averageMonthlyExpenses(s)).toBe(200); // (100 + 300) / 2 months
	});

	it("returns 0 when there are no expenses at all", () => {
		expect(averageMonthlyExpenses(store())).toBe(0);
	});

	it("filters by accountIds when given", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-05", accountId: checking.id, amount: -100, categoryId: catFood.id }),
				tx({ date: "2024-01-05", accountId: savings.id, amount: -400, categoryId: catFood.id }),
			],
		});
		expect(averageMonthlyExpenses(s, [checking.id])).toBe(100);
	});
});

// ---------- investingHoldings ----------

describe("investingHoldings", () => {
	it("nets buys and sells per ticker into shares/cost basis", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: -500, action: "buy", ticker: "VWCE", shares: 5 }),
				tx({ date: "2024-03-01", accountId: investing.id, amount: 400, action: "sell", ticker: "VWCE", shares: 4 }),
			],
		});
		const holdings = investingHoldings(s, investing.id);
		expect(holdings).toHaveLength(1);
		expect(holdings[0]).toMatchObject({ ticker: "VWCE", shares: 11 });
		expect(holdings[0].netInvested).toBeCloseTo(1100, 6); // 1000 + 500 - 400
	});

	it("drops a ticker once its position is fully closed", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -100, action: "buy", ticker: "AAPL", shares: 1 }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: 120, action: "sell", ticker: "AAPL", shares: 1 }),
			],
		});
		expect(investingHoldings(s, investing.id)).toHaveLength(0);
	});

	it("ignores CASH pseudo-ticker rows and non-buy/sell actions", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: 500, action: "deposit", ticker: "CASH" }),
				tx({ date: "2024-01-02", accountId: investing.id, amount: 5, action: "dividend", ticker: "VWCE" }),
			],
		});
		expect(investingHoldings(s, investing.id)).toHaveLength(0);
	});

	it("keeps the basis of the shares still held after a profitable partial sale (regression: B3)", () => {
		// Buy 10 @ €100, sell 5 @ €200. The old code subtracted the €1,000 of proceeds straight off the
		// €1,000 basis, leaving €0 of cost — and an avgCost of €0 — against five shares that cost €500.
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-06-01", accountId: investing.id, amount: 1000, action: "sell", ticker: "VWCE", shares: 5 }),
			],
		});
		const [holding] = investingHoldings(s, investing.id);
		expect(holding.shares).toBe(5);
		expect(holding.netInvested).toBeCloseTo(500, 6);
		expect(holding.avgCost).toBeCloseTo(100, 6);
		expect(holding.realizedPL).toBeCloseTo(500, 6);
	});

	it("never drives the cost basis negative on a large gain (regression: B3)", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "MOON", shares: 10 }),
				tx({ date: "2024-06-01", accountId: investing.id, amount: 9000, action: "sell", ticker: "MOON", shares: 1 }),
			],
		});
		const [holding] = investingHoldings(s, investing.id);
		expect(holding.netInvested).toBeCloseTo(900, 6);
		expect(holding.avgCost).toBeCloseTo(100, 6);
		expect(holding.realizedPL).toBeCloseTo(8900, 6);
	});

	it("uses the average cost at the moment of the sale, not the final average", () => {
		// Deliberately out of date order in the array: the walk must sort before it accumulates, or the
		// March buy would cheapen the shares sold in February.
		const s = store({
			transactions: [
				tx({ date: "2024-03-01", accountId: investing.id, amount: -2000, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: 750, action: "sell", ticker: "VWCE", shares: 5 }),
			],
		});
		const [holding] = investingHoldings(s, investing.id);
		expect(holding.shares).toBe(15);
		expect(holding.netInvested).toBeCloseTo(2500, 6); // 1000 - 500 released by the sale + 2000
		expect(holding.realizedPL).toBeCloseTo(250, 6); // 750 proceeds - 5 shares at the €100 average then
	});

	it("books no phantom profit when a sell row carries no share count", () => {
		// Hand-entered and generic-CSV sells can lack `shares`, so the basis can only be released up to
		// the proceeds — conservative, rather than treating the whole sale as gain.
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-06-01", accountId: investing.id, amount: 400, action: "sell", ticker: "VWCE" }),
			],
		});
		const [holding] = investingHoldings(s, investing.id);
		expect(holding.shares).toBe(10);
		expect(holding.netInvested).toBeCloseTo(600, 6);
		expect(holding.realizedPL).toBe(0);
	});

	it("counts a share-less buy as money in without inventing an average cost (review MINOR #17)", () => {
		// €1,000 for 10 shares then a €500 buy with no share count used to report €150/share — an average
		// the user never paid. The money still belongs in netInvested; only avgCost refuses to guess.
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: -500, action: "buy", ticker: "VWCE" }),
			],
		});
		const [holding] = investingHoldings(s, investing.id);
		expect(holding.shares).toBe(10);
		expect(holding.netInvested).toBeCloseTo(1500, 6);
		expect(holding.avgCost).toBeCloseTo(100, 6);
	});

	it("clamps an oversell at zero shares instead of carrying a negative count (review MAJOR #3)", () => {
		// A negative share count survived every later buy: after buying 10 more you still held −5, and the
		// position disappeared from the holdings table entirely.
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: 5000, action: "sell", ticker: "VWCE", shares: 25 }),
				tx({ date: "2024-03-01", accountId: investing.id, amount: -800, action: "buy", ticker: "VWCE", shares: 8 }),
			],
		});
		const [holding] = investingHoldings(s, investing.id);
		expect(holding.shares).toBe(8);
		expect(holding.avgCost).toBeCloseTo(100, 6);
	});
});

// ---------- investingActivityByYear ----------

describe("investingActivityByYear", () => {
	it("buckets deposits, withdrawals, dividends and fees by year", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: 1000, action: "deposit" }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: -200, action: "withdraw" }),
				tx({ date: "2024-03-01", accountId: investing.id, amount: 5, action: "dividend", fee: 1 }),
			],
		});
		const [year] = investingActivityByYear(s, investing.id);
		expect(year).toMatchObject({ year: "2024", deposits: 1000, withdrawals: 200, dividends: 5, fees: 1 });
	});

	it("accepts ING's long 'Withdrawal' spelling as well as 'withdraw' (review MINOR #13)", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: 5000, action: "Deposit" }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: -2000, action: "Withdrawal" }),
			],
		});
		const [year] = investingActivityByYear(s, investing.id);
		expect(year).toMatchObject({ deposits: 5000, withdrawals: 2000 });
	});

	it("counts the dividend/interest wordings brokers actually export (review MINOR #15)", () => {
		// The dashboard's yield figure already accepts these; the activity table used to drop them.
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: 12, action: "Dividend (Gross)" }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: 3, action: "Interest payment" }),
			],
		});
		const [year] = investingActivityByYear(s, investing.id);
		expect(year.dividends).toBeCloseTo(15, 6);
	});
});

// ---------- fiProjection ----------

// ---------- detectTransferPairs (B1 / P5) ----------

describe("detectTransferPairs", () => {
	/** Two everyday accounts, so neither the transfer category nor the saving/investing markers apply. */
	function twoAccountStore(transactions: Transaction[]): KpiStore {
		return store({ accounts: [checking, checking2], transactions });
	}

	it("matches an opposite-sign pair in different accounts within €0.01 and ±3 days", () => {
		// Over €500 the shape test alone is not enough, so the outgoing row names the receiving account.
		const s = twoAccountStore([
			tx({ date: "2024-01-10", accountId: checking.id, amount: -5000, counterparty: "Naar Joint" }),
			tx({ date: "2024-01-12", accountId: checking2.id, amount: 5000 }),
		]);
		const pairs = detectTransferPairs(s);
		expect(pairs).toHaveLength(1);
		expect(pairs[0]).toMatchObject({ amount: 5000, daysApart: 2 });
	});

	it("stops a debit↔debit transfer being counted as both income and expense (regression: B1)", () => {
		// Before the pair heuristic this recorded €5,000 of income AND €5,000 of expenses, inflating both
		// and pushing the savings rate to nonsense.
		const s = twoAccountStore([
			tx({ date: "2024-01-10", accountId: checking.id, amount: -5000, counterparty: "Naar Joint" }),
			tx({ date: "2024-01-12", accountId: checking2.id, amount: 5000 }),
			tx({ date: "2024-01-15", accountId: checking.id, amount: 3000, categoryId: catIncome.id }),
			tx({ date: "2024-01-20", accountId: checking.id, amount: -900, categoryId: catFood.id }),
		]);
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(3000);
		expect(year.expenses).toBe(900);
		expect(year.savingsRate).toBeCloseTo(0.7, 6);
	});

	it("does not pair two rows in the same account", () => {
		const s = twoAccountStore([
			tx({ date: "2024-01-10", accountId: checking.id, amount: -200 }),
			tx({ date: "2024-01-11", accountId: checking.id, amount: 200 }),
		]);
		expect(detectTransferPairs(s)).toHaveLength(0);
	});

	it("does not pair rows more than 3 days apart", () => {
		const s = twoAccountStore([
			tx({ date: "2024-01-10", accountId: checking.id, amount: -200 }),
			tx({ date: "2024-01-14", accountId: checking2.id, amount: 200 }),
		]);
		expect(detectTransferPairs(s)).toHaveLength(0);
	});

	it("tolerates a cent of drift but no more", () => {
		const near = twoAccountStore([
			tx({ date: "2024-01-10", accountId: checking.id, amount: -100.0 }),
			tx({ date: "2024-01-10", accountId: checking2.id, amount: 100.01 }),
		]);
		expect(detectTransferPairs(near)).toHaveLength(1);

		const far = twoAccountStore([
			tx({ date: "2024-01-10", accountId: checking.id, amount: -100.0 }),
			tx({ date: "2024-01-10", accountId: checking2.id, amount: 100.05 }),
		]);
		expect(detectTransferPairs(far)).toHaveLength(0);
	});

	it("does not pair two rows of the same sign", () => {
		const s = twoAccountStore([
			tx({ date: "2024-01-10", accountId: checking.id, amount: -200 }),
			tx({ date: "2024-01-10", accountId: checking2.id, amount: -200 }),
		]);
		expect(detectTransferPairs(s)).toHaveLength(0);
	});

	it("never matches one row twice — a lone outflow can only claim one of two candidate inflows", () => {
		const s = store({
			accounts: [checking, checking2, savings],
			transactions: [
				tx({ date: "2024-01-10", accountId: checking.id, amount: -100 }),
				tx({ date: "2024-01-10", accountId: checking2.id, amount: 100, categoryId: catIncome.id }),
				tx({ date: "2024-01-10", accountId: savings.id, amount: 100, categoryId: catIncome.id }),
			],
		});
		expect(detectTransferPairs(s)).toHaveLength(1);
		// The unmatched inflow stays real income; the matched pair vanishes from both sides.
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(100);
		expect(year.expenses).toBe(0);
	});

	it("prefers the closest date when two candidates are otherwise identical", () => {
		const s = twoAccountStore([
			tx({ date: "2024-01-05", accountId: checking.id, amount: -100 }),
			tx({ date: "2024-01-04", accountId: checking2.id, amount: 100, categoryId: catIncome.id }),
			tx({ date: "2024-01-08", accountId: checking2.id, amount: 100, categoryId: catIncome.id }),
		]);
		const pairs = detectTransferPairs(s);
		expect(pairs).toHaveLength(1);
		expect(pairs[0].daysApart).toBe(1);
	});

	it("matches the largest amounts first so a big move claims its true counterpart", () => {
		const s = twoAccountStore([
			tx({ date: "2024-01-10", accountId: checking.id, amount: -50 }),
			tx({ date: "2024-01-10", accountId: checking.id, amount: -4000, categoryId: catTransfers.id }),
			tx({ date: "2024-01-10", accountId: checking2.id, amount: 4000 }),
			tx({ date: "2024-01-10", accountId: checking2.id, amount: 50 }),
		]);
		const pairs = detectTransferPairs(s);
		expect(pairs.map((p) => p.amount)).toEqual([4000, 50]);
	});

	// ---------- corroboration above €500 (review MINOR #11) ----------

	it("refuses a large pair that has nothing but its shape going for it (regression: salary erased by rent)", () => {
		// €3,000 of salary into checking on the 1st and €3,000 of rent out of a second account on the 2nd
		// satisfy every clause of the shape test. Pairing them deleted the income AND the expense.
		const s = twoAccountStore([
			tx({ date: "2024-03-01", accountId: checking.id, amount: 3000, categoryId: catIncome.id, counterparty: "ACME PAYROLL" }),
			tx({ date: "2024-03-02", accountId: checking2.id, amount: -3000, categoryId: catFood.id, counterparty: "LANDLORD BV" }),
		]);
		expect(detectTransferPairs(s)).toHaveLength(0);
		const [year] = summarizeByYear(s);
		expect(year.income).toBe(3000);
		expect(year.expenses).toBe(3000);
	});

	it("keeps small uncorroborated pairs — the everyday move that carries no marker at all", () => {
		const s = twoAccountStore([
			tx({ date: "2024-03-01", accountId: checking.id, amount: -400 }),
			tx({ date: "2024-03-02", accountId: checking2.id, amount: 400 }),
		]);
		expect(detectTransferPairs(s)).toHaveLength(1);
	});

	it("accepts a large pair corroborated by a transfer category on either side", () => {
		const viaOut = twoAccountStore([
			tx({ date: "2024-03-01", accountId: checking.id, amount: -3000, categoryId: catTransfers.id }),
			tx({ date: "2024-03-02", accountId: checking2.id, amount: 3000 }),
		]);
		expect(detectTransferPairs(viaOut)).toHaveLength(1);

		const viaIn = twoAccountStore([
			tx({ date: "2024-03-01", accountId: checking.id, amount: -3000 }),
			tx({ date: "2024-03-02", accountId: checking2.id, amount: 3000, categoryId: catTransfers.id }),
		]);
		expect(detectTransferPairs(viaIn)).toHaveLength(1);
	});

	it("accepts a large pair with a savings or investing account on one side", () => {
		const s = store({
			accounts: [checking, savings],
			transactions: [
				tx({ date: "2024-03-01", accountId: checking.id, amount: -1500 }),
				tx({ date: "2024-03-01", accountId: savings.id, amount: 1500 }),
			],
		});
		expect(detectTransferPairs(s)).toHaveLength(1);
	});

	it("accepts a large pair whose text names the other account by name or IBAN", () => {
		const byName = twoAccountStore([
			tx({ date: "2024-03-01", accountId: checking.id, amount: -2500, counterparty: "Overboeking naar Joint" }),
			tx({ date: "2024-03-02", accountId: checking2.id, amount: 2500, counterparty: "SOMETHING ELSE" }),
		]);
		expect(detectTransferPairs(byName)).toHaveLength(1);

		const withIban: Account = { ...checking2, iban: "NL12INGB0001234567" };
		const byIban = store({
			accounts: [checking, withIban],
			transactions: [
				tx({ date: "2024-03-01", accountId: checking.id, amount: -2500, description: "SEPA naar NL12 INGB 0001 2345 67" }),
				tx({ date: "2024-03-02", accountId: withIban.id, amount: 2500 }),
			],
		});
		expect(detectTransferPairs(byIban)).toHaveLength(1);
	});

	it("ignores rows with no date or a zero amount", () => {
		const s = twoAccountStore([
			tx({ date: "", accountId: checking.id, amount: -100 }),
			tx({ date: "2024-01-10", accountId: checking2.id, amount: 100 }),
			tx({ date: "2024-01-10", accountId: checking.id, amount: 0 }),
			tx({ date: "2024-01-10", accountId: checking2.id, amount: 0 }),
		]);
		expect(detectTransferPairs(s)).toHaveLength(0);
	});
});

// ---------- windowSummary (P3) ----------

describe("windowSummary", () => {
	it("sums income and expenses over an inclusive date range", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-03-01", accountId: checking.id, amount: 1000, categoryId: catIncome.id }),
				tx({ date: "2024-03-31", accountId: checking.id, amount: -200, categoryId: catFood.id }),
				tx({ date: "2024-04-01", accountId: checking.id, amount: -999, categoryId: catFood.id }),
				tx({ date: "2024-02-29", accountId: checking.id, amount: -999, categoryId: catFood.id }),
			],
		});
		expect(windowSummary(s, "2024-03-01", "2024-03-31")).toMatchObject({
			income: 1000,
			expenses: 200,
			net: 800,
			txCount: 2,
		});
	});

	it("excludes transfers and counts only the rows behind the figures", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-03-01", accountId: checking.id, amount: 500, categoryId: catIncome.id }),
				tx({ date: "2024-03-02", accountId: checking.id, amount: -300, categoryId: catTransfers.id }),
			],
		});
		expect(windowSummary(s, "2024-03-01", "2024-03-31")).toMatchObject({ income: 500, expenses: 0, txCount: 1 });
	});

	it("tracks passive income and clamps savings rate like the year/month summaries", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-03-01", accountId: checking.id, amount: 20, type: "Interest" }),
				tx({ date: "2024-03-02", accountId: checking.id, amount: -500, categoryId: catFood.id }),
			],
		});
		const summary = windowSummary(s, "2024-03-01", "2024-03-31");
		expect(summary.passiveIncome).toBe(20);
		expect(summary.savingsRate).toBe(-1);
	});

	it("scopes to the given accounts", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-03-01", accountId: checking.id, amount: -100, categoryId: catFood.id }),
				tx({ date: "2024-03-01", accountId: savings.id, amount: -400, categoryId: catFood.id }),
			],
		});
		expect(windowSummary(s, "2024-03-01", "2024-03-31", [checking.id]).expenses).toBe(100);
	});
});

// ---------- monthKeys (P1) ----------

describe("monthKeys", () => {
	it("runs from the first transaction month through the current month with no gaps", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-20", accountId: checking.id, amount: -10 }),
				tx({ date: "2024-04-02", accountId: checking.id, amount: -10 }),
			],
		});
		expect(monthKeys(s, undefined, new Date(2024, 4, 10))).toEqual(["2024-01", "2024-02", "2024-03", "2024-04", "2024-05"]);
	});

	it("returns nothing when there are no dated transactions", () => {
		expect(monthKeys(store(), undefined, new Date(2024, 4, 10))).toEqual([]);
	});

	it("scopes the start month to the given accounts", () => {
		const s = store({
			transactions: [
				tx({ date: "2020-01-01", accountId: savings.id, amount: -10 }),
				tx({ date: "2024-03-01", accountId: checking.id, amount: -10 }),
			],
		});
		expect(monthKeys(s, [checking.id], new Date(2024, 3, 5))).toEqual(["2024-03", "2024-04"]);
	});
});

// ---------- balanceSeries (P2) ----------

describe("balanceSeries", () => {
	it("reports the closing balance of every month, carrying quiet months forward", () => {
		const s = store({
			accounts: [{ ...checking, openingBalance: 100 }],
			transactions: [
				tx({ date: "2024-01-15", accountId: checking.id, amount: 50 }),
				tx({ date: "2024-03-10", accountId: checking.id, amount: -20 }),
			],
		});
		expect(balanceSeries(s, undefined, "month", new Date(2024, 2, 20))).toEqual([
			{ key: "2024-01", balance: 150 },
			{ key: "2024-02", balance: 150 },
			{ key: "2024-03", balance: 130 },
		]);
	});

	it("produces a daily series for the overdraft/low-balance read", () => {
		const s = store({
			accounts: [{ ...checking, openingBalance: 0 }],
			transactions: [
				tx({ date: "2024-01-01", accountId: checking.id, amount: 100 }),
				tx({ date: "2024-01-03", accountId: checking.id, amount: -130 }),
			],
		});
		const series = balanceSeries(s, undefined, "day", new Date(2024, 0, 4));
		expect(series.map((p) => p.key)).toEqual(["2024-01-01", "2024-01-02", "2024-01-03", "2024-01-04"]);
		expect(series.map((p) => p.balance)).toEqual([100, 100, -30, -30]);
	});

	it("scopes both the opening balance and the transactions to the given accounts", () => {
		const s = store({
			accounts: [
				{ ...checking, openingBalance: 100 },
				{ ...savings, openingBalance: 9999 },
			],
			transactions: [
				tx({ date: "2024-01-15", accountId: checking.id, amount: 50 }),
				tx({ date: "2024-01-16", accountId: savings.id, amount: 5000 }),
			],
		});
		expect(balanceSeries(s, [checking.id], "month", new Date(2024, 0, 20))).toEqual([{ key: "2024-01", balance: 150 }]);
	});

	it("returns nothing when there are no transactions to anchor the range", () => {
		expect(balanceSeries(store(), undefined, "month", new Date(2024, 0, 20))).toEqual([]);
	});
});

// ---------- burnRate (P4) ----------

describe("burnRate", () => {
	it("averages over complete months only — the partial current month never dilutes it", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-05", accountId: checking.id, amount: -600, categoryId: catFood.id }),
				tx({ date: "2024-07-02", accountId: checking.id, amount: -999, categoryId: catFood.id }),
			],
		});
		// Jan–Jun is six complete months holding €600 of spend; July is still running and is excluded.
		expect(burnRate(s, undefined, 6, new Date(2024, 6, 10))).toBe(100);
	});

	it("counts zero-spend months in the denominator (unlike averageMonthlyExpenses)", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-05", accountId: checking.id, amount: -300, categoryId: catFood.id }),
				tx({ date: "2024-02-05", accountId: checking.id, amount: -300, categoryId: catFood.id }),
			],
		});
		// Jan and Feb hold €600; Mar–Jun are silent but real. 600/6 = 100, where the old helper said 300.
		expect(burnRate(s, undefined, 6, new Date(2024, 6, 10))).toBe(100);
		expect(averageMonthlyExpenses(s)).toBe(300);
	});

	it("clamps the window to the complete months actually available", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-05-05", accountId: checking.id, amount: -100, categoryId: catFood.id }),
				tx({ date: "2024-06-05", accountId: checking.id, amount: -300, categoryId: catFood.id }),
			],
		});
		expect(burnRate(s, undefined, 6, new Date(2024, 6, 10))).toBe(200);
	});

	it("returns 0 when no complete month has happened yet", () => {
		const s = store({ transactions: [tx({ date: "2024-07-05", accountId: checking.id, amount: -100 })] });
		expect(burnRate(s, undefined, 6, new Date(2024, 6, 10))).toBe(0);
	});

	it("returns 0 for an empty store", () => {
		expect(burnRate(store(), undefined, 6, new Date(2024, 6, 10))).toBe(0);
	});

	it("scopes to the given accounts", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-06-05", accountId: checking.id, amount: -600, categoryId: catFood.id }),
				tx({ date: "2024-06-05", accountId: savings.id, amount: -6000, categoryId: catFood.id }),
			],
		});
		// June is the only complete month either way, so the window is 1 month: €600 scoped vs €6,600 not.
		expect(burnRate(s, [checking.id], 6, new Date(2024, 6, 10))).toBe(600);
		expect(burnRate(s, undefined, 6, new Date(2024, 6, 10))).toBe(6600);
	});
});

// ---------- categorySpend (P7) ----------

describe("categorySpend", () => {
	it("accepts an explicit date range as well as a prefix", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-03-31", accountId: checking.id, amount: -10, categoryId: catFood.id }),
				tx({ date: "2024-04-01", accountId: checking.id, amount: -20, categoryId: catFood.id }),
				tx({ date: "2024-04-30", accountId: checking.id, amount: -30, categoryId: catFood.id }),
				tx({ date: "2024-05-01", accountId: checking.id, amount: -40, categoryId: catFood.id }),
			],
		});
		expect(categorySpend(s, { from: "2024-04-01", to: "2024-04-30" }).get(catFood.id)).toBe(50);
		expect(categorySpend(s, "2024-04").get(catFood.id)).toBe(50);
		expect(categorySpend(s, "2024").get(catFood.id)).toBe(100);
	});

	it("scopes to several accounts at once, which categoryTotals cannot", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-04-01", accountId: checking.id, amount: -10, categoryId: catFood.id }),
				tx({ date: "2024-04-01", accountId: savings.id, amount: -20, categoryId: catFood.id }),
				tx({ date: "2024-04-01", accountId: investing.id, amount: -40, categoryId: catFood.id }),
			],
		});
		expect(categorySpend(s, "2024-04", [checking.id, savings.id]).get(catFood.id)).toBe(30);
	});

	it("still excludes income and transfers and buckets uncategorized spend", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-04-01", accountId: checking.id, amount: 500, categoryId: catIncome.id }),
				tx({ date: "2024-04-02", accountId: checking.id, amount: -100, categoryId: catTransfers.id }),
				tx({ date: "2024-04-03", accountId: checking.id, amount: -15 }),
			],
		});
		const totals = categorySpend(s, "2024-04");
		expect(totals.get(catIncome.id)).toBeUndefined();
		expect(totals.get(catTransfers.id)).toBeUndefined();
		expect(totals.get("uncategorized")).toBe(15);
	});

	it("categoryTotals stays a working alias for the single-account, prefix case", () => {
		const s = store({ transactions: [tx({ date: "2024-04-01", accountId: checking.id, amount: -25, categoryId: catFood.id })] });
		expect(categoryTotals(s, "2024-04", checking.id).get(catFood.id)).toBe(25);
	});
});

// ---------- realized P/L (B3) ----------

describe("realizedPLByYear", () => {
	it("books proceeds minus the basis the sold shares carried", () => {
		const s = store({
			transactions: [
				tx({ date: "2024-01-01", accountId: investing.id, amount: -1000, action: "buy", ticker: "VWCE", shares: 10 }),
				tx({ date: "2024-06-01", accountId: investing.id, amount: 1000, action: "sell", ticker: "VWCE", shares: 5 }),
			],
		});
		expect(realizedPLByYear(s, investing.id)).toEqual([
			{ year: "2024", proceeds: 1000, costBasisSold: 500, realized: 500 },
		]);
	});

	it("includes positions that were closed entirely, which investingHoldings drops", () => {
		const s = store({
			transactions: [
				tx({ date: "2023-01-01", accountId: investing.id, amount: -100, action: "buy", ticker: "AAPL", shares: 1 }),
				tx({ date: "2024-02-01", accountId: investing.id, amount: 120, action: "sell", ticker: "AAPL", shares: 1 }),
			],
		});
		expect(investingHoldings(s, investing.id)).toHaveLength(0);
		expect(realizedPLByYear(s, investing.id)).toEqual([{ year: "2024", proceeds: 120, costBasisSold: 100, realized: 20 }]);
	});

	it("returns nothing when nothing was ever sold", () => {
		const s = store({
			transactions: [tx({ date: "2024-01-01", accountId: investing.id, amount: -100, action: "buy", ticker: "AAPL", shares: 1 })],
		});
		expect(realizedPLByYear(s, investing.id)).toEqual([]);
	});

	it("books nothing at all for a sale of a position it never saw bought (review MAJOR #3)", () => {
		// A transferred-in holding, or a ledger whose buy history predates the import. Against a €0 basis
		// the old walk reported the entire €5,000 of proceeds as realized profit.
		const s = store({
			transactions: [tx({ date: "2025-03-01", accountId: investing.id, amount: 5000, action: "sell", ticker: "VWCE", shares: 10 })],
		});
		expect(realizedPLByYear(s, investing.id)).toEqual([]);
	});
});

describe("fiProjection", () => {
	it("returns 0 when already at or past the target", () => {
		expect(fiProjection(100_000, 0, 0.07, 50_000)).toBe(0);
	});

	it("returns undefined for a non-positive target", () => {
		expect(fiProjection(1000, 500, 0.07, 0)).toBeUndefined();
	});

	it("returns undefined when there's neither contribution nor growth to ever reach the target", () => {
		expect(fiProjection(0, 0, 0, 100_000)).toBeUndefined();
	});

	it("returns a positive number of years when contributions alone can reach the target", () => {
		const years = fiProjection(0, 1000, 0, 12_000);
		expect(years).toBeCloseTo(1, 1);
	});
});

describe("quarterOf / shiftQuarter / quarterRange", () => {
	it("reads the calendar quarter of a date", () => {
		expect(quarterOf("2025-01-15")).toBe("2025-Q1");
		expect(quarterOf("2025-03-31")).toBe("2025-Q1");
		expect(quarterOf("2025-04-01")).toBe("2025-Q2");
		expect(quarterOf("2025-07-01")).toBe("2025-Q3");
		expect(quarterOf("2025-12-31")).toBe("2025-Q4");
	});

	it("shifts across quarter and year boundaries in both directions", () => {
		expect(shiftQuarter("2025-Q1", 1)).toBe("2025-Q2");
		expect(shiftQuarter("2025-Q4", 1)).toBe("2026-Q1");
		expect(shiftQuarter("2025-Q1", -1)).toBe("2024-Q4");
		expect(shiftQuarter("2025-Q3", -6)).toBe("2024-Q1");
		expect(shiftQuarter("2025-Q1", 0)).toBe("2025-Q1");
	});

	it("gives the inclusive first/last day of a quarter, respecting leap-year February", () => {
		expect(quarterRange("2025-Q1")).toEqual({ from: "2025-01-01", to: "2025-03-31" });
		expect(quarterRange("2024-Q1")).toEqual({ from: "2024-01-01", to: "2024-03-31" }); // leap year, Q1 unaffected by day count directly but exercises the boundary
		expect(quarterRange("2025-Q2")).toEqual({ from: "2025-04-01", to: "2025-06-30" });
		expect(quarterRange("2025-Q4")).toEqual({ from: "2025-10-01", to: "2025-12-31" });
	});
});

describe("isoWeekOf / shiftIsoWeek / isoWeekRange", () => {
	// Ground truth: Python's stdlib `datetime.date.fromisoformat(d).isocalendar()`, which correctly
	// implements ISO-8601 week numbering — cross-checked here rather than trusted blindly, since week
	// numbering has exactly the kind of year-boundary edge cases that silently ship wrong.
	it("matches ISO-8601 week numbers at known year-boundary edge cases", () => {
		expect(isoWeekOf("2025-01-01")).toBe("2025-W01"); // Wed — week 1 despite being Jan 1
		expect(isoWeekOf("2024-12-30")).toBe("2025-W01"); // Mon in Dec, but ISO week already 2025
		expect(isoWeekOf("2021-01-01")).toBe("2020-W53"); // Fri — still last week of 2020
		expect(isoWeekOf("2020-12-31")).toBe("2020-W53"); // 2020 is a 53-ISO-week year
		expect(isoWeekOf("2026-08-11")).toBe("2026-W33");
		expect(isoWeekOf("2025-12-29")).toBe("2026-W01"); // Mon in Dec, already next ISO year
		expect(isoWeekOf("2016-01-01")).toBe("2015-W53");
		expect(isoWeekOf("2017-01-01")).toBe("2016-W52");
	});

	it("shifts a week forward and backward across year boundaries", () => {
		expect(shiftIsoWeek("2025-W33", 1)).toBe("2025-W34");
		expect(shiftIsoWeek("2025-W33", -1)).toBe("2025-W32");
		// Crossing the 2024/2025 boundary: W1 2025 back one week must land on the last week of 2020's
		// analogue for 2024 — 2024-12-30 is in 2025-W01, so one week earlier is 2024-W52.
		expect(shiftIsoWeek("2025-W01", -1)).toBe("2024-W52");
		expect(shiftIsoWeek("2020-W53", 1)).toBe("2021-W01");
	});

	it("gives the inclusive Monday-Sunday bounds of an ISO week", () => {
		expect(isoWeekRange("2025-W01")).toEqual({ from: "2024-12-30", to: "2025-01-05" });
		expect(isoWeekRange("2026-W33")).toEqual({ from: "2026-08-10", to: "2026-08-16" });
		expect(isoWeekRange("2020-W53")).toEqual({ from: "2020-12-28", to: "2021-01-03" });
	});

	it("round-trips: every day of a week's range reports back that same ISO week", () => {
		for (const week of ["2025-W01", "2025-W33", "2020-W53", "2024-W52"]) {
			const { from, to } = isoWeekRange(week);
			expect(isoWeekOf(from)).toBe(week);
			expect(isoWeekOf(to)).toBe(week);
		}
	});
});

describe("category hierarchy", () => {
	const cats = [
		{ id: "food", name: "Food", color: "#f00", icon: "utensils", aliases: [] },
		{ id: "groceries", name: "Groceries", color: "#f00", icon: "shopping-cart", aliases: [], parentId: "food" },
		{ id: "restaurants", name: "Restaurants", color: "#f00", icon: "utensils", aliases: [], parentId: "food" },
		{ id: "transport", name: "Transport", color: "#00f", icon: "car", aliases: [] },
		{ id: "orphan", name: "Orphan", color: "#0f0", icon: "tag", aliases: [], parentId: "deleted-parent" },
	];

	it("groups children under their parent", () => {
		const children = categoryChildren(cats);
		expect(children.get("food")?.map((c) => c.id)).toEqual(["groceries", "restaurants"]);
		expect(children.has("transport")).toBe(false);
	});

	it("treats a subcategory whose parent no longer exists as top-level, not invisible", () => {
		expect(categoryChildren(cats).has("deleted-parent")).toBe(false);
		expect(topLevelCategories(cats).map((c) => c.id)).toEqual(["food", "transport", "orphan"]);
	});

	it("expands a parent to itself plus its children, and a leaf to just itself", () => {
		expect(categoryFamily(cats, "food")).toEqual(["food", "groceries", "restaurants"]);
		expect(categoryFamily(cats, "groceries")).toEqual(["groceries"]);
		expect(categoryFamily(cats, "transport")).toEqual(["transport"]);
	});

	it("folds child spend into the parent while keeping the breakdown", () => {
		const spend = new Map([["food", 10], ["groceries", 100], ["restaurants", 25], ["transport", 40]]);
		const rolled = rollUpCategorySpend(spend, cats);
		// Food keeps its own 10 (rows filed straight under the heading) plus both children.
		expect(rolled.get("food")).toBe(135);
		expect(rolled.get("groceries")).toBe(100);
		expect(rolled.get("restaurants")).toBe(25);
		expect(rolled.get("transport")).toBe(40);
	});

	it("gives a parent with no spend of its own the sum of its children", () => {
		const rolled = rollUpCategorySpend(new Map([["groceries", 60]]), cats);
		expect(rolled.get("food")).toBe(60);
	});

	it("leaves the input map untouched", () => {
		const spend = new Map([["groceries", 100]]);
		rollUpCategorySpend(spend, cats);
		expect(spend.has("food")).toBe(false);
		expect(spend.get("groceries")).toBe(100);
	});

	it("is a no-op on a flat category set — the pre-subcategory world still behaves identically", () => {
		const flat = [
			{ id: "a", name: "A", color: "#000", icon: "tag", aliases: [] },
			{ id: "b", name: "B", color: "#000", icon: "tag", aliases: [] },
		];
		const spend = new Map([["a", 5], ["b", 7]]);
		expect([...rollUpCategorySpend(spend, flat).entries()].sort()).toEqual([["a", 5], ["b", 7]]);
		expect(topLevelCategories(flat)).toHaveLength(2);
	});
});
