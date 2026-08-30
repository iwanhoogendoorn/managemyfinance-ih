import { ruleMatches } from "./import/categorize";
import type { CategoryRule, Transaction } from "./types";

/**
 * What a rule would do to the ledger, grouped by where each matching row currently sits.
 *
 * Separate from the dialog that shows it so the count and the change cannot drift apart: the same
 * function produces the "42 will move" line and, moments later, the list of rows that actually move.
 * A preview computed by one code path and applied by another is a preview you cannot trust, and this
 * is a feature whose entire safety argument rests on the preview being right.
 */
export interface RulePreview {
	/** Matching rows already filed where the rule wants them — no change, but the rule now owns them. */
	alreadyCorrect: Transaction[];
	/** Matching rows with no category at all. The rule fills these in. */
	uncategorized: Transaction[];
	/** Matching rows filed elsewhere, which the rule will move, keyed by their current category id. */
	moving: Map<string, Transaction[]>;
	/** Every matching row, however it is classified above. */
	total: number;
}

/** Rows the rule will write to: the blanks it fills plus the rows it moves. Not `alreadyCorrect`. */
export function changedByPreview(preview: RulePreview): Transaction[] {
	return [...preview.uncategorized, ...Array.from(preview.moving.values()).flat()];
}

export function movingCount(preview: RulePreview): number {
	return Array.from(preview.moving.values()).reduce((n, rows) => n + rows.length, 0);
}

/**
 * Unlike the import-time rule pass — which deliberately touches only uncategorized rows — this
 * reports on *every* match, including rows that already carry a different category. Filing the
 * stragglers consistently is the whole point of creating a rule from a transaction you are looking
 * at, and the caller is expected to show `moving` in full before writing anything.
 *
 * An empty pattern or a missing target matches nothing rather than everything: `"".includes()` is
 * true for every string, so the guard is load-bearing, not defensive decoration.
 */
export function previewRule(
	transactions: Transaction[],
	rule: Pick<CategoryRule, "pattern" | "isRegex">,
	targetCategoryId: string | undefined
): RulePreview {
	const preview: RulePreview = { alreadyCorrect: [], uncategorized: [], moving: new Map(), total: 0 };
	if (!rule.pattern.trim() || !targetCategoryId) return preview;

	for (const tx of transactions) {
		if (!ruleMatches(tx, rule)) continue;
		preview.total++;
		if (!tx.categoryId) preview.uncategorized.push(tx);
		else if (tx.categoryId === targetCategoryId) preview.alreadyCorrect.push(tx);
		else {
			const bucket = preview.moving.get(tx.categoryId) ?? [];
			bucket.push(tx);
			preview.moving.set(tx.categoryId, bucket);
		}
	}
	return preview;
}

/**
 * The pattern to offer when creating a rule from one transaction.
 *
 * A branch number is what stops a merchant's rows looking alike — "ALBERT HEIJN 1423 DEN HAAG" and
 * "ALBERT HEIJN 0891 UTRECHT" are the same shop — so the seed is the description up to its first
 * numeric token: "ALBERT HEIJN". Everything after it is branch, city, date or reference.
 *
 * Deliberately *not* `merchantKey`, despite that being the plugin's own idea of a merchant's
 * identity. That key exists for grouping, where both sides are normalised before they meet, so it is
 * free to rewrite the text — it lowercases, folds punctuation to spaces and drops short tokens. A
 * non-regex rule is a raw substring test against the original description, and a rewritten key is not
 * generally a substring of what it came from: "ONLY&SONS" keys to "only sons", which never appears in
 * "only&sons", and "H&M 0123 AMSTERDAM" keys to "amsterdam", which would file every Amsterdam
 * transaction in the ledger under H&M. Cutting a prefix on whitespace can do neither, because the
 * result is a substring of the original by construction.
 *
 * The trailing trim keeps a dangling separator out of the pattern ("TICKETS - 4412" → "TICKETS", not
 * "TICKETS -"), and a description that opens with a number is kept whole rather than reduced to "".
 */
export function seedPatternFor(tx: Pick<Transaction, "description" | "counterparty">): string {
	const raw = tx.counterparty?.trim() || tx.description.trim();
	const words = raw.split(/\s+/);
	const firstNumeric = words.findIndex((w) => /\d/.test(w));
	const head = (firstNumeric > 0 ? words.slice(0, firstNumeric) : words).join(" ");
	return head.replace(/[\s\-\u2013\u2014,;:.]+$/, "").trim() || raw;
}
