import { describe, expect, it } from "vitest";
import { changedByPreview, movingCount, previewRule, seedPatternFor } from "./rules";
import type { Transaction } from "./types";

let n = 0;
function tx(description: string, categoryId?: string): Transaction {
	n++;
	return { id: `tx-${n}`, date: "2026-01-0" + ((n % 9) + 1), accountId: "acc", description, amount: -10, currency: "EUR", source: "manual", categoryId };
}

describe("previewRule", () => {
	it("splits matches into fill, move and already-correct", () => {
		const rows = [
			tx("ALBERT HEIJN 1423 DEN HAAG"),
			tx("Albert Heijn 5567", "cat-shopping"),
			tx("albert heijn to go", "cat-groceries"),
			tx("JUMBO 88", "cat-groceries"),
		];
		const p = previewRule(rows, { pattern: "albert heijn" }, "cat-groceries");

		expect(p.total).toBe(3);
		expect(p.uncategorized).toHaveLength(1);
		expect(p.alreadyCorrect).toHaveLength(1);
		expect(movingCount(p)).toBe(1);
		expect(p.moving.get("cat-shopping")).toHaveLength(1);
		// The unrelated merchant is untouched.
		expect(changedByPreview(p).map((t) => t.description)).not.toContain("JUMBO 88");
	});

	it("groups movers by the category they are leaving", () => {
		const rows = [
			tx("Apple Store", "cat-shopping"),
			tx("Apple Store", "cat-shopping"),
			tx("APPLE.COM/BILL", "cat-subs"),
		];
		const p = previewRule(rows, { pattern: "apple" }, "cat-electronics");

		expect(movingCount(p)).toBe(3);
		expect(p.moving.get("cat-shopping")).toHaveLength(2);
		expect(p.moving.get("cat-subs")).toHaveLength(1);
	});

	it("matches nothing on an empty pattern rather than everything", () => {
		// "".includes() is true for every string, so without the guard an empty box would propose
		// re-filing the entire ledger.
		const rows = [tx("A"), tx("B"), tx("C")];
		const p = previewRule(rows, { pattern: "" }, "cat-x");
		expect(p.total).toBe(0);
		expect(changedByPreview(p)).toHaveLength(0);
	});

	it("matches nothing when no target category has been chosen yet", () => {
		const rows = [tx("Albert Heijn")];
		expect(previewRule(rows, { pattern: "albert" }, undefined).total).toBe(0);
	});

	it("counts a row already in the target as no change", () => {
		const rows = [tx("Netflix", "cat-ent"), tx("Netflix", "cat-ent")];
		const p = previewRule(rows, { pattern: "netflix" }, "cat-ent");
		expect(p.total).toBe(2);
		expect(changedByPreview(p)).toHaveLength(0);
		expect(p.alreadyCorrect).toHaveLength(2);
	});

	it("supports a regex pattern", () => {
		const rows = [tx("NS REIZIGERS"), tx("TRANSNS BV")];
		const p = previewRule(rows, { pattern: "^ns\\s", isRegex: true }, "cat-transport");
		expect(p.total).toBe(1);
	});

	it("treats a broken regex as matching nothing, so a half-typed pattern proposes no damage", () => {
		const rows = [tx("anything"), tx("else")];
		expect(previewRule(rows, { pattern: "([", isRegex: true }, "cat-x").total).toBe(0);
	});
});

describe("seedPatternFor", () => {
	/** The invariant: whatever we seed must match the row it was seeded from. */
	function seedMatchesItsOwnRow(description: string, counterparty?: string): boolean {
		const row = { description, counterparty };
		const seed = seedPatternFor(row);
		return previewRule([{ ...tx(description), description, counterparty }], { pattern: seed }, "cat-x").total === 1;
	}

	it("cuts at the branch number so the rule catches every branch", () => {
		expect(seedPatternFor({ description: "ALBERT HEIJN 1423 DEN HAAG" })).toBe("ALBERT HEIJN");
		expect(seedPatternFor({ description: "Bck Barbershop 040" })).toBe("Bck Barbershop");
	});

	it("never reduces a merchant to a bare city", () => {
		// merchantKey turns "H&M 0123 AMSTERDAM" into "amsterdam" — a rule that would file every
		// Amsterdam transaction in the ledger under H&M.
		expect(seedPatternFor({ description: "H&M 0123 AMSTERDAM" })).toBe("H&M");
	});

	it("keeps punctuation, since the rule is a raw substring test", () => {
		expect(seedPatternFor({ description: "ONLY&SONS" })).toBe("ONLY&SONS");
		expect(seedPatternFor({ description: "APPLE.COM/BILL" })).toBe("APPLE.COM/BILL");
	});

	it("leaves no dangling separator on the end of the pattern", () => {
		expect(seedPatternFor({ description: "TICKETS - 4412" })).toBe("TICKETS");
	});

	it("keeps a description that opens with a number whole rather than emptying it", () => {
		expect(seedPatternFor({ description: "998877665544 SOME SHOP" })).toBe("998877665544 SOME SHOP");
	});

	it("prefers the counterparty when there is one", () => {
		expect(seedPatternFor({ description: "Card payment", counterparty: "Bck Barbershop 040" })).toBe("Bck Barbershop");
	});

	it("still matches the row it came from when the merchant contains punctuation", () => {
		// merchantKey turns "ONLY&SONS" into "only sons", which is not a substring of "only&sons" —
		// seeding it would propose a rule that matches nothing, including the row you right-clicked.
		expect(seedMatchesItsOwnRow("ONLY&SONS")).toBe(true);
		expect(seedMatchesItsOwnRow("APPLE.COM/BILL")).toBe(true);
		expect(seedMatchesItsOwnRow("H&M 0123 AMSTERDAM")).toBe(true);
	});

	it("holds the invariant for plain merchant names too", () => {
		expect(seedMatchesItsOwnRow("ALBERT HEIJN 1423 DEN HAAG")).toBe(true);
		expect(seedMatchesItsOwnRow("Netflix")).toBe(true);
		expect(seedMatchesItsOwnRow("Card payment", "Bck Barbershop 040")).toBe(true);
	});

	it("falls back to the raw text when there is no usable merchant key", () => {
		expect(seedPatternFor({ description: "  Some Shop  " })).toBeTruthy();
		expect(seedMatchesItsOwnRow("998877665544")).toBe(true);
	});
});
