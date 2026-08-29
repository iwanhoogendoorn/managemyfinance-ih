import { describe, expect, it } from "vitest";
import { defaultNonBudgetableReason, resolveDefaultMethod } from "./profiles";
import type { Category } from "../types";

function cat(overrides: Partial<Category> & { id: string; name: string }): Category {
	return { color: "#000", icon: "tag", aliases: [], ...overrides };
}

describe("resolveDefaultMethod", () => {
	it("resolves a default primary by name", () => {
		const categories = [cat({ id: "c1", name: "Food" })];
		expect(resolveDefaultMethod(categories, "c1")).toBe("seasonal-quantile");
	});

	it("matches case- and whitespace-insensitively", () => {
		const categories = [cat({ id: "c1", name: "  fOOD  " })];
		expect(resolveDefaultMethod(categories, "c1")).toBe("seasonal-quantile");
	});

	it("resolves Savings to policy-target, never an expense forecast off historical behavior (§6.21, §61)", () => {
		const categories = [cat({ id: "c1", name: "Savings" })];
		expect(resolveDefaultMethod(categories, "c1")).toBe("policy-target");
	});

	it("resolves Income to income-target, not ordinary expense P25/P50/P75 semantics (§6.13, §61)", () => {
		const categories = [cat({ id: "c1", name: "Income" })];
		expect(resolveDefaultMethod(categories, "c1")).toBe("income-target");
	});

	it("resolves a default secondary by its own name, under its primary", () => {
		const categories = [cat({ id: "primary", name: "Auto & Transport" }), cat({ id: "secondary", name: "Fuel", parentId: "primary" })];
		expect(resolveDefaultMethod(categories, "secondary")).toBe("seasonal-quantile");
	});

	it("inherits the primary's method when the spec deliberately lists a secondary without one", () => {
		// Insurance's secondaries (Health/Home/Life Insurance) are listed with no method column at all.
		const categories = [cat({ id: "primary", name: "Insurance" }), cat({ id: "secondary", name: "Health Insurance", parentId: "primary" })];
		expect(resolveDefaultMethod(categories, "secondary")).toBe("fixed-commitment");
	});

	it("routes a conditionally-switching category through adaptive-hybrid rather than a fixed method", () => {
		// Gifts: seasonal-quantile normally, sinking-fund if extremely sparse — handled by the adaptive
		// classifier itself rather than a bespoke per-category rule.
		const categories = [cat({ id: "c1", name: "Gifts" })];
		expect(resolveDefaultMethod(categories, "c1")).toBe("adaptive-hybrid");
	});

	it("is undefined for a category matching no default name at all", () => {
		const categories = [cat({ id: "c1", name: "My Custom Category" })];
		expect(resolveDefaultMethod(categories, "c1")).toBeUndefined();
	});

	it("is undefined for an unknown category id", () => {
		expect(resolveDefaultMethod([], "missing")).toBeUndefined();
	});
});

describe("defaultNonBudgetableReason", () => {
	it("carries the exact spec reason for Cash/ATM", () => {
		const categories = [cat({ id: "c1", name: "Cash/ATM" })];
		expect(defaultNonBudgetableReason(categories, "c1")).toMatch(/cash movements/i);
	});

	it("carries the exact spec reason for Transfers", () => {
		const categories = [cat({ id: "c1", name: "Transfers" })];
		expect(defaultNonBudgetableReason(categories, "c1")).toMatch(/movements between your own accounts/i);
	});

	it("is undefined for a budgetable category", () => {
		const categories = [cat({ id: "c1", name: "Food" })];
		expect(defaultNonBudgetableReason(categories, "c1")).toBeUndefined();
	});
});
