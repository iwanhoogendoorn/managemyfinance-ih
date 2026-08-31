import { describe, expect, it } from "vitest";
import { applyRules, resolveRuleMatch, ruleMatches } from "./categorize";
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

describe("match modes", () => {
	it("defaults to contains for a rule written before modes existed", () => {
		expect(resolveRuleMatch({})).toBe("contains");
		expect(resolveRuleMatch({ isRegex: true })).toBe("regex");
		expect(resolveRuleMatch({ match: "exact", isRegex: true })).toBe("exact");
	});

	describe("exact", () => {
		it("separates two merchants whose names start the same way", () => {
			// The whole point: no substring can catch "Apple" without also catching "Apple Store".
			const rule = { pattern: "Apple", match: "exact" as const };
			expect(ruleMatches(tx("Apple"), rule)).toBe(true);
			expect(ruleMatches(tx("Apple Store"), rule)).toBe(false);
			expect(ruleMatches(tx("Apple Pay top-up by *4606"), rule)).toBe(false);
			expect(ruleMatches(tx("apple.com/bill"), rule)).toBe(false);
		});

		it("ignores case and surrounding whitespace", () => {
			expect(ruleMatches(tx("  APPLE  "), { pattern: "apple", match: "exact" })).toBe(true);
		});

		it("matches on the counterparty as its own field, not glued to the description", () => {
			// Against the joined haystack "card payment bck barbershop" nothing is ever exactly equal.
			expect(ruleMatches(tx("Card payment", "Bck Barbershop"), { pattern: "Bck Barbershop", match: "exact" })).toBe(true);
		});

		it("does not match a longer description that merely contains the pattern", () => {
			expect(ruleMatches(tx("Payment to Apple"), { pattern: "Apple", match: "exact" })).toBe(false);
		});
	});

	describe("starts-with", () => {
		it("covers every branch after the merchant name", () => {
			const rule = { pattern: "ALBERT HEIJN", match: "starts-with" as const };
			expect(ruleMatches(tx("ALBERT HEIJN 1423 DEN HAAG"), rule)).toBe(true);
			expect(ruleMatches(tx("ALBERT HEIJN 0891 UTRECHT"), rule)).toBe(true);
			expect(ruleMatches(tx("TO ALBERT HEIJN"), rule)).toBe(false);
		});

		it("still separates Apple from things that do not start with it", () => {
			const rule = { pattern: "Apple Store", match: "starts-with" as const };
			expect(ruleMatches(tx("Apple Store"), rule)).toBe(true);
			expect(ruleMatches(tx("Apple"), rule)).toBe(false);
		});

		it("reads the counterparty as its own field", () => {
			expect(ruleMatches(tx("Card payment", "Bck Barbershop 040"), { pattern: "Bck Barbershop", match: "starts-with" })).toBe(true);
		});
	});

	it("leaves contains behaving exactly as it always did", () => {
		const rule = { pattern: "apple", match: "contains" as const };
		expect(ruleMatches(tx("Apple Store"), rule)).toBe(true);
		expect(ruleMatches(tx("apple.com/bill"), rule)).toBe(true);
		// and the same rule written without a mode at all
		expect(ruleMatches(tx("Apple Store"), { pattern: "apple" })).toBe(true);
	});

	it("never matches on an empty or whitespace-only pattern in any mode", () => {
		// Tested against text that *would* satisfy a whitespace pattern, so this passes by the guard
		// rather than by accident of the sample not containing spaces.
		const spacey = tx("Apple    Store    Amsterdam", "Some   Counterparty");
		for (const match of ["contains", "exact", "starts-with", "regex"] as const) {
			expect(ruleMatches(spacey, { pattern: "", match })).toBe(false);
			expect(ruleMatches(spacey, { pattern: "   ", match })).toBe(false);
		}
	});
});
