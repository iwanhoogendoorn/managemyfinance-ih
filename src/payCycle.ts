import { classifyTransaction } from "./finance/semantics";
import { descendantIds, resolvePrimaryId } from "./categories";
import type { DateRange } from "./period";
import { MONTH_ABBR } from "./period";
import { spendByPeriod, type KpiStore } from "./kpi";

/**
 * Budgeting against a real payday instead of the calendar — for anyone paid on, say, the 19th
 * rather than the 1st, "this month" as a budgeting window should mean "since I was last paid",
 * not "since the 1st of the calendar month".
 *
 * Cycle boundaries are derived from the dates of real salary transactions rather than a fixed
 * day-of-month, so an early or late payday (weekends, holidays) is reflected exactly instead of
 * assumed. That makes cycles irregular by construction — there is no arithmetic "next cycle key"
 * the way there is for a calendar month, only the list actually derived from the ledger so far.
 *
 * Deliberately its own module rather than folded into period.ts: period.ts is pure calendar
 * arithmetic top to bottom (see its own header comment), and a cycle here is data, not a formula.
 */

/** Below this many days apart, a second income row is treated as a bonus/top-up riding along
 *  with the same payday rather than a new cycle boundary of its own. */
export const DEFAULT_MIN_CYCLE_GAP_DAYS = 20;

/**
 * Every date real salary money arrived, oldest first, with near-duplicates collapsed.
 *
 * "Real salary money" means a transaction whose category resolves (through the two-level
 * category model — see resolvePrimaryId/descendantIds in categories.ts) under `categoryId`, and
 * which the shared classifier already agrees is income (affectsIncome > 0) rather than, say, a
 * refund that happens to be filed under the same category.
 */
export function salaryDates(store: KpiStore, categoryId: string, minGapDays = DEFAULT_MIN_CYCLE_GAP_DAYS): string[] {
	const primaryId = resolvePrimaryId(store.categories, categoryId);
	if (!primaryId) return [];
	const ids = new Set(descendantIds(store.categories, primaryId));

	const dates = store.transactions
		.filter((tx) => !!tx.categoryId && ids.has(tx.categoryId))
		.filter((tx) => classifyTransaction(store, tx).affectsIncome > 0)
		.map((tx) => tx.date)
		.filter((d): d is string => !!d)
		.sort();

	const out: string[] = [];
	for (const date of dates) {
		const last = out[out.length - 1];
		if (last && daysBetween(last, date) < minGapDays) continue;
		out.push(date);
	}
	return out;
}

function daysBetween(from: string, to: string): number {
	const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
	const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
	return Math.round((b - a) / 86_400_000);
}

/** One day before an ISO date. */
function dayBefore(date: string): string {
	const [y, m, d] = date.slice(0, 10).split("-").map(Number);
	const prev = new Date(Date.UTC(y, m - 1, d - 1));
	return prev.toISOString().slice(0, 10);
}

export interface PayCycle {
	/** The cycle's start date, and its identity — there's no other stable key once cycles are irregular. */
	key: string;
	start: string;
	/** The day before the next known payday. Undefined for the most recent cycle — it's still open. */
	end?: string;
	/** Display-only estimate of when the open cycle will end (start + the recent average gap).
	 *  Never used for filtering — an empty `end` already means "still open" everywhere a range is read. */
	projectedEnd?: string;
}

/** How many of the most recent gaps feed the open cycle's projected length. */
const PROJECTION_LOOKBACK = 3;
/** Assumed cycle length until at least two real paydays are known to measure a gap from. */
const DEFAULT_PROJECTED_DAYS = 30;

/** The salary dates turned into cycles — everything but the most recent is a closed, fully-known
 *  window; the most recent is open, running from its payday to whatever "today" turns out to be. */
export function derivePayCycles(dates: string[]): PayCycle[] {
	if (dates.length === 0) return [];

	const gaps: number[] = [];
	for (let i = 1; i < dates.length; i++) gaps.push(daysBetween(dates[i - 1], dates[i]));

	const cycles: PayCycle[] = dates.map((start, i) => ({
		key: start,
		start,
		end: i + 1 < dates.length ? dayBefore(dates[i + 1]) : undefined,
	}));

	const last = cycles[cycles.length - 1];
	if (last.end === undefined) {
		const recentGaps = gaps.slice(-PROJECTION_LOOKBACK);
		const projectedLength = recentGaps.length > 0 ? Math.round(recentGaps.reduce((a, b) => a + b, 0) / recentGaps.length) : DEFAULT_PROJECTED_DAYS;
		const projected = new Date(Date.parse(`${last.start}T00:00:00Z`) + projectedLength * 86_400_000);
		last.projectedEnd = projected.toISOString().slice(0, 10);
	}

	return cycles;
}

/** The cycle "today" falls in — the most recent one whose start is on or before today. Undefined
 *  when today is before the very first known payday (nothing derivable yet: the bootstrap state). */
export function currentPayCycle(cycles: PayCycle[], today: Date = new Date()): PayCycle | undefined {
	const todayIso = isoOf(today);
	let current: PayCycle | undefined;
	for (const cycle of cycles) {
		if (cycle.start <= todayIso) current = cycle;
		else break;
	}
	return current;
}

function isoOf(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** Steps by `delta` cycles through the derived list — arithmetic shifting doesn't mean anything
 *  once the gaps between cycles are irregular, so navigation is just an index walk. Undefined past
 *  either end of what's actually known. */
export function shiftPayCycle(cycles: PayCycle[], key: string, delta: number): PayCycle | undefined {
	const index = cycles.findIndex((c) => c.key === key);
	if (index === -1) return undefined;
	return cycles[index + delta];
}

/** The cycle a date falls in, or undefined when it's before the first known payday or after the
 *  last known one's close — a closed cycle's range is exact, so this is the same containment check
 *  `inRange` would make, just without needing a DateRange built for every cycle to ask it. */
export function cycleContaining(cycles: PayCycle[], date: string): PayCycle | undefined {
	return cycles.find((c) => date >= c.start && (c.end === undefined || date <= c.end));
}

/** `spendByPeriod` (see kpi.ts) bucketed by pay-cycle key instead of calendar month — feeds
 *  pay-cycle budgeting's own rollover chain the same way `monthlySpendFor` feeds the calendar one. */
export function payCycleSpendFor(store: KpiStore, categoryId: string, cycles: PayCycle[]): Map<string, number> {
	return spendByPeriod(store, categoryId, (date) => cycleContaining(cycles, date)?.key);
}

/** The DateRange a cycle stands for. An open cycle's empty `to` already reads as "still open" to
 *  inRange()/primaryCategoryTotals() (see period.ts/kpi.ts), so the current cycle's actuals are
 *  correct with no special-casing here. */
export function payCycleRange(cycle: PayCycle): DateRange {
	return { from: cycle.start, to: cycle.end ?? "" };
}

function dayMonth(date: string): string {
	return `${Number(date.slice(8, 10))} ${MONTH_ABBR[Number(date.slice(5, 7)) - 1]}`;
}

/** "20 Aug – 19 Sep 2026" for a closed cycle, "20 Aug 2026 – present" for the open one. */
export function describePayCycle(cycle: PayCycle): string {
	const startYear = cycle.start.slice(0, 4);
	if (!cycle.end) return `${dayMonth(cycle.start)} ${startYear} – present`;
	const endYear = cycle.end.slice(0, 4);
	if (startYear === endYear) return `${dayMonth(cycle.start)} – ${dayMonth(cycle.end)} ${endYear}`;
	return `${dayMonth(cycle.start)} ${startYear} – ${dayMonth(cycle.end)} ${endYear}`;
}
