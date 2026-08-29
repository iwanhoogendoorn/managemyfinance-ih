import { convert } from "../currency";
import { amountIn } from "../kpi";
import type { DateRange } from "../period";
import { addCycleIso, merchantKeysOverlap, normalizeMerchantKey, recurringSeries, type RecurringCycle, type RecurringSeries } from "../recurring";
import { isActive, subCurrency, subscriptionPattern } from "../subscriptions";
import type { Transaction } from "../types";
import type { CategoryPeriodSpend, ForecastCommitment, ForecastStore } from "./types";

/**
 * Step 2 (budget_spec.md §13) — known future costs for one category, so a forecast can start from
 * "the user has already committed to spending €X on this date" rather than guessing at it
 * statistically. Two sources, in priority order:
 *
 * 1. Active `Subscription` records with at least one ledger payment already filed under this
 *    category — the subscription's own `cost`/`billingCycle`/`nextDueDate` project forward with
 *    `"high"` confidence, since the user entered them explicitly. (There is no direct
 *    subscription→category field; a subscription only produces a commitment once at least one of its
 *    linked payments shows it actually belongs to this category.)
 * 2. Stable recurring merchant series (`recurringSeries()`) filed under this category — projected
 *    forward from their own observed cadence, `"moderate"` confidence since it's inferred rather than
 *    declared.
 *
 * A series already covered by an active subscription is never counted twice (§13's "count it once"
 * rule) — matched by normalized merchant key, since the same charge groups identically in both.
 *
 * Rent/insurance/loan patterns (source 4 in the spec) fall out of (2) automatically wherever they're
 * regular enough to form a series; a dedicated amortization schedule for irregular debt payoff is a
 * later phase's `debt-schedule` method, not this step. Explicit future obligations (source 5) have no
 * data model in this app yet, so `source: "manual"` is unused until one exists.
 *
 * The same identification (which subscriptions/series actually belong to this category) also backs
 * `recurringAttributedMonthlySpend` below, which needs the *historical* transactions behind each
 * source rather than a forward projection — sharing one identification pass is what keeps a
 * commitment's forward-looking source and its retrospective attribution from ever disagreeing about
 * what counts as "this category's recurring spend".
 */

/** One identified recurring relationship for a category — either an active linked `Subscription` or a
 *  stable `RecurringSeries` not already covered by one. Carries both what a forward projection needs
 *  (a cycle to walk forward from `startIso`) and what a retrospective sum needs (the actual historical
 *  transaction ids that belong to it, in this category). */
interface RecurringSource {
	key: string;
	kind: "subscription" | "recurring-series";
	subscriptionId?: string;
	/** Converted to the store's base currency at today's rate — see `commitmentAmountIn`. */
	amount: number;
	startIso: string;
	cycle: RecurringCycle;
	endDate?: string;
	/** This category's own transactions behind the source, for `recurringAttributedMonthlySpend`. */
	historicalTxIds: string[];
}

function identifyRecurringSources(store: ForecastStore, categoryId: string): RecurringSource[] {
	const txById = new Map(store.transactions.map((tx) => [tx.id, tx]));
	const out: RecurringSource[] = [];
	const coveredKeys = new Set<string>();

	for (const sub of store.subscriptions ?? []) {
		if (!isActive(sub)) continue;
		const linkedInCategory = store.transactions.filter((tx) => tx.subscriptionId === sub.id && tx.categoryId === categoryId);
		if (linkedInCategory.length === 0) continue;

		const key = normalizeMerchantKey(subscriptionPattern(sub) || sub.name);
		if (key) coveredKeys.add(key);

		out.push({
			key,
			kind: "subscription",
			subscriptionId: sub.id,
			amount: commitmentAmountIn(store, sub.cost, subCurrency(sub)),
			startIso: sub.nextDueDate,
			cycle: sub.billingCycle,
			endDate: sub.endDate,
			historicalTxIds: linkedInCategory.map((tx) => tx.id),
		});
	}

	for (const series of recurringSeries(store, 3)) {
		if (series.direction !== "debit") continue;
		// "Stable" — a merchant billed at a wildly uneven cadence isn't a commitment you can plan a date
		// against, even if its rough frequency happened to land inside one cycle band.
		if (series.gapSpread > 0.2) continue;
		if (Array.from(coveredKeys).some((key) => merchantKeysOverlap(key, series.key))) continue;
		if (!seriesMatchesCategory(txById, series, categoryId)) continue;

		const currency = lastCurrencyOf(txById, series) ?? "EUR";
		out.push({
			key: series.key,
			kind: "recurring-series",
			// The most recently observed amount, not the historical median (§59) — a rent that's been
			// €1,250 for nine years and just rose to €1,300 should project forward as €1,300; a median
			// over the whole series would stay anchored to the old price until years of the new one
			// outweighed it.
			amount: commitmentAmountIn(store, series.lastAmount, currency),
			startIso: series.lastDate,
			cycle: series.cycle,
			historicalTxIds: series.occurrences.filter((occ) => txById.get(occ.id)?.categoryId === categoryId).map((occ) => occ.id),
		});
	}

	return out;
}

/**
 * `target` must be a closed range (both ends set) — an open-ended range has no "inside" to select
 * occurrences from, so it returns nothing rather than guessing at a bound.
 */
export function detectForecastCommitments(store: ForecastStore, categoryId: string, target: DateRange): ForecastCommitment[] {
	if (!target.from || !target.to) return [];

	const out: ForecastCommitment[] = [];
	for (const source of identifyRecurringSources(store, categoryId)) {
		for (const date of occurrencesInRange(source.startIso, source.cycle, target)) {
			if (source.endDate && date > source.endDate) continue;
			const id = source.kind === "subscription" ? `sub:${source.subscriptionId}:${date}` : `series:${source.key}:${date}`;
			out.push({ id, categoryId, expectedDate: date, amount: source.amount, source: source.kind, confidence: source.kind === "subscription" ? "high" : "moderate" });
		}
	}

	return out.sort((a, b) => (a.expectedDate < b.expectedDate ? -1 : a.expectedDate > b.expectedDate ? 1 : 0));
}

/**
 * Step 1 prep for the recurring-plus-variable method (budget_spec.md §32, §36) — how much of this
 * category's *actual historical* spend, per tracked month, came from an identified recurring source
 * (an active subscription or a stable series), so the caller can subtract it out and forecast only
 * the residual. Reads the same identified sources `detectForecastCommitments` projects forward, just
 * summed backward over their own real transactions instead.
 */
export function recurringAttributedMonthlySpend(store: ForecastStore, categoryId: string): Map<string, number> {
	const txById = new Map(store.transactions.map((tx) => [tx.id, tx]));
	const byMonth = new Map<string, number>();
	for (const source of identifyRecurringSources(store, categoryId)) {
		for (const txId of source.historicalTxIds) {
			const tx = txById.get(txId);
			if (!tx?.date) continue;
			const month = tx.date.slice(0, 7);
			byMonth.set(month, (byMonth.get(month) ?? 0) + Math.abs(amountIn(store, tx)));
		}
	}
	return byMonth;
}

/**
 * §36 — the share of this category's historical economic spending attributable to identified
 * recurring sources, over exactly the months `history` itself covers (never a different window for
 * numerator and denominator, which the spec explicitly warns against). Clamped to at most 1: a
 * recurring source's raw ledger amount and a month's *net* economic expense aren't quite the same
 * measure (the latter nets refunds), so a month with an unusual refund could otherwise push this past
 * 100% of a total that itself reads smaller than the recurring charge alone.
 */
export function knownRecurringShare(history: CategoryPeriodSpend[], attributedByMonth: Map<string, number>): number {
	let recurring = 0;
	let total = 0;
	for (const h of history) {
		recurring += attributedByMonth.get(h.key) ?? 0;
		total += h.economicExpense;
	}
	return total > 0 ? Math.min(recurring / total, 1) : 0;
}

/** Every occurrence of a cycle starting at `startIso` that lands inside `target`, inclusive both ends —
 *  the "target-date occurrence selection" the spec calls for: usually one hit, but a weekly commitment
 *  against a month-long target can land several, and a subscription whose stored anchor is stale (or
 *  simply due after `target`) can just as validly land zero. Bounded walks in both directions so a
 *  years-old anchor or a distant future one can never loop unboundedly. */
function occurrencesInRange(startIso: string, cycle: RecurringCycle, target: DateRange): string[] {
	if (!startIso) return [];
	let d = startIso;
	for (let guard = 0; d < target.from && guard < 1000; guard++) d = addCycleIso(d, cycle);

	const dates: string[] = [];
	for (let guard = 0; d <= target.to && guard < 1000; guard++) {
		dates.push(d);
		d = addCycleIso(d, cycle);
	}
	return dates;
}

/** Converts a future/current recurring amount into the store's base currency at today's rate — there is
 *  no historical date to convert a not-yet-happened charge at, exactly the same convention
 *  `subscriptions.ts`'s `toBaseCurrency` already uses. Falls back to the raw amount if the currency
 *  isn't configured, rather than propagating NaN into a forecast. */
function commitmentAmountIn(store: ForecastStore, amount: number, currency: string | undefined): number {
	if (!store.fx) return amount;
	const converted = convert(amount, currency, store.fx);
	return Number.isFinite(converted) ? converted : amount;
}

/** Whether most of a series' own categorized occurrences were filed under `categoryId` — majority
 *  rather than "any", so one mis-categorized row doesn't attribute a whole series to the wrong
 *  category, and majority rather than "all", so one hasn't either. */
function seriesMatchesCategory(txById: Map<string, Transaction>, series: RecurringSeries, categoryId: string): boolean {
	let matches = 0;
	let total = 0;
	for (const occ of series.occurrences) {
		const cat = txById.get(occ.id)?.categoryId;
		if (!cat) continue;
		total++;
		if (cat === categoryId) matches++;
	}
	return total > 0 && matches / total > 0.5;
}

/** The currency the series was last actually charged in — used to convert its median amount, since
 *  `RecurringOccurrence` itself doesn't carry one. */
function lastCurrencyOf(txById: Map<string, Transaction>, series: RecurringSeries): string | undefined {
	const last = series.occurrences[series.occurrences.length - 1];
	return last ? txById.get(last.id)?.currency : undefined;
}
