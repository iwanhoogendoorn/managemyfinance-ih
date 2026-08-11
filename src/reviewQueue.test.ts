import { describe, expect, it } from "vitest";
import { applyRules } from "./import/categorize";
import { buildUserRule, deriveRulePattern, groupByMerchant, rankCategories, ruleReach, sortGroups, userRuleId } from "./reviewQueue";
import type { Category, Transaction } from "./types";

let seq = 0;
function tx(partial: Partial<Transaction> & { description: string }): Transaction {
	return {
		id: `tx-${++seq}`,
		date: "2026-01-15",
		accountId: "acc-1",
		amount: -10,
		currency: "EUR",
		source: "ing",
		...partial,
	} as Transaction;
}

function cat(id: string, name: string): Category {
	return { id, name, color: "#000", icon: "circle", aliases: [] };
}

describe("groupByMerchant", () => {
	it("collapses branch numbers and processor prefixes into one group", () => {
		const groups = groupByMerchant([
			tx({ description: "ALBERT HEIJN 1234", counterparty: "ALBERT HEIJN 1234", date: "2026-01-01", amount: -20 }),
			tx({ description: "ALBERT HEIJN 5567", counterparty: "ALBERT HEIJN 5567", date: "2026-02-01", amount: -30 }),
			tx({ description: "SUMUP *CAFE DE SPORT", counterparty: "SUMUP *CAFE DE SPORT", date: "2026-01-20", amount: -14.5 }),
		]);

		expect(groups.map((g) => g.key)).toEqual(["albert heijn", "cafe de sport"]);
		expect(groups[0].transactions).toHaveLength(2);
		expect(groups[0].total).toBe(50);
		expect(groups[0].firstSeen).toBe("2026-01-01");
		expect(groups[0].lastSeen).toBe("2026-02-01");
		expect(groups[0].displayName).toBe("ALBERT HEIJN 5567");
	});

	it("drops rows whose merchant text normalizes to nothing rather than making a bogus group", () => {
		expect(groupByMerchant([tx({ description: "   ", counterparty: "" })])).toEqual([]);
	});

	it("picks the account most of the group's rows landed in", () => {
		const [group] = groupByMerchant([
			tx({ description: "SPOTIFY", accountId: "acc-2" }),
			tx({ description: "SPOTIFY", accountId: "acc-1" }),
			tx({ description: "SPOTIFY", accountId: "acc-1" }),
		]);
		expect(group.dominantAccountId).toBe("acc-1");
	});

	it("orders by count desc, then amount, then key — stable across renders", () => {
		const groups = groupByMerchant([
			tx({ description: "BIG SPEND", amount: -900 }),
			tx({ description: "SMALL A", amount: -1 }),
			tx({ description: "SMALL A", amount: -1 }),
		]);
		expect(groups.map((g) => g.key)).toEqual(["small a", "big spend"]);
		expect(sortGroups(groups, "amount").map((g) => g.key)).toEqual(["big spend", "small a"]);
	});
});

describe("deriveRulePattern", () => {
	/** The whole contract: whatever this returns must actually fire in applyRules. */
	function firesOnAll(transactions: Transaction[], categoryId = "cat-food"): boolean {
		const pattern = deriveRulePattern(transactions);
		if (!pattern) return false;
		const rules = [buildUserRule(pattern, categoryId)];
		return transactions.every((t) => applyRules(t, rules) === categoryId);
	}

	it("uses the readable normalized key when it really is a substring", () => {
		const txs = [
			tx({ description: "ALBERT HEIJN 1234 DEN HAAG", counterparty: "ALBERT HEIJN 1234" }),
			tx({ description: "ALBERT HEIJN 5567 UTRECHT", counterparty: "ALBERT HEIJN 5567" }),
		];
		expect(deriveRulePattern(txs)).toBe("albert heijn");
		expect(firesOnAll(txs)).toBe(true);
	});

	it("falls back to shared literal text when normalization flattened punctuation", () => {
		// "H&M ONLINE" normalizes to "h m online", which is not a substring of its own description.
		const txs = [tx({ description: "H&M ONLINE STORE 12", counterparty: "H&M ONLINE" }), tx({ description: "H&M ONLINE STORE 44", counterparty: "H&M ONLINE" })];
		const pattern = deriveRulePattern(txs);
		expect(pattern).toBe("h&m online");
		expect(firesOnAll(txs)).toBe(true);
	});

	it("survives a processor prefix that only some rows carry", () => {
		const txs = [
			tx({ description: "SUMUP *CAFE DE SPORT DEN HAAG", counterparty: "SUMUP *CAFE DE SPORT" }),
			tx({ description: "CAFE DE SPORT DEN HAAG", counterparty: "CAFE DE SPORT" }),
		];
		expect(deriveRulePattern(txs)).toBe("cafe de sport");
		expect(firesOnAll(txs)).toBe(true);
	});

	it("returns undefined rather than a pattern too short to trust", () => {
		expect(deriveRulePattern([tx({ description: "AB", counterparty: "AB" })])).toBeUndefined();
		expect(deriveRulePattern([])).toBeUndefined();
	});

	it("returns undefined when the rows share nothing usable", () => {
		expect(deriveRulePattern([tx({ description: "ZALANDO", counterparty: "ZALANDO" }), tx({ description: "NETFLIX", counterparty: "NETFLIX" })])).toBeUndefined();
	});

	it("never cuts a pattern mid-word", () => {
		const pattern = deriveRulePattern([
			tx({ description: "GYMSHARK LIMITED", counterparty: "GYMSHARK LIMITED" }),
			tx({ description: "GYMSHARK LIMOUSINE", counterparty: "GYMSHARK LIMOUSINE" }),
		]);
		expect(pattern).toBe("gymshark");
	});
});

describe("userRuleId", () => {
	it("is slug-safe and readable", () => {
		expect(userRuleId("h&m online")).toMatch(/^rule-user-h-m-online-[a-z0-9]+$/);
	});

	it("is unique per rule, so undoing one rule never removes another with the same pattern", () => {
		const mine = buildUserRule("albert heijn", "cat-food");
		const theirs = buildUserRule("albert heijn", "cat-food");
		expect(mine.id).not.toBe(theirs.id);

		// Exactly what ReviewQueueModal.undo() does with the rule it created.
		const rules = [theirs, mine];
		expect(rules.filter((r) => r.id !== mine.id)).toEqual([theirs]);
	});
});

describe("ruleReach", () => {
	it("counts every transaction the pattern would also match, not just the group's", () => {
		const all = [
			tx({ description: "ALBERT HEIJN 1", counterparty: "ALBERT HEIJN 1" }),
			tx({ description: "ALBERT HEIJN 2", counterparty: "ALBERT HEIJN 2" }),
			tx({ description: "JUMBO", counterparty: "JUMBO" }),
		];
		expect(ruleReach("albert heijn", all)).toBe(2);
	});
});

describe("rankCategories", () => {
	const categories = [cat("cat-food", "Food"), cat("cat-shop", "Shopping"), cat("cat-auto", "Auto"), cat("cat-fun", "Entertainment")];

	it("puts categories used by token-sharing merchants first", () => {
		const ranked = rankCategories({
			merchantKey: "gymshark hq",
			accountId: "acc-1",
			categories,
			transactions: [
				tx({ description: "GYMSHARK", counterparty: "GYMSHARK", categoryId: "cat-shop" }),
				tx({ description: "JUMBO", counterparty: "JUMBO", categoryId: "cat-food" }),
				tx({ description: "JUMBO", counterparty: "JUMBO", categoryId: "cat-food" }),
				tx({ description: "JUMBO", counterparty: "JUMBO", categoryId: "cat-food" }),
			],
			limit: 2,
		});
		// Food is used 3× and Shopping once, but Shopping is what the token-sharing merchant uses.
		expect(ranked.map((c) => c.id)).toEqual(["cat-shop", "cat-food"]);
	});

	it("prefers the account's own most-used over the global most-used", () => {
		const ranked = rankCategories({
			merchantKey: "unknown merchant",
			accountId: "acc-2",
			categories,
			transactions: [
				tx({ description: "X", counterparty: "X", accountId: "acc-2", categoryId: "cat-auto" }),
				tx({ description: "Y", counterparty: "Y", accountId: "acc-1", categoryId: "cat-food" }),
				tx({ description: "Y", counterparty: "Y", accountId: "acc-1", categoryId: "cat-food" }),
			],
			limit: 2,
		});
		expect(ranked.map((c) => c.id)).toEqual(["cat-auto", "cat-food"]);
	});

	it("pads alphabetically so a fresh install still gets a full numbered list", () => {
		const ranked = rankCategories({ merchantKey: "anything", categories, transactions: [], limit: 9 });
		expect(ranked.map((c) => c.name)).toEqual(["Auto", "Entertainment", "Food", "Shopping"]);
	});

	it("never offers an archived category", () => {
		const withArchived = [...categories, { ...cat("cat-old", "Archived"), archived: true }];
		const ranked = rankCategories({ merchantKey: "anything", categories: withArchived, transactions: [] });
		expect(ranked.some((c) => c.id === "cat-old")).toBe(false);
	});
});
