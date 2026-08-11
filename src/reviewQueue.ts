import { merchantKeysOverlap, merchantSourceText, normalizeMerchantKey } from "./recurring";
import type { Category, CategoryRule, Transaction } from "./types";

/**
 * The pure half of the bulk-categorization loop (import wizard step 3 and the Review Queue).
 *
 * Three decisions live here rather than in the modals that use them, because all three are the kind
 * of thing that is silently wrong rather than visibly broken:
 *
 *  1. **Grouping.** 312 uncategorized rows are ~23 merchants. The grouping key is
 *     `normalizeMerchantKey` — the *same* key the recurring detector uses — so a merchant the app
 *     calls one series here is one group there.
 *  2. **Rule patterns.** A rule the user asks for that then fails to fire is worse than no rule at
 *     all: the app claims to have learned something and hasn't. `deriveRulePattern` therefore
 *     verifies its candidate against the exact matching `applyRules` performs, and returns
 *     `undefined` rather than a pattern it cannot prove.
 *  3. **Category ranking.** Which nine categories get the number keys.
 *
 * No Obsidian imports — same contract as `kpi.ts` / `budgets.ts`, so it is unit-testable.
 */

// ---------- grouping ----------

export interface MerchantGroup {
	/** `normalizeMerchantKey` of the counterparty (or description) — the id of the group. */
	key: string;
	/** The rawest readable label: the most recent member's counterparty/description, untouched. */
	displayName: string;
	transactions: Transaction[];
	/** Sum of the members' magnitudes. Always positive — direction is not what this number is for. */
	total: number;
	firstSeen: string;
	lastSeen: string;
	/** The account most of this group's rows landed in — what "most-used in this account" ranks against. */
	dominantAccountId: string;
}

function modeOf(values: string[]): string {
	const counts = new Map<string, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	let best = "";
	let bestCount = -1;
	for (const [value, count] of counts) {
		if (count > bestCount || (count === bestCount && value < best)) {
			best = value;
			bestCount = count;
		}
	}
	return best;
}

/**
 * Groups transactions by merchant, biggest group first.
 *
 * Rows whose merchant text normalizes to nothing at all are dropped rather than collapsed into one
 * bogus "" mega-group — a group nobody can name is a group nobody can categorize confidently.
 */
export function groupByMerchant(transactions: Transaction[]): MerchantGroup[] {
	const buckets = new Map<string, Transaction[]>();
	for (const tx of transactions) {
		const key = normalizeMerchantKey(merchantSourceText(tx));
		if (!key) continue;
		const bucket = buckets.get(key);
		if (bucket) bucket.push(tx);
		else buckets.set(key, [tx]);
	}

	const groups: MerchantGroup[] = [];
	for (const [key, txs] of buckets) {
		const sorted = [...txs].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
		const newest = sorted[sorted.length - 1];
		groups.push({
			key,
			displayName: merchantSourceText(newest) || key,
			transactions: sorted,
			total: sorted.reduce((sum, t) => sum + Math.abs(t.amount || 0), 0),
			firstSeen: sorted[0].date ?? "",
			lastSeen: newest.date ?? "",
			dominantAccountId: modeOf(sorted.map((t) => t.accountId)),
		});
	}

	return sortGroups(groups, "count");
}

export type GroupSort = "count" | "amount";

/** Count-desc (the default queue order) or amount-desc, ties broken by key so the order is stable
 *  across renders — a queue that reshuffles itself between keystrokes is unusable. */
export function sortGroups(groups: MerchantGroup[], by: GroupSort): MerchantGroup[] {
	return [...groups].sort((a, b) => {
		const primary = by === "amount" ? b.total - a.total : b.transactions.length - a.transactions.length;
		if (primary !== 0) return primary;
		const secondary = by === "amount" ? b.transactions.length - a.transactions.length : b.total - a.total;
		if (secondary !== 0) return secondary;
		return a.key.localeCompare(b.key);
	});
}

// ---------- rule patterns ----------

/** Exactly what `applyRules` matches against, so a pattern verified here fires there. */
function haystackOf(tx: Transaction): string {
	return `${tx.description ?? ""} ${tx.counterparty ?? ""}`.toLowerCase();
}

/** Shortest pattern worth writing a rule for. Two characters would match half the ledger. */
const MIN_PATTERN_LENGTH = 4;

function longestCommonPrefix(values: string[]): string {
	if (values.length === 0) return "";
	let prefix = values[0];
	for (const value of values.slice(1)) {
		let i = 0;
		while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++;
		prefix = prefix.slice(0, i);
		if (!prefix) break;
	}
	return prefix;
}

/**
 * A substring rule pattern that provably fires on every transaction in the group, or `undefined`.
 *
 * The normalized merchant key is tried first because it is the most readable ("albert heijn" for
 * "ALBERT HEIJN 1234"), but normalization flattens punctuation — "H&M ONLINE" normalizes to
 * "h m online", which is *not* a substring of its own description. So the candidate is verified
 * against the real haystack, and only then falls back to the literal text every member shares.
 */
export function deriveRulePattern(transactions: Transaction[]): string | undefined {
	if (transactions.length === 0) return undefined;
	const haystacks = transactions.map(haystackOf);
	const fires = (candidate: string): boolean => candidate.length >= MIN_PATTERN_LENGTH && haystacks.every((h) => h.includes(candidate));

	const key = normalizeMerchantKey(merchantSourceText(transactions[0]));
	if (fires(key)) return key;

	// Bank text is "<MERCHANT> <branch/reference>" far more often than not, so what the rows share is
	// a prefix of the merchant text. A prefix cut mid-word ("albert hei") is pulled back to the last
	// word boundary — it would still fire, but it reads as a typo and would also match a merchant
	// that merely starts the same way.
	const merchantTexts = transactions.map((t) => merchantSourceText(t).toLowerCase());
	let prefix = longestCommonPrefix(merchantTexts);
	const cutMidWord = merchantTexts.some((t) => t.length > prefix.length && !/\s/.test(t[prefix.length]));
	if (cutMidWord) prefix = prefix.slice(0, prefix.lastIndexOf(" ") + 1);
	const candidate = prefix.trim();
	return fires(candidate) ? candidate : undefined;
}

/**
 * Readable, slug-safe id for a user-created rule, made unique by a short random suffix.
 *
 * It used to be purely derived from the pattern, so two rules for the same merchant shared an id —
 * and undo, which removes the rule it created *by id*, would take a pre-existing rule with the same
 * pattern out with it. Duplicate rules are prevented where they are created (both call sites check
 * pattern + category against `store.rules` before pushing), which is the right place for it: the id's
 * job is to identify one rule object, not to deduplicate.
 */
export function userRuleId(pattern: string): string {
	const slug = pattern.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
	return `rule-user-${slug}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildUserRule(pattern: string, categoryId: string): CategoryRule {
	return { id: userRuleId(pattern), pattern, categoryId };
}

/** How many *other* transactions a proposed pattern would also swallow — shown before the rule is
 *  created, because "this also re-tags 400 rows you already sorted" is not a surprise anyone wants. */
export function ruleReach(pattern: string, transactions: Transaction[]): number {
	const needle = pattern.toLowerCase();
	return transactions.filter((tx) => haystackOf(tx).includes(needle)).length;
}

// ---------- category ranking ----------

export interface RankOptions {
	/** The merchant being categorized — its key drives the shared-token tier. */
	merchantKey: string;
	/** The account its rows landed in — drives the "most used in this account" tier. */
	accountId?: string;
	/** Every transaction in the portfolio; only the already-categorized ones contribute. */
	transactions: Transaction[];
	categories: Category[];
	limit?: number;
}

/**
 * The categories that get the number keys, best guess first.
 *
 * Three tiers, in order: categories already used for merchants sharing a token with this one (a
 * "gymshark hq" purchase should offer whatever "gymshark" was filed under), then the categories most
 * used in this account, then the globally most-used. Ties break alphabetically so the same merchant
 * always shows the same nine keys in the same order — muscle memory is the entire point of a
 * numbered list, and a list that reorders itself is worse than an unranked one.
 *
 * The result is padded with the remaining categories alphabetically, so the list is always `limit`
 * long on a fresh install where nothing has been categorized yet.
 */
export function rankCategories(opts: RankOptions): Category[] {
	const limit = opts.limit ?? 9;
	const archived = new Set(opts.categories.filter((c) => c.archived).map((c) => c.id));
	const byId = new Map(opts.categories.filter((c) => !archived.has(c.id)).map((c) => [c.id, c]));

	const sharedToken = new Map<string, number>();
	const inAccount = new Map<string, number>();
	const global = new Map<string, number>();

	for (const tx of opts.transactions) {
		const categoryId = tx.categoryId;
		if (!categoryId || !byId.has(categoryId)) continue;
		global.set(categoryId, (global.get(categoryId) ?? 0) + 1);
		if (opts.accountId && tx.accountId === opts.accountId) inAccount.set(categoryId, (inAccount.get(categoryId) ?? 0) + 1);
		const key = normalizeMerchantKey(merchantSourceText(tx));
		if (key && key !== opts.merchantKey && merchantKeysOverlap(key, opts.merchantKey)) {
			sharedToken.set(categoryId, (sharedToken.get(categoryId) ?? 0) + 1);
		}
	}

	const tierOf = (id: string): number => (sharedToken.has(id) ? 0 : inAccount.has(id) ? 1 : global.has(id) ? 2 : 3);
	const countOf = (id: string): number => sharedToken.get(id) ?? inAccount.get(id) ?? global.get(id) ?? 0;

	const ranked = [...byId.values()].sort((a, b) => {
		const tier = tierOf(a.id) - tierOf(b.id);
		if (tier !== 0) return tier;
		const count = countOf(b.id) - countOf(a.id);
		if (count !== 0) return count;
		return a.name.localeCompare(b.name);
	});

	return ranked.slice(0, limit);
}
