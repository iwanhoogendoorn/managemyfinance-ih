import { CATEGORY_ALIAS_SEED } from "../constants";
import type { Category, CategoryRule, Transaction } from "../types";

/**
 * Legacy aliases are applied first and real categories second, so that when a secondary category's
 * own name matches one of the built-in subcategory alias keys (e.g. a "Public Transport" secondary
 * vs. the `CATEGORY_ALIAS_SEED["public transport"]` entry, which points at the flat "Auto & Transport"
 * primary), the actual category wins and the match lands at the correct, more specific level.
 */
export function buildAliasLookup(categories: Category[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const [alias, name] of Object.entries(CATEGORY_ALIAS_SEED)) {
		const cat = categories.find((c) => c.name === name);
		if (cat) map.set(alias, cat.id);
	}
	for (const cat of categories) {
		map.set(cat.name.toLowerCase(), cat.id);
		for (const alias of cat.aliases) map.set(alias.toLowerCase(), cat.id);
	}
	return map;
}

/** What a rule is tested against: the description and the counterparty, as one case-folded string. */
export function ruleHaystack(tx: Pick<Transaction, "description" | "counterparty">): string {
	return `${tx.description} ${tx.counterparty ?? ""}`.toLowerCase();
}

/**
 * Does this one rule match this one transaction?
 *
 * Split out of `applyRules` so that previewing a rule before saving it and applying it afterwards
 * cannot disagree — the "this will move 42 transactions" count and the 42 rows that actually move are
 * now the same predicate rather than two hand-written copies of it. An unparseable regex matches
 * nothing rather than throwing, exactly as it did inline.
 */
export function ruleMatches(tx: Pick<Transaction, "description" | "counterparty">, rule: Pick<CategoryRule, "pattern" | "isRegex">): boolean {
	if (!rule.pattern) return false;
	const haystack = ruleHaystack(tx);
	if (rule.isRegex) {
		try {
			return new RegExp(rule.pattern, "i").test(haystack);
		} catch {
			return false;
		}
	}
	return haystack.includes(rule.pattern.toLowerCase());
}

/** Returns the first matching rule's category, or undefined if nothing matches (falls back to "needs review"). */
export function applyRules(tx: Transaction, rules: CategoryRule[]): string | undefined {
	for (const rule of rules) {
		if (ruleMatches(tx, rule)) return rule.categoryId;
	}
	return undefined;
}
