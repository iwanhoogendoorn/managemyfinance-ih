import { describe, expect, it } from "vitest";
import { applyRules, ruleMatches } from "./categorize";
import type { CategoryRule, Transaction } from "../types";

function tx(description: string, counterparty?: string): Transaction {
	return { id: "t1", date: "2026-01-01", accountId: "acc", description, counterparty, amount: -10, currency: "EUR", source: "manual" };
}

describe("ruleMatches", () => {
	it("matches a substring of the description, case-insensitively", () => {
		expect(ruleMatches(tx("ALBERT HEIJN 1423 DEN HAAG"), { pattern: "albert heijn" })).toBe(true);
	});

	it("matches against the counterparty as well as the description", () => {
		expect(ruleMatches(tx("Card payment", "Bck Barbershop 040"), { pattern: "barbershop" })).toBe(true);
	});

	it("does not match an unrelated merchant", () => {
		expect(ruleMatches(tx("ALBERT HEIJN 1423"), { pattern: "jumbo" })).toBe(false);
	});

	it("honours a regular expression when asked to", () => {
		expect(ruleMatches(tx("NS REIZIGERS 4412"), { pattern: "^ns\\s", isRegex: true })).toBe(true);
		expect(ruleMatches(tx("TRANSNS LTD"), { pattern: "^ns\\s", isRegex: true })).toBe(false);
	});

	it("treats an unparseable regex as matching nothing rather than throwing", () => {
		expect(() => ruleMatches(tx("anything"), { pattern: "([", isRegex: true })).not.toThrow();
		expect(ruleMatches(tx("anything"), { pattern: "([", isRegex: true })).toBe(false);
	});

	it("never matches on an empty pattern — an empty substring otherwise matches every row", () => {
		expect(ruleMatches(tx("ALBERT HEIJN"), { pattern: "" })).toBe(false);
	});

	it("is the same predicate applyRules uses, so a preview cannot disagree with the apply", () => {
		const rules: CategoryRule[] = [
			{ id: "r1", pattern: "jumbo", categoryId: "cat-groceries" },
			{ id: "r2", pattern: "albert heijn", categoryId: "cat-supermarket" },
		];
		const row = tx("ALBERT HEIJN 1423 DEN HAAG");
		expect(applyRules(row, rules)).toBe("cat-supermarket");
		expect(rules.filter((r) => ruleMatches(row, r)).map((r) => r.id)).toEqual(["r2"]);
	});

	it("returns the first matching rule, so a newly-created rule placed on top wins", () => {
		const rules: CategoryRule[] = [
			{ id: "new", pattern: "albert heijn", categoryId: "cat-new" },
			{ id: "old", pattern: "albert", categoryId: "cat-old" },
		];
		expect(applyRules(tx("Albert Heijn"), rules)).toBe("cat-new");
	});
});
