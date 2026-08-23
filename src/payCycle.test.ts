import { describe, it, expect } from "vitest";
import { currentPayCycle, derivePayCycles, describePayCycle, payCycleRange, salaryDates, shiftPayCycle } from "./payCycle";
import type { KpiStore } from "./kpi";
import type { Category, Transaction } from "./types";

const ACCOUNT_ID = "acc-checking";
const CAT_SALARY = "cat-salary";
const CAT_FOOD = "cat-food";

let nextId = 0;
function tx(date: string, amount: number, categoryId = CAT_SALARY, extra: Partial<Transaction> = {}): Transaction {
	nextId++;
	return { id: `tx-${nextId}`, date, accountId: ACCOUNT_ID, amount, currency: "EUR", categoryId, description: "test", source: "manual", ...extra };
}

function cat(overrides: Partial<Category> & { id: string }): Category {
	return { name: overrides.id, color: "#000", icon: "tag", aliases: [], ...overrides };
}

function store(transactions: Transaction[]): KpiStore {
	return {
		accounts: [{ id: ACCOUNT_ID, name: "Checking", type: "debit", currency: "EUR" }],
		categories: [cat({ id: CAT_SALARY, name: "Salary", kind: "income" }), cat({ id: CAT_FOOD, name: "Food" })],
		transactions,
	};
}

describe("salaryDates", () => {
	it("collects income dates for the given category, sorted", () => {
		const s = store([tx("2026-07-19", 3000), tx("2026-06-19", 3000), tx("2026-08-20", 3000)]);
		expect(salaryDates(s, CAT_SALARY)).toEqual(["2026-06-19", "2026-07-19", "2026-08-20"]);
	});

	it("ignores rows in other categories and non-income rows", () => {
		const s = store([tx("2026-06-19", 3000), tx("2026-06-20", -50, CAT_FOOD), tx("2026-06-25", -20, CAT_SALARY)]);
		// The -20 in the salary category is an outgoing row, not income, so it must not count as a payday.
		expect(salaryDates(s, CAT_SALARY)).toEqual(["2026-06-19"]);
	});

	it("collapses a bonus paid a few days after the main salary into one payday", () => {
		const s = store([tx("2026-06-19", 3000), tx("2026-06-24", 500), tx("2026-07-20", 3000)]);
		expect(salaryDates(s, CAT_SALARY, 20)).toEqual(["2026-06-19", "2026-07-20"]);
	});

	it("returns an empty list with no transactions at all", () => {
		expect(salaryDates(store([]), CAT_SALARY)).toEqual([]);
	});
});

describe("derivePayCycles", () => {
	it("returns nothing for an empty date list", () => {
		expect(derivePayCycles([])).toEqual([]);
	});

	it("closes every cycle but the last, ending the day before the next payday", () => {
		const cycles = derivePayCycles(["2026-06-19", "2026-07-20", "2026-08-19"]);
		expect(cycles[0]).toMatchObject({ key: "2026-06-19", start: "2026-06-19", end: "2026-07-19" });
		expect(cycles[1]).toMatchObject({ key: "2026-07-20", start: "2026-07-20", end: "2026-08-18" });
	});

	it("leaves the most recent cycle open, with a projected end from the recent average gap", () => {
		const cycles = derivePayCycles(["2026-06-19", "2026-07-20", "2026-08-19"]);
		const last = cycles[cycles.length - 1];
		expect(last.end).toBeUndefined();
		// gaps: 31, 30 -> average ~31 days from 2026-08-19
		expect(last.projectedEnd).toBe("2026-09-19");
	});

	it("projects a single known cycle's length using the default 30 days", () => {
		const cycles = derivePayCycles(["2026-08-19"]);
		expect(cycles[0].projectedEnd).toBe("2026-09-18");
	});
});

describe("currentPayCycle", () => {
	const cycles = derivePayCycles(["2026-06-19", "2026-07-20", "2026-08-19"]);

	it("picks the cycle whose start is on or before today", () => {
		expect(currentPayCycle(cycles, new Date(2026, 7, 25))?.key).toBe("2026-08-19");
		expect(currentPayCycle(cycles, new Date(2026, 6, 25))?.key).toBe("2026-07-20");
	});

	it("is undefined before the first known payday — nothing derivable yet", () => {
		expect(currentPayCycle(cycles, new Date(2026, 5, 1))).toBeUndefined();
	});
});

describe("shiftPayCycle", () => {
	const cycles = derivePayCycles(["2026-06-19", "2026-07-20", "2026-08-19"]);

	it("steps forward and backward through the derived list", () => {
		expect(shiftPayCycle(cycles, "2026-07-20", -1)?.key).toBe("2026-06-19");
		expect(shiftPayCycle(cycles, "2026-07-20", 1)?.key).toBe("2026-08-19");
	});

	it("is undefined past either end of what's known", () => {
		expect(shiftPayCycle(cycles, "2026-08-19", 1)).toBeUndefined();
		expect(shiftPayCycle(cycles, "2026-06-19", -1)).toBeUndefined();
	});
});

describe("payCycleRange", () => {
	it("is open-ended (empty `to`) for the current cycle", () => {
		const cycles = derivePayCycles(["2026-06-19", "2026-07-20"]);
		expect(payCycleRange(cycles[1])).toEqual({ from: "2026-07-20", to: "" });
	});

	it("is a closed range for a past cycle", () => {
		const cycles = derivePayCycles(["2026-06-19", "2026-07-20"]);
		expect(payCycleRange(cycles[0])).toEqual({ from: "2026-06-19", to: "2026-07-19" });
	});
});

describe("describePayCycle", () => {
	it("describes a closed cycle within one year", () => {
		const cycles = derivePayCycles(["2026-06-19", "2026-07-20"]);
		expect(describePayCycle(cycles[0])).toBe("19 Jun – 19 Jul 2026");
	});

	it("describes the open cycle as running to the present", () => {
		const cycles = derivePayCycles(["2026-08-19"]);
		expect(describePayCycle(cycles[0])).toBe("19 Aug 2026 – present");
	});

	it("includes both years when a closed cycle straddles new year's", () => {
		const cycles = derivePayCycles(["2025-12-19", "2026-01-19"]);
		expect(describePayCycle(cycles[0])).toBe("19 Dec 2025 – 18 Jan 2026");
	});
});
