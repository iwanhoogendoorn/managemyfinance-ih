import { resolvePrimaryId } from "../categories";
import { classifyTransaction } from "../finance/semantics";
import { amountIn, scaledEconomicAmount } from "../kpi";
import { monthRange } from "../period";
import type { CategoryPeriodSpend, ForecastStore } from "./types";

/**
 * Turning the raw ledger into the one canonical monthly spend series every forecast method reads
 * from — built once per category, in a single pass over the transaction list, rather than each
 * method re-deriving its own version of "what did this category spend that month" (budget_spec.md
 * §12, §66).
 *
 * Deliberately monthly, always — a pay cycle's own irregular date range is reconciled against this
 * monthly series later, by prorating across the calendar-day overlap (§11), not by building a
 * second, pay-cycle-shaped history here. One canonical series, several ways of reading it.
 */

/** Every calendar month with at least one transaction anywhere in the ledger — regardless of
 *  category. This is the line between a real, trackable zero and an "unknown" gap: a month present
 *  here that a category had no matching spend in is a genuine €0 observation; a month absent here
 *  was never tracked at all; and the history builder must never manufacture a zero for the latter
 *  (§16) — a category that simply didn't exist yet is not the same fact as "spent nothing".
 */
export function trackedMonths(store: ForecastStore): Set<string> {
	const months = new Set<string>();
	for (const tx of store.transactions) {
		if (tx.date) months.add(tx.date.slice(0, 7));
	}
	return months;
}

/** Whether `tx` belongs to `categoryId` under this scope — "leaf" matches only that exact category
 *  id (so asking about one secondary never pulls in its siblings, or its primary's own direct
 *  spend); "rollup" matches that id *or* anything under it, via the same primary resolution
 *  `primaryCategoryTotals` already uses elsewhere in the app. */
function matchesScope(store: ForecastStore, categoryId: string, txCategoryId: string | undefined, scope: "leaf" | "rollup"): boolean {
	if (!txCategoryId) return false;
	if (scope === "leaf") return txCategoryId === categoryId;
	return resolvePrimaryId(store.categories, txCategoryId) === categoryId;
}

/**
 * One category's net economic spend for every tracked calendar month — expenses minus refunds,
 * transfers/trades/debt-principal/income excluded, converted at each transaction's own historical
 * FX rate. Exactly the same classification `categoryTotals`/`primaryCategoryTotals` already apply
 * (reused here via `classifyTransaction` + `scaledEconomicAmount`, not reimplemented — a forecast
 * must never reinterpret what counts as spending on its own).
 *
 * Returns one entry per tracked month, in chronological order — including months this category had
 * no matching activity in at all, reported as a real `economicExpense: 0` rather than omitted. Only
 * months absent from `trackedMonths` (nothing tracked anywhere in the ledger) are left out, since
 * those aren't observations of anything.
 *
 * Unbounded and unfiltered by design: how much of this a forecast method actually uses (the last 24
 * months for a trend, 10 years for a seasonal ratio, and so on) is each method's own decision — see
 * §45 — not something the canonical history should pre-decide.
 */
export function buildCategorySpendHistory(store: ForecastStore, categoryId: string, scope: "leaf" | "rollup"): CategoryPeriodSpend[] {
	const months = Array.from(trackedMonths(store)).sort();
	if (months.length === 0) return [];

	const byMonth = new Map<string, { expense: number; count: number }>();
	for (const tx of store.transactions) {
		if (!tx.date || !matchesScope(store, categoryId, tx.categoryId, scope)) continue;
		const classified = classifyTransaction(store, tx);
		if (classified.affectsExpense === 0) continue;
		const month = tx.date.slice(0, 7);
		const amount = scaledEconomicAmount(tx, classified.affectsExpense, amountIn(store, tx));
		const entry = byMonth.get(month) ?? { expense: 0, count: 0 };
		entry.expense += amount;
		entry.count += 1;
		byMonth.set(month, entry);
	}

	return months.map((key) => {
		const range = monthRange(key)!;
		const entry = byMonth.get(key);
		return { key, from: range.from, to: range.to, economicExpense: entry?.expense ?? 0, transactionCount: entry?.count ?? 0 };
	});
}
