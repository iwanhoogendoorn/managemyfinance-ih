import { classifyTransaction, isEconomicallyNeutral, type ClassifyStore } from "./finance/semantics";
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
	/**
	 * Matching rows the rule would turn from a money movement into spending — the "Apple Pay top-up"
	 * problem described on `previewRule`. Always reported, whether or not they are being written: the
	 * caller needs the count to offer the opt-in, and a group that vanished the moment you opted in
	 * would leave no way to opt back out. Check `neutralIncluded` for which it is.
	 */
	protectedNeutral: Transaction[];
	/** True when `protectedNeutral` is also being written, i.e. the caller passed `includeNeutral`. */
	neutralIncluded: boolean;
	/** Every matching row, however it is classified above. */
	total: number;
}

export interface RulePreviewStore extends ClassifyStore {
	transactions: Transaction[];
}

/** Rows the rule will write to: the blanks it fills plus the rows it moves. Not `alreadyCorrect`,
 *  and never `protectedNeutral` — opting those in moves them into the buckets above instead. */
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
 * One class of row is held back regardless: a match the rule would flip from a money movement into
 * spending. A ledger of Apple purchases also contains "Apple Pay top-up by *1234" — money arriving
 * via a payment method that happens to share the merchant's name — and a pattern of "Apple" sweeps up
 * all 54 of them alongside the 204 real purchases. They are not mis-filed Apple charges to be
 * corrected; they are a different kind of row entirely.
 *
 * The test is deliberately "would this change flip it", not "is it a transfer": each match is
 * classified as it stands and again as it would stand under the new category, and it is protected
 * only when the first is economically neutral and the second is not. So a rule that files things
 * *into* Transfers or Savings moves them freely — nothing is being reclassified — and the rule needs
 * no list of category names of its own, deferring instead to the one classifier the whole plugin
 * shares. `includeNeutral` exists because it is a default, not a veto.
 *
 * An empty pattern or a missing target matches nothing rather than everything: `"".includes()` is
 * true for every string, so the guard is load-bearing, not defensive decoration.
 */
export function previewRule(
	store: RulePreviewStore,
	rule: Pick<CategoryRule, "pattern" | "isRegex">,
	targetCategoryId: string | undefined,
	opts: { includeNeutral?: boolean } = {}
): RulePreview {
	const includeNeutral = !!opts.includeNeutral;
	const preview: RulePreview = {
		alreadyCorrect: [],
		uncategorized: [],
		moving: new Map(),
		protectedNeutral: [],
		neutralIncluded: includeNeutral,
		total: 0,
	};
	if (!rule.pattern.trim() || !targetCategoryId) return preview;

	for (const tx of store.transactions) {
		if (!ruleMatches(tx, rule)) continue;
		preview.total++;

		if (tx.categoryId === targetCategoryId) {
			preview.alreadyCorrect.push(tx);
			continue;
		}

		if (wouldFlipToSpending(store, tx, targetCategoryId)) {
			preview.protectedNeutral.push(tx);
			if (!includeNeutral) continue;
		}

		if (!tx.categoryId) preview.uncategorized.push(tx);
		else {
			const bucket = preview.moving.get(tx.categoryId) ?? [];
			bucket.push(tx);
			preview.moving.set(tx.categoryId, bucket);
		}
	}
	return preview;
}

/** Neutral as it stands, not neutral under the proposed category — i.e. the rule would recast a
 *  movement between your own accounts as money you spent. */
function wouldFlipToSpending(store: ClassifyStore, tx: Transaction, targetCategoryId: string): boolean {
	if (!isEconomicallyNeutral(classifyTransaction(store, tx))) return false;
	return !isEconomicallyNeutral(classifyTransaction(store, { ...tx, categoryId: targetCategoryId }));
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

/**
 * The exact ledger writes a confirmed rule should make.
 *
 * Pure and exported so the destructive step can be tested without a vault: getting this wrong writes
 * to someone's ledger, and "it looked right in the dialog" is not evidence about what gets written.
 *
 * Three decisions live here. Only ticked rows are written — an unticked row keeps its category *and*
 * gets no stamp, because the badge means "this rule filed this row" and a row the rule was told to
 * skip would be lying about its own provenance. Rows already sitting in the target are stamped even
 * though their category doesn't move, so the badge describes every row the rule now governs rather
 * than only those that happened to change today. And a row already stamped by this same rule is left
 * out entirely, so re-confirming an unchanged rule is a no-op rather than a rewrite of every file it
 * touches.
 */
export function rulePatches(
	preview: RulePreview,
	excludedIds: ReadonlySet<string>,
	rule: Pick<CategoryRule, "id" | "categoryId">
): Map<string, Partial<Transaction>> {
	const patches = new Map<string, Partial<Transaction>>();
	for (const tx of changedByPreview(preview)) {
		if (excludedIds.has(tx.id)) continue;
		patches.set(tx.id, { categoryId: rule.categoryId, categoryRuleId: rule.id });
	}
	for (const tx of preview.alreadyCorrect) {
		if (tx.categoryRuleId === rule.id) continue;
		patches.set(tx.id, { categoryId: rule.categoryId, categoryRuleId: rule.id });
	}
	return patches;
}
