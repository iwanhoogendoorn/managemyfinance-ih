import { CATEGORY_ALIAS_SEED } from "../constants";
import type { Category, CategoryRule, CategoryRuleMatch, Transaction } from "../types";

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

/** What a "contains" or regex rule is tested against: description and counterparty as one
 *  case-folded string. Unchanged, so every rule written before match modes existed still behaves
 *  exactly as it did. */
export function ruleHaystack(tx: Pick<Transaction, "description" | "counterparty">): string {
	return `${tx.description} ${tx.counterparty ?? ""}`.toLowerCase();
}

/**
 * The two whole-field modes compare against each field on its own rather than the joined haystack.
 * Joining makes "exact" meaningless — no single field ever equals "description counterparty" — and
 * would break "starts with" for any bank that puts the merchant in the counterparty and something
 * generic like "Card payment" in the description.
 */
function ruleFields(tx: Pick<Transaction, "description" | "counterparty">): string[] {
	return [tx.description ?? "", tx.counterparty ?? ""].map((v) => v.trim().toLowerCase()).filter((v) => v.length > 0);
}

/** A rule's effective mode: `match` when set, else the legacy `isRegex` flag, else "contains". */
export function resolveRuleMatch(rule: Pick<CategoryRule, "match" | "isRegex">): CategoryRuleMatch {
	return rule.match ?? (rule.isRegex ? "regex" : "contains");
}

/**
 * Does this one rule match this one transaction?
 *
 * Split out of `applyRules` so that previewing a rule before saving it and applying it afterwards
 * cannot disagree — the "this will move 42 transactions" count and the 42 rows that actually move are
 * now the same predicate rather than two hand-written copies of it. An unparseable regex matches
 * nothing rather than throwing, exactly as it did inline.
 */
export function ruleMatches(
	tx: Pick<Transaction, "description" | "counterparty">,
	rule: Pick<CategoryRule, "pattern" | "isRegex" | "match">
): boolean {
	// Ahead of every mode, regex included: an all-whitespace pattern is never deliberate, and each
	// mode would otherwise fail differently and only by accident of the text it was tested against.
	const needle = rule.pattern.trim().toLowerCase();
	if (!needle) return false;
	const mode = resolveRuleMatch(rule);

	if (mode === "regex") {
		try {
			return new RegExp(rule.pattern, "i").test(ruleHaystack(tx));
		} catch {
			return false;
		}
	}

	if (mode === "exact") return ruleFields(tx).some((field) => field === needle);
	if (mode === "starts-with") return ruleFields(tx).some((field) => field.startsWith(needle));
	return ruleHaystack(tx).includes(rule.pattern.toLowerCase());
}

/** Returns the first matching rule's category, or undefined if nothing matches (falls back to "needs review"). */
export function applyRules(tx: Transaction, rules: CategoryRule[]): string | undefined {
	for (const rule of rules) {
		if (ruleMatches(tx, rule)) return rule.categoryId;
	}
	return undefined;
}
