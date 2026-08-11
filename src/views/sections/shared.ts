import { formatMoney, formatPct, formatSignedPct, parseAmount } from "../../format";
import {
	firstDayOf,
	isPassiveIncome,
	lastDayOf,
	monthOf,
	netWorth,
	shiftMonth,
	todayIso,
	transferPairIds,
	windowSummary,
	type KpiStore,
} from "../../kpi";
import type FinancePlugin from "../../main";
import { normalizeMerchantKey, type RecurringSeries } from "../../recurring";
import { upcomingPayments } from "../../subscriptions";
import type { Account, AccountType, Subscription } from "../../types";
import { icon } from "../../ui/dom";

/* ==========================================================================
   Shared section helpers
   --------------------------------------------------------------------------
   Everything several dashboards need and nothing that belongs in the pure
   calculation layer: money/date formatting wrappers, account-set scoping, the
   end-of-month projection, and the small interaction primitives (deep links,
   inline value edits) that turn a read-only figure into something actionable.
   ========================================================================== */

/** The eight validated categorical slots. Assigned in order; index wraps. */
export const CAT_COLORS = [
	"var(--fp-cat-1)",
	"var(--fp-cat-2)",
	"var(--fp-cat-3)",
	"var(--fp-cat-4)",
	"var(--fp-cat-5)",
	"var(--fp-cat-6)",
	"var(--fp-cat-7)",
	"var(--fp-cat-8)",
];

export function catColor(i: number): string {
	return CAT_COLORS[((i % CAT_COLORS.length) + CAT_COLORS.length) % CAT_COLORS.length];
}

/* ---------- money & percent ---------- */

/**
 * Display money. Whole euros by default: a dashboard figure is a magnitude, and cents on a
 * five-figure balance are noise that costs two characters of the number's own legibility. Pass
 * `decimals: 2` for ledger-level amounts, where the cents are the point.
 */
export function money(n: number, currency = "EUR", decimals = 0): string {
	return formatMoney(n, currency, { decimals });
}

/** Money with an explicit sign — for deltas, where direction is the message. */
export function signedMoney(n: number, currency = "EUR", decimals = 0): string {
	return formatMoney(n, currency, { decimals, signed: true });
}

export function pct(n: number, digits = 0): string {
	return formatPct(n, digits);
}

export function signedPct(n: number, digits = 0): string {
	return formatSignedPct(n, digits);
}

export function accountCurrency(account?: Account): string {
	return account?.currency || "EUR";
}

/** The currency to label a portfolio-wide total with: the one all accounts agree on, or EUR. */
export function portfolioCurrency(store: KpiStore): string {
	const set = new Set(store.accounts.map((a) => a.currency || "EUR"));
	return set.size === 1 ? Array.from(set)[0] : "EUR";
}

/* ---------- dates ----------
   kpi.ts owns month arithmetic; day arithmetic below is local rather than imported from
   recurring.ts, whose `todayIso` collides with kpi's. */

function dayNumber(iso: string): number {
	return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;
}

/** `iso` moved by whole days, in UTC so a DST boundary can never eat a day. */
export function shiftDays(iso: string, days: number): string {
	return new Date((dayNumber(iso) + days) * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
	return dayNumber(to) - dayNumber(from);
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-IE", { day: "numeric", month: "short", year: "numeric" });
const DAY_SHORT_FORMAT = new Intl.DateTimeFormat("en-IE", { day: "numeric", month: "short" });
const MONTH_FORMAT = new Intl.DateTimeFormat("en-IE", { month: "long", year: "numeric" });

export function formatDay(iso: string, opts: { short?: boolean } = {}): string {
	const d = new Date(`${iso}T00:00:00`);
	if (isNaN(d.getTime())) return iso;
	return (opts.short ? DAY_SHORT_FORMAT : DAY_FORMAT).format(d);
}

export function formatMonth(month: string): string {
	const d = new Date(`${month}-01T00:00:00`);
	if (isNaN(d.getTime())) return month;
	return MONTH_FORMAT.format(d);
}

export function relativeDays(days: number): string {
	if (days === 0) return "today";
	if (days === 1) return "tomorrow";
	if (days < 0) return `${-days}d overdue`;
	return `in ${days}d`;
}

/* ---------- account sets ---------- */

export function accountIdsOfType(store: KpiStore, types: AccountType[]): string[] {
	return store.accounts.filter((a) => types.includes(a.type)).map((a) => a.id);
}

/** Money you can actually spend today — the base of every runway and projection figure. */
export function liquidAccountIds(store: KpiStore): string[] {
	return accountIdsOfType(store, ["debit", "saving", "cash"]);
}

/**
 * The accounts spending actually leaves through. Credit is in deliberately: a user who puts most
 * discretionary spend on a card gets a materially overstated runway when the card is excluded.
 */
export function spendingAccountIds(store: KpiStore): string[] {
	return accountIdsOfType(store, ["debit", "cash", "credit"]);
}

/** Sum of `netWorth` over a set of accounts, with the same `asOf` date guard. */
export function balanceOf(store: KpiStore, accountIds: string[], asOf: string = todayIso()): number {
	return accountIds.reduce((sum, id) => sum + netWorth(store, id, asOf), 0);
}

export interface HonestNetWorth {
	/** Market value where the user has entered one, cost basis everywhere else. */
	total: number;
	/** How much of `total` is still cost basis rather than a real valuation. */
	atCost: number;
	/** Investing/crypto accounts still valued at cost. */
	costAccounts: Account[];
	/** The oldest `marketValueAsOf` in play — the figure's real age. */
	oldestAsOf?: string;
}

/**
 * Net worth that stops calling cost basis a valuation. For debit/saving/cash/credit the ledger
 * balance *is* the truth; for investing and crypto it is what you paid, so a manually-entered
 * `marketValue` wins whenever the user has given one.
 */
export function honestNetWorth(store: KpiStore, asOf: string = todayIso()): HonestNetWorth {
	let total = 0;
	let atCost = 0;
	const costAccounts: Account[] = [];
	let oldestAsOf: string | undefined;

	for (const account of store.accounts) {
		const balance = netWorth(store, account.id, asOf);
		const valued = account.type === "investing" || account.type === "crypto";
		if (valued && account.marketValue !== undefined) {
			total += account.marketValue;
			if (account.marketValueAsOf && (!oldestAsOf || account.marketValueAsOf < oldestAsOf)) {
				oldestAsOf = account.marketValueAsOf;
			}
		} else {
			total += balance;
			if (valued) {
				atCost += balance;
				costAccounts.push(account);
			}
		}
	}
	return { total, atCost, costAccounts, oldestAsOf };
}

/* ---------- windows ---------- */

export interface Ttm {
	from: string;
	to: string;
	/** The 12 complete months as "YYYY-MM", oldest first. */
	months: string[];
}

/** The 12 complete months ending at M-1. Never includes the partial current month. */
export function ttmWindow(today: Date = new Date(), months = 12): Ttm {
	const lastComplete = shiftMonth(monthOf(todayIso(today)), -1);
	const first = shiftMonth(lastComplete, -(months - 1));
	const keys: string[] = [];
	for (let m = first, i = 0; i < months; m = shiftMonth(m, 1), i++) keys.push(m);
	return { from: firstDayOf(first), to: lastDayOf(lastComplete), months: keys };
}

/** The month window `[first, last]` for a "YYYY-MM" key. */
export function monthWindow(month: string): { from: string; to: string } {
	return { from: firstDayOf(month), to: lastDayOf(month) };
}

/* ---------- end-of-month projection ---------- */

export interface CommittedPayment {
	date: string;
	label: string;
	/** Always positive — the amount leaving the account on `date`. */
	amount: number;
	source: "subscription" | "recurring";
	subscriptionId?: string;
	merchantKey?: string;
}

export interface MonthEndProjection {
	current: number;
	scheduledIn: number;
	scheduledOut: number;
	/** dailyDiscretionary × the days left in the month. */
	discretionary: number;
	dailyDiscretionary: number;
	remainingDays: number;
	projected: number;
	/** Projection minus a one-week discretionary buffer — the honest "spend this freely" figure. */
	safeToSpend: number;
	eom: string;
	committed: CommittedPayment[];
}

function seriesMatchesSubscription(series: RecurringSeries, subs: Subscription[]): boolean {
	return subs.some((sub) => {
		const key = normalizeMerchantKey(sub.merchantKey ?? sub.name);
		return key.length > 0 && (key === series.key || series.key.includes(key) || key.includes(series.key));
	});
}

/**
 * Committed outflows between tomorrow and `until`: every active subscription's next charge at its
 * real `cost` (not its normalized monthly share), plus every recurring debit in the ledger that no
 * subscription covers — de-duplicated by merchant key so a tracked subscription is never counted
 * twice.
 */
export function committedPayments(
	subs: Subscription[],
	series: RecurringSeries[],
	until: string,
	accountIds: string[] | undefined,
	today: Date = new Date()
): CommittedPayment[] {
	const from = todayIso(today);
	const inScope = (accountId?: string) => !accountIds || (accountId !== undefined && accountIds.includes(accountId));

	// A subscription with no account can't be attributed, so it counts portfolio-wide and is left out
	// of an account-scoped projection rather than charged to an account it may not belong to.
	const out: CommittedPayment[] = upcomingPayments(subs, today)
		.filter((p) => p.date <= until && (!accountIds || (!!p.sub.accountId && accountIds.includes(p.sub.accountId))))
		.map((p) => ({
			date: p.date,
			label: p.sub.name,
			amount: p.amount,
			source: "subscription" as const,
			subscriptionId: p.sub.id,
			merchantKey: p.sub.merchantKey,
		}));

	for (const s of series) {
		if (s.direction !== "debit") continue;
		if (!inScope(s.accountId)) continue;
		// `< from`, not `<= from`: a charge expected *today* has not necessarily hit the account yet, and
		// the subscription branch above already keeps today's payments (upcomingPayments rolls forward to
		// the first date on or after today). Dropping it here made the two halves of the same list
		// disagree about what "committed" means on the one day it matters most.
		if (s.expectedNextDate < from || s.expectedNextDate > until) continue;
		if (seriesMatchesSubscription(s, subs)) continue;
		out.push({
			date: s.expectedNextDate,
			label: s.displayName,
			amount: s.lastAmount,
			source: "recurring",
			merchantKey: s.key,
		});
	}

	return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * What your balance looks like on the last day of the month, given what you have already committed
 * to: today's balance, plus recurring credits still due, minus committed outflows, minus the
 * everyday spending you reliably do — the one forward-looking number a personal-finance app exists
 * to produce.
 *
 * The discretionary rate deliberately subtracts recurring charges from the trailing-90-day spend
 * before dividing: those are already counted individually in `scheduledOut`, and leaving them in
 * would bill the user twice for the same Netflix.
 */
export function projectMonthEnd(
	store: KpiStore,
	subs: Subscription[],
	series: RecurringSeries[],
	accountIds: string[] | undefined,
	today: Date = new Date()
): MonthEndProjection {
	const from = todayIso(today);
	const eom = lastDayOf(monthOf(from));
	const remainingDays = Math.max(0, daysBetween(from, eom));

	const ids = accountIds ?? liquidAccountIds(store);
	const current = balanceOf(store, ids, from);

	const committed = committedPayments(subs, series, eom, accountIds, today);
	const scheduledOut = committed.reduce((sum, c) => sum + c.amount, 0);

	let scheduledIn = 0;
	for (const s of series) {
		if (s.direction !== "credit") continue;
		if (accountIds && !accountIds.includes(s.accountId)) continue;
		if (s.expectedNextDate <= from || s.expectedNextDate > eom) continue;
		scheduledIn += s.lastAmount;
	}

	// Trailing 90 days of spend, less what the recurring engine already accounts for.
	//
	// Measured over the *spending* accounts rather than the whole portfolio: a broker's buy rows are
	// negative amounts too, and counting a €5,000 ETF purchase as everyday spending would put the
	// discretionary rate an order of magnitude out.
	//
	// The two sides of this subtraction must agree on what counts as spend. `windowSummary` strips
	// transfers *including pair-matched ones*, while `recurringSeries` only knows the category/marker
	// classifier and has no pair detection — so a checking→savings standing order is absent from `spend`
	// but present in `recurringSpend`. Subtracting it drove the difference negative, `Math.max(0, …)`
	// hid that, and the discretionary rate collapsed to €0/day for anyone whose standing order is larger
	// than their everyday spending. Skipping pair-matched occurrences puts both sides on the same books.
	const spendIds = accountIds ?? spendingAccountIds(store);
	const pairIds = transferPairIds(store);
	const windowFrom = shiftDays(from, -89);
	const spend = windowSummary(store, windowFrom, from, spendIds).expenses;
	let recurringSpend = 0;
	for (const s of series) {
		if (s.direction !== "debit") continue;
		if (!spendIds.includes(s.accountId)) continue;
		for (const occ of s.occurrences) {
			if (occ.date < windowFrom || occ.date > from) continue;
			if (!spendIds.includes(occ.accountId)) continue;
			if (pairIds.has(occ.id)) continue;
			recurringSpend += Math.abs(occ.amount);
		}
	}
	const dailyDiscretionary = Math.max(0, (spend - recurringSpend) / 90);
	const discretionary = dailyDiscretionary * remainingDays;
	const projected = current + scheduledIn - scheduledOut - discretionary;

	return {
		current,
		scheduledIn,
		scheduledOut,
		discretionary,
		dailyDiscretionary,
		remainingDays,
		projected,
		safeToSpend: projected - dailyDiscretionary * 7,
		eom,
		committed,
	};
}

/* ---------- income shape ---------- */

export interface IncomeStability {
	/** Coefficient of variation — stdev ÷ mean of monthly income. 0 is a salary to the cent. */
	cv: number;
	label: "Steady" | "Variable" | "Irregular";
	mean: number;
}

/**
 * How predictable the money coming in is, which is what actually decides how much buffer to advise.
 * Undefined below six complete months: a coefficient of variation over three data points is noise
 * dressed as a statistic.
 *
 * Mean and variance run over the months that *had* income, not over all twelve. The trailing window is
 * padded with zeros for months before the ledger starts, and averaging a perfect €3,000 salary against
 * six of those reported "€1,500/mo on average, ±100% month to month" — calling a salary paid to the cent
 * "Irregular" — for every user with less than a year of history.
 */
export function incomeStability(store: KpiStore, accountIds: string[] | undefined, today: Date = new Date()): IncomeStability | undefined {
	const { months } = ttmWindow(today);
	const values = months.map((m) => {
		const w = monthWindow(m);
		return windowSummary(store, w.from, w.to, accountIds).income;
	});
	const active = values.filter((v) => v > 0);
	if (active.length < 6) return undefined;
	const mean = active.reduce((a, b) => a + b, 0) / active.length;
	if (mean <= 0) return undefined;
	const variance = active.reduce((sum, v) => sum + (v - mean) ** 2, 0) / active.length;
	const cv = Math.sqrt(variance) / mean;
	return { cv, mean, label: cv < 0.15 ? "Steady" : cv > 0.5 ? "Irregular" : "Variable" };
}

/* ---------- raw (transfer-preserving) account flows ---------- */

export interface RawAccountFlows {
	/** Every euro that arrived, interest included. Always positive. */
	inflow: number;
	/** Every euro that left, as a positive magnitude. */
	outflow: number;
	/** The part of `inflow` the ledger classifies as passive income — interest and dividends. */
	interest: number;
	/** inflow − outflow. */
	net: number;
}

/**
 * Signed sums over one account's transactions in a window, **without transfer stripping**.
 *
 * This is the contribution/withdrawal source for the savings and investing dashboards, and it exists
 * because `windowSummary` cannot be one: a savings deposit *is* a transfer (pair-matched, and marker-
 * matched via a Deposit/Withdrawal `type` on a saving account), so `windowSummary` correctly removes it
 * — and a page whose entire subject is "how much did you move into this account" then reads €0 for
 * someone saving €500 a month. Contributions are the money that arrived under its own steam:
 * `inflow − interest`. Growth from interest is a different fact and is kept separable rather than being
 * quietly counted as saving.
 */
export function rawAccountFlows(store: KpiStore, accountId: string, window: { from: string; to: string }): RawAccountFlows {
	let inflow = 0;
	let outflow = 0;
	let interest = 0;
	for (const tx of store.transactions) {
		if (tx.accountId !== accountId) continue;
		if (!tx.date || tx.date < window.from || tx.date > window.to) continue;
		if (tx.amount >= 0) {
			inflow += tx.amount;
			if (isPassiveIncome(tx)) interest += tx.amount;
		} else {
			outflow += -tx.amount;
		}
	}
	return { inflow, outflow, interest, net: inflow - outflow };
}

/** The biggest thing that reliably pays you every month — a salary, in almost every ledger. */
export function nextPaycheck(series: RecurringSeries[], accountIds?: string[]): RecurringSeries | undefined {
	return series
		.filter((s) => s.direction === "credit" && s.cycle === "monthly" && (!accountIds || accountIds.includes(s.accountId)))
		.sort((a, b) => b.medianAmount - a.medianAmount)[0];
}

/* ---------- uncategorized share ---------- */

export interface UncategorizedShare {
	share: number;
	amount: number;
	total: number;
	/** Uncategorized transactions across the whole ledger — the number the review CTA counts. */
	count: number;
}

/** Uncategorized spend as a share of the trailing three complete months — the trust-bar figure. */
export function uncategorizedShare(store: KpiStore, today: Date = new Date()): UncategorizedShare {
	const { from, to } = ttmWindow(today, 3);
	let amount = 0;
	let total = 0;
	for (const tx of store.transactions) {
		if (tx.amount >= 0 || !tx.date || tx.date < from || tx.date > to) continue;
		total += -tx.amount;
		if (!tx.categoryId) amount += -tx.amount;
	}
	const count = store.transactions.filter((t) => !t.categoryId).length;
	return { share: total > 0 ? amount / total : 0, amount, total, count };
}

/* ---------- navigation & commands ---------- */

/**
 * Runs one of the workflow commands by id rather than importing its module: the command surface is
 * the seam between this wave and the workflows wave, and a missing command is a no-op here instead
 * of a compile error.
 */
export function runCommand(plugin: FinancePlugin, id: string): void {
	const commands = (plugin.app as unknown as { commands?: { executeCommandById?: (id: string) => boolean } }).commands;
	commands?.executeCommandById?.(`finance-plugin:${id}`);
}

export function hasCommand(plugin: FinancePlugin, id: string): boolean {
	const commands = (plugin.app as unknown as { commands?: { commands?: Record<string, unknown> } }).commands;
	return !!commands?.commands?.[`finance-plugin:${id}`];
}

export async function goToAccount(plugin: FinancePlugin, accountId: string): Promise<void> {
	plugin.settings.activeAccountId = accountId;
	plugin.settings.activeView = undefined;
	await plugin.saveSettings();
	plugin.refreshViews();
}

export async function goToView(plugin: FinancePlugin, view: "budgets" | "subscriptions" | "cards"): Promise<void> {
	plugin.settings.activeView = view;
	await plugin.saveSettings();
	plugin.refreshViews();
}

/* ---------- small DOM primitives ---------- */

/** A card header: title on the left, an optional right-hand label or action slot. */
export function cardHead(parent: HTMLElement, title: string, opts: { label?: string; sub?: string } = {}): HTMLElement {
	const head = parent.createDiv({ cls: "fp-card-head" });
	const left = head.createDiv({ cls: "fp-card-head-main" });
	left.createEl("h3", { cls: "fp-card-title", text: title });
	if (opts.sub) left.createDiv({ cls: "fp-card-sub", text: opts.sub });
	if (opts.label) head.createDiv({ cls: "fp-card-head-label", text: opts.label });
	return head;
}

export function sectionCard(parent: HTMLElement, title: string, opts: { label?: string; sub?: string } = {}): HTMLElement {
	const card = parent.createDiv({ cls: "fp-card" });
	cardHead(card, title, opts);
	return card;
}

export interface TriStatItem {
	label: string;
	value: string;
	/** `in` is the only figure that earns color — outgoings read in normal ink. */
	tone?: "in" | "neutral" | "alarm";
	money?: boolean;
}

/**
 * Three related figures in one tile. "In / out / net this month" is one idea, and splitting it
 * across three tiles both triples the chrome and implies the three compete for the reader's
 * attention, which they don't.
 */
export function renderTriStat(
	parent: HTMLElement,
	opts: { label: string; iconName?: string; items: TriStatItem[]; foot?: string }
): HTMLElement {
	const card = parent.createDiv({ cls: "fp-stat fp-stat--multi fp-card fp-card--tight" });
	const eyebrow = card.createDiv({ cls: "fp-stat-eyebrow fp-overline" });
	if (opts.iconName) icon(eyebrow, opts.iconName, "fp-stat-icon");
	eyebrow.createSpan({ cls: "fp-stat-label", text: opts.label });

	const row = card.createDiv({ cls: "fp-stat-multi-row" });
	for (const item of opts.items) {
		const cell = row.createDiv({ cls: "fp-stat-multi-item" });
		cell.createDiv({ cls: "fp-stat-multi-label", text: item.label });
		cell.createDiv({
			cls: [
				"fp-stat-multi-value",
				item.money === false ? "" : "fp-money",
				item.tone === "in" ? "fp-amount--in" : item.tone === "alarm" ? "fp-amount--alarm" : "",
			]
				.filter(Boolean)
				.join(" "),
			text: item.value,
		});
	}
	if (opts.foot) card.createDiv({ cls: "fp-stat-foot", text: opts.foot });
	return card;
}

export type FootPart = string | { money: string };

/**
 * Replaces a stat's footnote with mixed text/money spans. `renderStat`'s `sub` is a plain string, so
 * any money inside it would escape privacy redaction — this keeps the `.fp-money` contract intact
 * for the footnotes that carry a figure.
 */
export function setStatFoot(card: HTMLElement, parts: FootPart[]): void {
	const existing = card.querySelector(".fp-stat-foot") as HTMLElement | null;
	const foot = existing ?? card.createDiv({ cls: "fp-stat-foot" });
	foot.empty();
	for (const part of parts) {
		if (typeof part === "string") foot.createSpan({ text: part });
		else foot.createSpan({ cls: "fp-money", text: part.money });
	}
}

/** A money figure that always carries the privacy hook. */
export function moneySpan(parent: HTMLElement, text: string, cls?: string): HTMLElement {
	return parent.createSpan({ cls: ["fp-money", cls].filter(Boolean).join(" "), text });
}

export interface EditableAmountOpts {
	/** Shown on the trigger when no value is set yet. */
	emptyLabel: string;
	/** Shown on the trigger when a value exists. */
	editLabel?: string;
	value?: number;
	placeholder?: string;
	min?: number;
	onSave: (value: number | undefined) => Promise<void>;
}

/**
 * The manual-number affordance behind `marketValue`, `creditLimit` and `goalAmount`: a ghost button
 * that swaps itself for an input in place. Deliberately inline rather than another modal — these are
 * one-number edits the user makes while looking at the figure they change.
 */
export function editableAmount(parent: HTMLElement, opts: EditableAmountOpts): HTMLElement {
	const wrap = parent.createDiv({ cls: "fp-inline-edit" });

	const renderTrigger = () => {
		wrap.empty();
		const btn = wrap.createEl("button", {
			cls: "fp-btn fp-btn--ghost fp-inline-edit-trigger",
			attr: { type: "button" },
		});
		icon(btn, opts.value === undefined ? "plus" : "pencil");
		btn.createSpan({ text: opts.value === undefined ? opts.emptyLabel : opts.editLabel ?? "Update" });
		btn.addEventListener("click", renderEditor);
	};

	const renderEditor = () => {
		wrap.empty();
		const input = wrap.createEl("input", {
			cls: "fp-input fp-inline-edit-input",
			type: "text",
			attr: {
				inputmode: "decimal",
				min: String(opts.min ?? 0),
				placeholder: opts.placeholder ?? "0.00",
				"aria-label": opts.emptyLabel,
			},
		});
		input.value = opts.value === undefined ? "" : String(opts.value);

		const commit = async () => {
			const parsed = parseAmount(input.value);
			await opts.onSave(parsed !== undefined && parsed >= 0 ? parsed : undefined);
		};

		const save = wrap.createEl("button", { cls: "fp-btn fp-btn--primary", text: "Save", attr: { type: "button" } });
		save.addEventListener("click", () => void commit());
		const cancel = wrap.createEl("button", { cls: "fp-btn fp-btn--ghost", text: "Cancel", attr: { type: "button" } });
		cancel.addEventListener("click", renderTrigger);

		input.addEventListener("keydown", (ev: KeyboardEvent) => {
			if (ev.key === "Enter") void commit();
			if (ev.key === "Escape") renderTrigger();
		});
		window.setTimeout(() => input.focus(), 0);
	};

	renderTrigger();
	return wrap;
}

/**
 * "Updated 12 Aug 2025" for a manually-entered valuation, nagging once it goes stale. A market value
 * the user set eight months ago is not wrong, but every figure derived from it deserves its age
 * printed next to it.
 */
export function valuationAge(asOf: string | undefined, today: Date = new Date()): { text: string; stale: boolean } {
	if (!asOf) return { text: "never updated", stale: true };
	const days = daysBetween(asOf, todayIso(today));
	if (days <= 0) return { text: "updated today", stale: false };
	if (days === 1) return { text: "updated yesterday", stale: false };
	return { text: `updated ${formatDay(asOf)}`, stale: days > 90 };
}
