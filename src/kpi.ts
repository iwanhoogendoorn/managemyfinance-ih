import type { Account, Category, Transaction } from "./types";

/**
 * The slice of FinanceStore these calculations actually read. Kept structural (not `FinanceStore`
 * itself, which needs a real Obsidian `App` to construct) so this pure-calculation module has no
 * runtime dependency on Obsidian and is trivially unit-testable with a plain object literal — a real
 * `FinanceStore` instance satisfies this automatically since it has these same public fields.
 */
export interface KpiStore {
	accounts: Account[];
	categories: Category[];
	transactions: Transaction[];
}

export interface YearSummary {
	year: string;
	income: number;
	expenses: number;
	net: number;
	savingsRate: number;
	netWorthEOY: number;
	passiveIncome: number;
}

// ---------- date helpers ----------

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * Today as YYYY-MM-DD in the *local* calendar, deliberately built from local date components rather
 * than `toISOString()` — the latter reports yesterday for anyone east of UTC during the evening, which
 * would silently drop a day of transactions from every "up to today" cutoff in this file.
 */
export function todayIso(today: Date = new Date()): string {
	return `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
}

/** "YYYY-MM" of a "YYYY-MM-DD" date. */
export function monthOf(date: string): string {
	return date.slice(0, 7);
}

/** "YYYY-MM" shifted by whole months; handles year rollover in both directions. */
export function shiftMonth(month: string, delta: number): string {
	const y = Number(month.slice(0, 4));
	const m = Number(month.slice(5, 7));
	const d = new Date(Date.UTC(y, m - 1 + delta, 1));
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

/** Whole months from `from` to `to` — negative when `to` precedes `from`. */
export function monthsBetween(from: string, to: string): number {
	const fy = Number(from.slice(0, 4));
	const fm = Number(from.slice(5, 7));
	const ty = Number(to.slice(0, 4));
	const tm = Number(to.slice(5, 7));
	return (ty - fy) * 12 + (tm - fm);
}

export function daysInMonth(month: string): number {
	const y = Number(month.slice(0, 4));
	const m = Number(month.slice(5, 7));
	return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Last calendar day of `month` as "YYYY-MM-DD" — the inclusive upper bound of a month window. */
export function lastDayOf(month: string): string {
	return `${month}-${pad2(daysInMonth(month))}`;
}

/** First calendar day of `month` as "YYYY-MM-DD". */
export function firstDayOf(month: string): string {
	return `${month}-01`;
}

/** Days since the epoch for a "YYYY-MM-DD" string, via UTC so DST never shifts a day boundary. */
function dayNumber(date: string | undefined): number | undefined {
	if (!date || date.length < 10) return undefined;
	const y = Number(date.slice(0, 4));
	const m = Number(date.slice(5, 7));
	const d = Number(date.slice(8, 10));
	if (!y || !m || !d) return undefined;
	return Date.UTC(y, m - 1, d) / 86_400_000;
}

// ---------- transfers ----------

/** Moving your own money between your own accounts (e.g. checking → savings) is neither income nor expense.
 *  "Savings & Transfers" is this app's old (pre-eMoney) category name, kept for backward compatibility.
 *  Matching is case-insensitive/trimmed since imported or hand-typed category names can vary in casing. */
const TRANSFER_CATEGORY_NAMES = new Set(["transfers", "savings", "savings & transfers"]);
/** Trade Republic (and any importer using the same vocabulary) tags cash moved into/out of a brokerage,
 *  as opposed to an actual trade, with these `action` values — see investingActivityByYear, which already
 *  treats them separately from buy/sell/dividend activity. ING's own export uses the same concept but puts
 *  it in the `type` field instead ("Withdrawal"/"Deposit"), and its category auto-mapping isn't reliable for
 *  these rows (e.g. a savings withdrawal can land in "Cash/ATM" instead of "Transfers") — checking both
 *  fields against this vocabulary catches the transfer regardless of which importer or category it got. */
const TRANSFER_ACCOUNT_MARKERS = new Set(["deposit", "withdraw", "withdrawal"]);

/** Two transactions the pair heuristic believes are the two halves of one account-to-account move. */
export interface TransferPair {
	/** Id of the negative-amount side — the money leaving an account. */
	outId: string;
	/** Id of the positive-amount side — the same money arriving in another account. */
	inId: string;
	/** The transferred amount, always positive. */
	amount: number;
	daysApart: number;
}

/** Amounts must agree to the cent; a hair of slack absorbs float noise from `x * 100` style parsing. */
const AMOUNT_TOLERANCE = 0.010001;
const MAX_DAYS_APART = 3;

interface PairCandidate {
	tx: Transaction;
	index: number;
	day: number;
	cents: number;
	sign: number;
}

/**
 * The matched-pair heuristic for account-to-account transfers (B1). `Transaction` carries no
 * destination-account link, so a €5,000 move between two everyday accounts is otherwise counted as
 * €5,000 of income *and* €5,000 of expenses, inflating both and wrecking every savings rate.
 *
 * Two rows are a pair when they have opposite signs, |amount| equal within a cent, dates within
 * ±3 days, and different accounts — matched greedily largest-amount-first so a big genuine move
 * claims its true counterpart before a pile of same-sized small rows can consume it, and no row is
 * ever matched twice.
 *
 * Candidates are bucketed by absolute amount in cents so each search touches only the three buckets
 * that could possibly hold a match, instead of scanning the whole ledger once per transaction.
 */
export function detectTransferPairs(store: KpiStore): TransferPair[] {
	const candidates: PairCandidate[] = [];
	const byCents = new Map<number, PairCandidate[]>();
	store.transactions.forEach((tx, index) => {
		const day = dayNumber(tx.date);
		if (day === undefined || !tx.amount) return;
		const candidate: PairCandidate = {
			tx,
			index,
			day,
			cents: Math.round(Math.abs(tx.amount) * 100),
			sign: tx.amount < 0 ? -1 : 1,
		};
		candidates.push(candidate);
		const bucket = byCents.get(candidate.cents);
		if (bucket) bucket.push(candidate);
		else byCents.set(candidate.cents, [candidate]);
	});

	candidates.sort((a, b) => b.cents - a.cents || a.index - b.index);

	const matched = new Set<string>();
	const pairs: TransferPair[] = [];
	for (const candidate of candidates) {
		if (matched.has(candidate.tx.id)) continue;
		let best: PairCandidate | undefined;
		let bestScore = Infinity;
		for (let delta = -1; delta <= 1; delta++) {
			for (const other of byCents.get(candidate.cents + delta) ?? []) {
				if (other.tx.id === candidate.tx.id || matched.has(other.tx.id)) continue;
				if (other.sign === candidate.sign) continue;
				if (other.tx.accountId === candidate.tx.accountId) continue;
				if (Math.abs(Math.abs(other.tx.amount) - Math.abs(candidate.tx.amount)) > AMOUNT_TOLERANCE) continue;
				const daysApart = Math.abs(other.day - candidate.day);
				if (daysApart > MAX_DAYS_APART) continue;
				// Closest in time wins; an exact amount match breaks a tie between two equally close rows.
				const score = daysApart * 1000 + Math.abs(other.cents - candidate.cents);
				if (score < bestScore) {
					best = other;
					bestScore = score;
				}
			}
		}
		if (!best) continue;
		matched.add(candidate.tx.id);
		matched.add(best.tx.id);
		const outgoing = candidate.sign < 0 ? candidate : best;
		const incoming = candidate.sign < 0 ? best : candidate;
		pairs.push({
			outId: outgoing.tx.id,
			inId: incoming.tx.id,
			amount: Math.abs(outgoing.tx.amount),
			daysApart: Math.abs(outgoing.day - incoming.day),
		});
	}
	return pairs;
}

/**
 * Cached transfer-pair ids, keyed on the transactions array itself. Detection is O(n log n) and every
 * aggregate in this file needs it, so recomputing per call would make a budgets screen (one pass per
 * category, per lookback month) quadratic in the ledger.
 *
 * Invalidation is by array identity plus length: `FinanceStore` replaces the array on load and pushes
 * on import, and its only in-place edits (`updateTransaction`, `recategorize`) patch `categoryId` /
 * `attachmentPath`, which pair detection doesn't read. Anything that mutates an existing row's
 * amount/date/account in place must replace the array too.
 */
const transferPairCache = new WeakMap<Transaction[], { length: number; ids: Set<string> }>();

export function transferPairIds(store: KpiStore): ReadonlySet<string> {
	const cached = transferPairCache.get(store.transactions);
	if (cached && cached.length === store.transactions.length) return cached.ids;
	const ids = new Set<string>();
	for (const pair of detectTransferPairs(store)) {
		ids.add(pair.outId);
		ids.add(pair.inId);
	}
	transferPairCache.set(store.transactions, { length: store.transactions.length, ids });
	return ids;
}

/**
 * Everything `isTransfer` needs, resolved once per aggregate instead of per transaction. The two id sets
 * turn what used to be a linear `find` over categories and accounts *for every row scanned* into a hash
 * lookup; they're rebuilt on each call rather than cached, so renaming a category takes effect
 * immediately (unlike the pair set, which no in-place edit can invalidate).
 */
interface TransferContext {
	pairIds: ReadonlySet<string>;
	transferCategoryIds: ReadonlySet<string>;
	/** Accounts whose own deposit/withdraw markers mean "cash moved", i.e. saving and investing. */
	markerAccountIds: ReadonlySet<string>;
}

function transferContext(store: KpiStore): TransferContext {
	const transferCategoryIds = new Set<string>();
	for (const cat of store.categories) {
		if (TRANSFER_CATEGORY_NAMES.has(cat.name.trim().toLowerCase())) transferCategoryIds.add(cat.id);
	}
	const markerAccountIds = new Set<string>();
	for (const acc of store.accounts) {
		if (acc.type === "saving" || acc.type === "investing") markerAccountIds.add(acc.id);
	}
	return { pairIds: transferPairIds(store), transferCategoryIds, markerAccountIds };
}

/**
 * A transaction is a transfer if it's explicitly categorized as one, if it's cash moving into/out of a
 * savings or investing account per its own `action`/`type` (see TRANSFER_ACCOUNT_MARKERS), or if the
 * matched-pair heuristic found its counterpart in another account (see detectTransferPairs).
 */
function isTransfer(tx: Transaction, ctx: TransferContext): boolean {
	if (ctx.pairIds.has(tx.id)) return true;
	if (tx.categoryId && ctx.transferCategoryIds.has(tx.categoryId)) return true;
	if (ctx.markerAccountIds.has(tx.accountId)) {
		const action = (tx.action ?? "").trim().toLowerCase();
		const type = (tx.type ?? "").trim().toLowerCase();
		if (TRANSFER_ACCOUNT_MARKERS.has(action) || TRANSFER_ACCOUNT_MARKERS.has(type)) return true;
	}
	return false;
}

/** Dividends and interest payouts, identified from the broker action/type text (e.g. Trade Republic exports). */
function isPassiveIncome(tx: Transaction): boolean {
	const text = `${tx.action ?? ""} ${tx.type ?? ""}`.toLowerCase();
	return /dividend|interest/.test(text);
}

/**
 * (income - expenses) / income, clamped to [-100%, 100%]. A period with next-to-no recorded income
 * (e.g. a year where only a few cents of interest were ever categorized as income) makes the raw ratio
 * balloon toward -Infinity for perfectly ordinary expenses — mathematically "correct" but meaningless,
 * and it wrecks any chart's scale by dwarfing every other data point. Clamping keeps "way overspent
 * relative to income" visible without one sparse period distorting everything else.
 */
function savingsRateOf(income: number, expenses: number): number {
	if (income <= 0) return 0;
	return Math.max(-1, Math.min(1, (income - expenses) / income));
}

/** When `accountId` is given, every KPI here is scoped to that one account instead of the whole store. */
export function summarizeByYear(store: KpiStore, accountId?: string): YearSummary[] {
	const ctx = transferContext(store);
	const map = new Map<
		string,
		{ income: number; expenses: number; passiveIncome: number; netChange: number; transferAmount: number }
	>();
	for (const tx of store.transactions) {
		if (accountId && tx.accountId !== accountId) continue;
		const year = tx.date?.slice(0, 4);
		if (!year) continue;
		if (!map.has(year)) map.set(year, { income: 0, expenses: 0, passiveIncome: 0, netChange: 0, transferAmount: 0 });
		const bucket = map.get(year)!;
		bucket.netChange += tx.amount;
		if (isTransfer(tx, ctx)) {
			bucket.transferAmount += tx.amount;
			continue;
		}
		if (tx.amount >= 0) {
			bucket.income += tx.amount;
			if (isPassiveIncome(tx)) bucket.passiveIncome += tx.amount;
		} else {
			bucket.expenses += -tx.amount;
		}
	}

	const years = Array.from(map.keys()).sort((a, b) => a.localeCompare(b));
	let cumulative = store.accounts
		.filter((a) => !accountId || a.id === accountId)
		.reduce((sum, a) => sum + (a.openingBalance ?? 0), 0);

	// Aggregate ("All Accounts") mode only: a transfer between your own accounts must never move
	// combined net worth. But an account with no transaction history of its own carries its
	// *current* balance as a flat "opening balance" applied to every year alike, so a transfer into
	// it is never credited in the year it actually happened — the total can look flat, or even dip,
	// in a year you clearly saved well (see e.g. a savings account tracked only by today's balance).
	// Walking forward on income-minus-expenses (plus that year's own transfers, added back in below),
	// with the running balance seeded by opening balances alone, moves the trajectory only in the
	// years real saving happened. Each year only ever folds in *its own* transfers — never a future
	// year's — so every year's netWorthEOY reflects activity only up through that year's end; the
	// final year still lands on exactly the same total as netWorth(store), since summed across every
	// year, income - expenses + transferAmount covers every transaction exactly once.
	const useNetSavingsOnly = !accountId;

	return years.map((year) => {
		const { income, expenses, passiveIncome, netChange, transferAmount } = map.get(year)!;
		cumulative += useNetSavingsOnly ? income - expenses + transferAmount : netChange;
		return {
			year,
			income,
			expenses,
			net: income - expenses,
			savingsRate: savingsRateOf(income, expenses),
			netWorthEOY: cumulative,
			passiveIncome,
		};
	});
}

/**
 * The summary for `year` (defaults to today's real calendar year) — never just "whichever year
 * happens to be last in the array". Without this, "this year" would silently mean "last year" the
 * moment a new calendar year starts and no transactions have been imported for it yet.
 */
export function yearSummaryFor(years: YearSummary[], year: string = String(new Date().getFullYear())): YearSummary | undefined {
	return years.find((y) => y.year === year);
}

export interface MonthSummary {
	/** "01"–"12" */
	month: string;
	income: number;
	expenses: number;
	net: number;
	savingsRate: number;
	passiveIncome: number;
}

/** The 12 months of `year`, always all 12 even when some have no activity — the drill-down behind a year click. */
export function summarizeByMonth(store: KpiStore, year: string, accountId?: string): MonthSummary[] {
	const accountIds = accountId ? [accountId] : undefined;
	return Array.from({ length: 12 }, (_, i) => {
		const month = `${year}-${pad2(i + 1)}`;
		const summary = windowSummary(store, firstDayOf(month), lastDayOf(month), accountIds);
		return {
			month: pad2(i + 1),
			income: summary.income,
			expenses: summary.expenses,
			net: summary.net,
			savingsRate: summary.savingsRate,
			passiveIncome: summary.passiveIncome,
		};
	});
}

// ---------- window primitives ----------

export interface WindowSummary {
	income: number;
	expenses: number;
	net: number;
	savingsRate: number;
	passiveIncome: number;
	/** Non-transfer transactions in the window — the rows the figures above are actually made of. */
	txCount: number;
}

/**
 * Income/expenses/net over an arbitrary inclusive date window ("YYYY-MM-DD" bounds), optionally scoped
 * to a set of accounts. The generic building block behind every period figure — a month, a trailing 12
 * complete months, a statement cycle — replacing the assumption baked into `summarizeByYear` that the
 * reporting period is always a calendar year.
 */
export function windowSummary(store: KpiStore, from: string, to: string, accountIds?: string[]): WindowSummary {
	const ctx = transferContext(store);
	let income = 0;
	let expenses = 0;
	let passiveIncome = 0;
	let txCount = 0;
	for (const tx of store.transactions) {
		if (accountIds && !accountIds.includes(tx.accountId)) continue;
		if (!tx.date || tx.date < from || tx.date > to) continue;
		if (isTransfer(tx, ctx)) continue;
		txCount++;
		if (tx.amount >= 0) {
			income += tx.amount;
			if (isPassiveIncome(tx)) passiveIncome += tx.amount;
		} else {
			expenses += -tx.amount;
		}
	}
	return { income, expenses, net: income - expenses, savingsRate: savingsRateOf(income, expenses), passiveIncome, txCount };
}

/**
 * Every "YYYY-MM" from the first transaction month through the current month, with no gaps — a month
 * with zero activity still gets a key, so any series built on this has an even time axis instead of
 * silently compressing quiet months.
 */
export function monthKeys(store: KpiStore, accountIds?: string[], today: Date = new Date()): string[] {
	let earliest: string | undefined;
	for (const tx of store.transactions) {
		if (accountIds && !accountIds.includes(tx.accountId)) continue;
		const month = tx.date?.slice(0, 7);
		if (!month) continue;
		if (!earliest || month < earliest) earliest = month;
	}
	if (!earliest) return [];
	const last = monthOf(todayIso(today));
	const keys: string[] = [];
	// Bounded like nextOccurrence's roll-forward: a corrupt far-past date must not spin forever.
	for (let month = earliest, guard = 0; month <= last && guard < 2000; month = shiftMonth(month, 1), guard++) {
		keys.push(month);
	}
	return keys;
}

export interface BalancePoint {
	/** "YYYY-MM" at month granularity, "YYYY-MM-DD" at day granularity. */
	key: string;
	/** Closing balance as of the end of that period. */
	balance: number;
}

/**
 * Closing balance at the end of every period in range: opening balances plus every transaction dated on
 * or before that period's last day. Unlike `summarizeByYear`'s `netWorthEOY` — which walks net savings
 * to work around accounts tracked by opening balance alone — this is a literal running total, so it is
 * the right series for charting an actual balance over time at month or day granularity.
 */
export function balanceSeries(
	store: KpiStore,
	accountIds?: string[],
	granularity: "month" | "day" = "month",
	today: Date = new Date()
): BalancePoint[] {
	const opening = store.accounts
		.filter((a) => !accountIds || accountIds.includes(a.id))
		.reduce((sum, a) => sum + (a.openingBalance ?? 0), 0);

	const dated = store.transactions
		.filter((tx) => tx.date && (!accountIds || accountIds.includes(tx.accountId)))
		.sort((a, b) => a.date.localeCompare(b.date));
	if (dated.length === 0) return [];

	const bounds =
		granularity === "month"
			? monthKeys(store, accountIds, today).map((month) => ({ key: month, until: lastDayOf(month) }))
			: dayRange(dated[0].date, todayIso(today)).map((day) => ({ key: day, until: day }));

	const points: BalancePoint[] = [];
	let balance = opening;
	let cursor = 0;
	for (const { key, until } of bounds) {
		while (cursor < dated.length && dated[cursor].date <= until) {
			balance += dated[cursor].amount;
			cursor++;
		}
		points.push({ key, balance });
	}
	return points;
}

/** Every "YYYY-MM-DD" from `from` to `to` inclusive. Capped at ~30 years so a corrupt date can't hang the UI. */
function dayRange(from: string, to: string): string[] {
	const start = dayNumber(from);
	const end = dayNumber(to);
	if (start === undefined || end === undefined || end < start) return [];
	const days: string[] = [];
	for (let d = start; d <= end && days.length < 11_000; d++) {
		days.push(new Date(d * 86_400_000).toISOString().slice(0, 10));
	}
	return days;
}

/**
 * Average monthly spend over the last N *complete* calendar months — the single definition of "average
 * monthly spend" in this app. The current month is excluded on purpose: it is always partial, so
 * including it drags the average down by however much of the month is left. Months with no spend at all
 * still count toward the denominator (that's the difference from `averageMonthlyExpenses`), because a
 * month you happened not to spend in is real information about your burn.
 */
export function burnRate(store: KpiStore, accountIds?: string[], months = 6, today: Date = new Date()): number {
	const lastComplete = shiftMonth(monthOf(todayIso(today)), -1);
	let earliest: string | undefined;
	for (const tx of store.transactions) {
		if (accountIds && !accountIds.includes(tx.accountId)) continue;
		const month = tx.date?.slice(0, 7);
		if (!month) continue;
		if (!earliest || month < earliest) earliest = month;
	}
	if (!earliest) return 0;

	const available = monthsBetween(earliest, lastComplete) + 1;
	const n = Math.min(months, available);
	if (n <= 0) return 0;

	const from = firstDayOf(shiftMonth(lastComplete, -(n - 1)));
	return windowSummary(store, from, lastDayOf(lastComplete), accountIds).expenses / n;
}

/** A "YYYY" / "YYYY-MM" date prefix, or an explicit inclusive date range. */
export type SpendWindow = string | { from: string; to: string };

/**
 * Expenses grouped by category id over an arbitrary window, with transfers and income excluded.
 * Uncategorized spend is bucketed under `"uncategorized"` so it stays visible rather than vanishing
 * from the totals.
 */
export function categorySpend(store: KpiStore, window?: SpendWindow, accountIds?: string[]): Map<string, number> {
	const ctx = transferContext(store);
	const range = typeof window === "object" ? window : undefined;
	const prefix = typeof window === "string" ? window : undefined;
	const totals = new Map<string, number>();
	for (const tx of store.transactions) {
		if (tx.amount >= 0) continue;
		if (accountIds && !accountIds.includes(tx.accountId)) continue;
		if (prefix && !tx.date?.startsWith(prefix)) continue;
		if (range && (!tx.date || tx.date < range.from || tx.date > range.to)) continue;
		if (isTransfer(tx, ctx)) continue;
		const key = tx.categoryId ?? "uncategorized";
		totals.set(key, (totals.get(key) ?? 0) + -tx.amount);
	}
	return totals;
}

/**
 * Expenses by category for a "YYYY" or "YYYY-MM" prefix and at most one account.
 * @deprecated Prefer `categorySpend`, which takes an arbitrary window and a set of accounts.
 * @param datePrefix Matched with `startsWith`, so both "2024" and "2024-06" are valid — this parameter
 *        was called `year` and is passed a month by `suggestedBudget`; the prefix semantics are intended.
 */
export function categoryTotals(store: KpiStore, datePrefix?: string, accountId?: string): Map<string, number> {
	return categorySpend(store, datePrefix, accountId ? [accountId] : undefined);
}

// ---------- balances ----------

/**
 * Opening balances plus every transaction dated on or before `asOf` (today by default). The date guard
 * matters because a scheduled or mis-imported future-dated row would otherwise inflate the balance you
 * are told you have *right now*.
 */
export function netWorth(store: KpiStore, accountId?: string, asOf: string = todayIso()): number {
	let total = 0;
	for (const acc of store.accounts) {
		if (accountId && acc.id !== accountId) continue;
		total += acc.openingBalance ?? 0;
	}
	for (const tx of store.transactions) {
		if (accountId && tx.accountId !== accountId) continue;
		if (tx.date && tx.date > asOf) continue;
		total += tx.amount;
	}
	return total;
}

/** Simulates monthly compounding to estimate years until `netWorthNow` reaches `target`. */
export function fiProjection(
	netWorthNow: number,
	monthlyContribution: number,
	annualReturn: number,
	target: number
): number | undefined {
	if (target <= 0) return undefined;
	if (netWorthNow >= target) return 0;
	if (monthlyContribution <= 0 && annualReturn <= 0) return undefined;

	const monthlyReturn = annualReturn / 12;
	let balance = netWorthNow;
	for (let month = 1; month <= 12 * 60; month++) {
		balance = balance * (1 + monthlyReturn) + monthlyContribution;
		if (balance >= target) return month / 12;
	}
	return undefined;
}

/** Transaction count and net total for one account — the at-a-glance numbers shown in the accounts manager. */
export function accountStats(store: KpiStore, accountId: string): { count: number; netWorth: number } {
	const count = store.transactions.filter((t) => t.accountId === accountId).length;
	return { count, netWorth: netWorth(store, accountId) };
}

/**
 * Average monthly spend across only the months that had any spend at all.
 * @deprecated Prefer `burnRate`, which averages over a fixed number of recent *complete* months. This
 * one averages over all history, so a 2019 spending pattern and a half-empty first month both distort
 * the runway denominator it exists to provide.
 */
export function averageMonthlyExpenses(store: KpiStore, accountIds?: string[]): number {
	const ctx = transferContext(store);
	const byMonth = new Map<string, number>();
	for (const tx of store.transactions) {
		if (accountIds && !accountIds.includes(tx.accountId)) continue;
		if (tx.amount >= 0) continue;
		if (isTransfer(tx, ctx)) continue;
		const month = tx.date?.slice(0, 7);
		if (!month) continue;
		byMonth.set(month, (byMonth.get(month) ?? 0) + -tx.amount);
	}
	const months = Array.from(byMonth.values());
	if (months.length === 0) return 0;
	return months.reduce((a, b) => a + b, 0) / months.length;
}

// ---------- investing ----------

export interface Holding {
	ticker: string;
	assetClass?: string;
	shares: number;
	/** Average-cost basis of the shares still held — what they cost you, not what they're worth today. */
	netInvested: number;
	avgCost: number;
	/** Gain/loss already booked by selling this ticker: proceeds minus the basis those sold shares carried. */
	realizedPL: number;
}

interface TickerState {
	shares: number;
	basis: number;
	realized: number;
	assetClass?: string;
}

/**
 * Walks a broker account's buy/sell rows in date order, maintaining an average-cost basis.
 *
 * Chronology is what makes this correct: the basis released by a sale is the average cost *at the moment
 * of that sale*, so the buys before it must already be folded in. The previous implementation simply
 * subtracted sale proceeds from the basis, which meant selling at a profit erased basis that still
 * belonged to shares you were holding — buy 10 @ €100 then sell 5 @ €200 left €0 of basis against five
 * shares that cost €500, and a large enough gain drove it negative.
 */
function walkTrades(store: KpiStore, accountId: string): {
	byTicker: Map<string, TickerState>;
	realizedByYear: Map<string, { proceeds: number; costBasisSold: number; realized: number }>;
} {
	const trades = store.transactions
		.map((tx, index) => ({ tx, index }))
		.filter(({ tx }) => {
			if (tx.accountId !== accountId) return false;
			if (!tx.ticker || tx.ticker === "CASH") return false;
			const action = (tx.action ?? "").toLowerCase();
			return action === "buy" || action === "sell";
		})
		.sort((a, b) => (a.tx.date ?? "").localeCompare(b.tx.date ?? "") || a.index - b.index);

	const byTicker = new Map<string, TickerState>();
	const realizedByYear = new Map<string, { proceeds: number; costBasisSold: number; realized: number }>();

	for (const { tx } of trades) {
		const ticker = tx.ticker!;
		const state = byTicker.get(ticker) ?? { shares: 0, basis: 0, realized: 0, assetClass: tx.assetClass };
		const shares = tx.shares ?? 0;
		const amount = Math.abs(tx.amount);

		if ((tx.action ?? "").toLowerCase() === "buy") {
			state.shares += shares;
			state.basis += amount;
		} else {
			// A sell row without a share count (hand-entered, or a generic CSV) can't be attributed per
			// share, so fall back to releasing basis up to the proceeds — that books no phantom profit,
			// which is the conservative reading when the data can't tell us the real one.
			const costOut =
				shares > 0 && state.shares > 0
					? Math.min(state.basis, (state.basis / state.shares) * shares)
					: Math.min(state.basis, amount);
			state.basis -= costOut;
			state.shares -= shares;
			state.realized += amount - costOut;

			const year = tx.date?.slice(0, 4);
			if (year) {
				const bucket = realizedByYear.get(year) ?? { proceeds: 0, costBasisSold: 0, realized: 0 };
				bucket.proceeds += amount;
				bucket.costBasisSold += costOut;
				bucket.realized += amount - costOut;
				realizedByYear.set(year, bucket);
			}
		}
		if (tx.assetClass) state.assetClass = tx.assetClass;
		byTicker.set(ticker, state);
	}
	return { byTicker, realizedByYear };
}

/**
 * Current holdings inferred purely from Buy/Sell activity — there's no market-price feed here, so this is
 * cost-basis accounting (what you put in), not portfolio valuation (what it's worth today).
 */
export function investingHoldings(store: KpiStore, accountId: string): Holding[] {
	return Array.from(walkTrades(store, accountId).byTicker.entries())
		.filter(([, state]) => state.shares > 1e-6)
		.map(([ticker, state]) => ({
			ticker,
			assetClass: state.assetClass,
			shares: state.shares,
			netInvested: state.basis,
			avgCost: state.shares > 0 ? state.basis / state.shares : 0,
			realizedPL: state.realized,
		}))
		.sort((a, b) => b.netInvested - a.netInvested);
}

export interface RealizedYear {
	year: string;
	proceeds: number;
	costBasisSold: number;
	/** proceeds − the average cost the sold shares carried at the moment of sale. */
	realized: number;
}

/**
 * Realized profit and loss per year, including positions closed entirely — which is why this is separate
 * from `investingHoldings`, whose rows disappear the moment a position goes to zero.
 */
export function realizedPLByYear(store: KpiStore, accountId: string): RealizedYear[] {
	return Array.from(walkTrades(store, accountId).realizedByYear.entries())
		.map(([year, bucket]) => ({ year, ...bucket }))
		.sort((a, b) => a.year.localeCompare(b.year));
}

export interface InvestingYearActivity {
	year: string;
	deposits: number;
	withdrawals: number;
	dividends: number;
	fees: number;
}

/** Deposits/withdrawals/dividends/fees for a broker account, by year — the cash-flow side of investing. */
export function investingActivityByYear(store: KpiStore, accountId: string): InvestingYearActivity[] {
	const map = new Map<string, InvestingYearActivity>();
	for (const tx of store.transactions) {
		if (tx.accountId !== accountId) continue;
		const year = tx.date?.slice(0, 4);
		if (!year) continue;
		if (!map.has(year)) map.set(year, { year, deposits: 0, withdrawals: 0, dividends: 0, fees: 0 });
		const bucket = map.get(year)!;
		const action = (tx.action ?? "").toLowerCase();
		if (action === "deposit") bucket.deposits += Math.abs(tx.amount);
		else if (action === "withdraw") bucket.withdrawals += Math.abs(tx.amount);
		else if (action === "dividend" || action.startsWith("interest")) bucket.dividends += Math.abs(tx.amount);
		if (tx.fee) bucket.fees += Math.abs(tx.fee);
	}
	return Array.from(map.values()).sort((a, b) => a.year.localeCompare(b.year));
}
