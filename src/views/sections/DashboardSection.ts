import { budgetStatuses, budgetSummary, currentMonth } from "../../budgets";
import { ACCOUNT_TYPE_META } from "../../constants";
import {
	balanceSeries,
	fiProjection,
	firstDayOf,
	lastDayOf,
	monthOf,
	netWorth,
	shiftMonth,
	summarizeByYear,
	todayIso,
	windowSummary,
	type YearSummary,
} from "../../kpi";
import type FinancePlugin from "../../main";
import { MonthDrilldownModal } from "../../modals/MonthDrilldownModal";
import { recurringSeries, type RecurringSeries } from "../../recurring";
import type { Account } from "../../types";
import { lineChart, stackedShareBar } from "../../ui/charts";
import { emptyState, icon, renderStat, tabSwitcher } from "../../ui/dom";
import { renderMeter } from "../../ui/kpiCard";
import { deltaRow, formatEUR, formatPct as tableFormatPct, metricRow, yearHeaderRow } from "../../ui/metricsTable";
import { openImportWizard } from "../../wizards/ImportWizard";
import { renderCategoryFlowCard } from "./CategoryFlow";
import { renderInsightsFeed } from "./InsightsFeed";
import { busiestAccountId, goToLedger, UNCATEGORIZED } from "./LedgerSection";
import {
	balanceOf,
	catColor,
	cardHead,
	committedPayments,
	daysBetween,
	formatDay,
	goToAccount,
	goToView,
	honestNetWorth,
	liquidAccountIds,
	money,
	monthWindow,
	pct,
	portfolioCurrency,
	projectMonthEnd,
	relativeDays,
	setStatFoot,
	shiftDays,
	signedMoney,
	ttmWindow,
	uncategorizedShare,
} from "./shared";

/* ==========================================================================
   Row 0 — trust bar
   ========================================================================== */

/**
 * One muted line above everything, because every number below is conditional on it: how current the
 * data is, and how much of recent spend has no category — i.e. how much of this page is a lower
 * bound rather than a figure.
 */
function renderTrustBar(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;
	const latest = store.transactions.reduce<string | undefined>((max, t) => (t.date && (!max || t.date > max) ? t.date : max), undefined);
	const share = uncategorizedShare(store);
	const tone = share.share >= 0.3 ? "is-bad" : share.share >= 0.15 ? "is-warn" : "";

	const bar = container.createDiv({ cls: `fp-trustbar ${tone}`.trim() });
	bar.createSpan({ text: latest ? `Data through ${formatDay(latest)}` : "No transactions imported yet" });
	bar.createSpan({ cls: "fp-trustbar-sep", text: "·" });
	bar.createSpan({ text: `${store.accounts.length} account${store.accounts.length === 1 ? "" : "s"}` });

	// Every total on this page is a 1:1 sum across whatever currencies the accounts are in, stamped
	// with one symbol (`portfolioCurrency` falls back to EUR when they disagree). That is a caveat on
	// the whole page, which is exactly what this bar is for.
	const currencies = new Set(store.accounts.map((a) => a.currency || "EUR"));
	if (currencies.size > 1) {
		bar.createSpan({ cls: "fp-trustbar-sep", text: "·" });
		bar.createSpan({
			cls: "fp-trustbar-flag",
			text: `mixed currencies (${Array.from(currencies).sort().join(", ")}) summed 1:1`,
		});
	}

	if (share.total <= 0) return;
	// The figure is portfolio-wide over the trailing 3 complete months, but the ledger only renders on
	// an account page — so the link says which account it opens, and carries the same 3-month window
	// it just quoted. Before, a portfolio-wide 3-month number opened one account's entire history.
	const { from, to } = ttmWindow(new Date(), 3);
	const destination = store.accounts.find((a) => a.id === busiestAccountId(store));
	bar.createSpan({ cls: "fp-trustbar-sep", text: "·" });
	const link = bar.createEl("button", {
		cls: "fp-trustbar-link",
		text: destination
			? `${pct(share.share)} of trailing 3-month spend uncategorized — review in ${destination.name}`
			: `${pct(share.share)} of trailing 3-month spend uncategorized`,
		attr: { type: "button" },
	});
	link.addEventListener("click", () =>
		void goToLedger(plugin, { categoryId: UNCATEGORIZED, preset: "custom", dateFrom: from, dateTo: to }, destination?.id)
	);
}

/* ==========================================================================
   The portfolio projection
   ========================================================================== */

/**
 * `projectMonthEnd`'s single `accountIds` knob answers two questions that want different answers at
 * portfolio scope:
 *
 * - *what balance am I projecting?* — the liquid accounts, because a credit card's balance is a debt,
 *   not a buffer you can spend from;
 * - *what everyday spending do I do?* — the spending accounts, credit included, because a card
 *   purchase does drain checking eventually and excluding it overstates the runway.
 *
 * Left at `undefined` it takes the liquid answer for the balance and the portfolio-wide answer for
 * the commitments, so a €400/mo SaaS charged to a card was subtracted from a checking balance it will
 * never touch — enough to print "projected short before 31 Aug" for someone who isn't. The
 * commitments are re-derived here over the same accounts the balance is measured on; everything else
 * (including the deliberately broader discretionary base) is left exactly as the helper computed it.
 */
function portfolioProjection(plugin: FinancePlugin, series: RecurringSeries[], today: Date) {
	const store = plugin.store;
	const base = projectMonthEnd(store, store.subscriptions, series, undefined, today);
	const liquid = liquidAccountIds(store);
	const committed = committedPayments(store.subscriptions, series, base.eom, liquid, today);
	const scheduledOut = committed.reduce((sum, c) => sum + c.amount, 0);
	const projected = base.current + base.scheduledIn - scheduledOut - base.discretionary;
	return { ...base, committed, scheduledOut, projected, safeToSpend: projected - base.dailyDiscretionary * 7 };
}

/* ==========================================================================
   Row 1 — the three figures that answer "how am I doing?"
   ========================================================================== */

function renderHeroRow(container: HTMLElement, plugin: FinancePlugin, series: RecurringSeries[], today: Date): void {
	const store = plugin.store;
	const currency = portfolioCurrency(store);
	const month = monthOf(todayIso(today));

	const worth = honestNetWorth(store);
	// Ledger month-end balances: the right *shape* for a trend even though the hero figure prefers a
	// manually-entered market value where one exists.
	const balances = balanceSeries(store, undefined, "month", today).slice(-24);
	const last = balances[balances.length - 1]?.balance;
	const prev = balances[balances.length - 2]?.balance;
	const worthDelta = last !== undefined && prev !== undefined && prev !== 0 ? (last - prev) / Math.abs(prev) : undefined;

	const grid = container.createDiv({ cls: "fp-stat-grid" });

	const worthCard = renderStat(grid, {
		label: "Net worth",
		value: money(worth.total, currency),
		size: "hero",
		iconName: "wallet",
		delta: worthDelta === undefined ? undefined : { value: worthDelta },
		sparklineValues: balances.map((b) => b.balance),
		sparklineColor: "var(--fp-series-worth)",
	});
	if (worth.atCost > 0) {
		setStatFoot(worthCard, ["incl. ", { money: money(worth.atCost, currency) }, " still valued at cost"]);
	} else if (worth.oldestAsOf) {
		setStatFoot(worthCard, [`market values as of ${formatDay(worth.oldestAsOf)}`]);
	}

	// This month's cashflow, with the projected close underneath it.
	const m0 = windowSummary(store, firstDayOf(month), lastDayOf(month));
	const netByMonth: number[] = [];
	for (let i = 12; i >= 0; i--) {
		const key = shiftMonth(month, -i);
		const w = monthWindow(key);
		netByMonth.push(windowSummary(store, w.from, w.to).net);
	}
	const projection = portfolioProjection(plugin, series, today);
	const cashflowCard = renderStat(grid, {
		label: "This month's cashflow",
		value: signedMoney(m0.net, currency),
		iconName: "arrow-left-right",
		sparklineValues: netByMonth,
		sparklineColor: "var(--fp-series-net)",
	});
	setStatFoot(cashflowCard, ["projected ", { money: money(projection.projected, currency) }, " at month end"]);

	// Savings rate over the 12 complete months — never a partial-year figure, which is what made the
	// old "this year" version read as −99% every January.
	const ttm = ttmWindow(today);
	const ttmSummary = windowSummary(store, ttm.from, ttm.to);
	// The 12 complete months *before* those twelve — the only honest comparison for a trailing rate.
	const priorSummary = windowSummary(store, firstDayOf(shiftMonth(ttm.months[0], -12)), shiftDays(ttm.from, -1));
	const rateDelta = priorSummary.income > 0 ? ttmSummary.savingsRate - priorSummary.savingsRate : undefined;
	const rateCard = renderStat(grid, {
		label: "Savings rate (trailing 12 months)",
		value: pct(ttmSummary.savingsRate),
		iconName: "piggy-bank",
		money: false,
		// Percentage *points*: this delta is a difference of two rates (20% → 25% is +5pp), not the
		// relative change the net-worth chip above it shows.
		delta: rateDelta === undefined || !Number.isFinite(rateDelta) ? undefined : { value: rateDelta, unit: "pp" as const },
	});
	setStatFoot(rateCard, [{ money: money(ttmSummary.net, currency) }, " kept of ", { money: money(ttmSummary.income, currency) }, " earned"]);
}

/* ==========================================================================
   Row 2 — projected end-of-month balance
   ========================================================================== */

function renderProjection(container: HTMLElement, plugin: FinancePlugin, series: RecurringSeries[], today: Date): void {
	const store = plugin.store;
	const currency = portfolioCurrency(store);
	const p = portfolioProjection(plugin, series, today);
	if (p.current === 0 && p.committed.length === 0 && p.dailyDiscretionary === 0) return;

	const ratio = p.current > 0 ? Math.max(0, p.projected) / p.current : 0;
	const tone = p.projected < 0 ? "over" : p.safeToSpend < 0 ? "warn" : "ok";

	renderMeter(container, {
		label: p.projected < 0 ? `Projected short before ${formatDay(p.eom, { short: true })}` : "Projected end-of-month balance",
		value: ratio,
		valueLabel: money(p.projected, currency),
		tone,
		renderSub: (el) => {
			const line = el.createDiv({ cls: "fp-projection-line" });
			const part = (label: string, value: string) => {
				const item = line.createSpan({ cls: "fp-projection-part" });
				item.createSpan({ cls: "fp-money", text: value });
				item.createSpan({ cls: "fp-projection-part-label", text: ` ${label}` });
			};
			part("now", money(p.current, currency));
			if (p.scheduledIn > 0) part("expected in", money(p.scheduledIn, currency));
			part("committed out", money(p.scheduledOut, currency));
			part(`everyday spend (${p.remainingDays}d left)`, money(p.discretionary, currency));

			const verdict = el.createDiv({ cls: "fp-projection-verdict" });
			if (p.projected < 0) {
				verdict.createSpan({ text: "On this pace the balance runs out before the month does." });
			} else {
				verdict.createSpan({ cls: "fp-money", text: money(Math.max(0, p.safeToSpend), currency) });
				verdict.createSpan({ text: " safe to spend on top of your usual — keeps one week of buffer." });
			}
		},
	});
}

/* ==========================================================================
   Row 3 — budget health
   ========================================================================== */

function renderBudgetStrip(container: HTMLElement, plugin: FinancePlugin, today: Date): void {
	const store = plugin.store;
	const currency = portfolioCurrency(store);
	const month = currentMonth();
	const categories = store.categories.filter((c) => !c.archived);
	const summary = budgetSummary(store, categories, month, today);

	const card = container.createDiv({ cls: "fp-card" });
	cardHead(card, "Budget health", { sub: `Pace-adjusted for ${pct(summary.elapsed)} through the month` });

	if (summary.totalBudget <= 0) {
		emptyState(card, {
			variant: "inline",
			iconName: "target",
			title: "No budgets set",
			description: "Set a monthly limit on the categories you actually want to hold a line on.",
			actionLabel: "Set up budgets",
			onAction: () => void goToView(plugin, "budgets"),
		});
		return;
	}

	renderMeter(card, {
		label: "Total budgeted",
		value: summary.totalSpent / summary.totalBudget,
		valueLabel: `${money(summary.totalSpent, currency)} of ${money(summary.totalBudget, currency)}`,
		pace: summary.elapsed,
		// Pace, not raw percentage, is the tone driver: 20% spent on the 3rd finishes the month at 200%.
		tone: summary.totalSpent > summary.totalBudget ? "over" : summary.pace >= 1 ? "warn" : "ok",
		renderSub: (el) => {
			const parts: string[] = [];
			if (summary.overCount > 0) parts.push(`${summary.overCount} over budget`);
			if (summary.projectedOverCount > 0) parts.push(`${summary.projectedOverCount} projected over`);
			parts.push(summary.pace >= 1 ? "spending ahead of pace" : "tracking under pace");
			el.createSpan({ text: parts.join(" · ") });
			if (summary.unbudgetedSpend > 0) {
				el.createSpan({ text: " · " });
				el.createSpan({ cls: "fp-money", text: money(summary.unbudgetedSpend, currency) });
				el.createSpan({ text: " spent in categories with no limit" });
			}
		},
	});

	const statuses = budgetStatuses(store, categories, month, today)
		.sort((a, b) => b.pace - a.pace)
		.slice(0, 5);
	const categoryById = new Map(categories.map((c) => [c.id, c]));
	const list = card.createDiv({ cls: "fp-budget-strip" });
	statuses.forEach((s) => {
		const cat = categoryById.get(s.categoryId);
		const row = list.createDiv({ cls: `fp-budget-strip-row fp-tone-${s.tone}` });
		const head = row.createDiv({ cls: "fp-budget-strip-head" });
		head.createSpan({ cls: "fp-budget-strip-name", text: cat?.name ?? s.categoryId });
		const value = head.createSpan({ cls: "fp-budget-strip-value" });
		value.createSpan({ cls: "fp-money", text: money(s.spent, currency) });
		value.createSpan({ text: " of " });
		value.createSpan({ cls: "fp-money", text: money(s.budget, currency) });

		const track = row.createDiv({ cls: "fp-meter-track fp-budget-strip-track" });
		const fill = track.createDiv({ cls: "fp-meter-fill" });
		const filled = Math.max(0, Math.min(100, s.pct * 100));
		fill.style.width = `${filled}%`;
		track.style.setProperty("--fp-meter-cap", `${filled}%`);
		if (s.elapsed > 0 && s.elapsed < 1) {
			const pace = track.createDiv({ cls: "fp-meter-pace" });
			pace.style.left = `${s.elapsed * 100}%`;
		}
		row.createDiv({
			cls: "fp-budget-strip-foot",
			text: s.remaining >= 0 ? `${money(s.remaining, currency)} left` : `${money(-s.remaining, currency)} over`,
		}).addClass("fp-money");
	});

	const open = card.createEl("button", { cls: "fp-btn fp-btn--ghost", text: "Open budgets", attr: { type: "button" } });
	open.addEventListener("click", () => void goToView(plugin, "budgets"));
}

/* ==========================================================================
   Row 4 — the next 30 days
   ========================================================================== */

function renderNext30(container: HTMLElement, plugin: FinancePlugin, series: RecurringSeries[], today: Date): void {
	const store = plugin.store;
	const currency = portfolioCurrency(store);
	const now = todayIso(today);
	const until = shiftDays(now, 30);
	const p = portfolioProjection(plugin, series, today);
	// Same scope as the running balance below it: this table subtracts each payment from a liquid
	// balance, so a charge that lands on a credit card has no business in the column.
	const payments = committedPayments(store.subscriptions, series, until, liquidAccountIds(store), today);

	const total = payments.reduce((sum, c) => sum + c.amount, 0);
	const card = container.createDiv({ cls: "fp-card" });
	cardHead(card, "Next 30 days", {
		label: payments.length > 0 ? `${payments.length} payment${payments.length === 1 ? "" : "s"}` : undefined,
		sub: payments.length > 0 ? `${money(total, currency)} committed before ${formatDay(until, { short: true })}` : undefined,
	});

	if (payments.length === 0) {
		emptyState(card, {
			variant: "inline",
			iconName: "calendar-check",
			title: "Nothing committed in the next 30 days",
			description: "Tracked subscriptions and recurring charges detected in your ledger both show up here.",
		});
		return;
	}

	const wrap = card.createDiv({ cls: "fp-table-scroll" });
	const table = wrap.createEl("table", { cls: "fp-table fp-table--dense" });
	const thead = table.createEl("thead").createEl("tr");
	["Date", "Payment", "Amount", "Balance after"].forEach((h, i) =>
		thead.createEl("th", { text: h, cls: i >= 2 ? "fp-table-num" : undefined, attr: { scope: "col" } })
	);
	const tbody = table.createEl("tbody");

	// A running balance is what turns a list of dates into an answer: it shows which day you'd go
	// negative, which no per-row amount ever can.
	let running = balanceOf(store, liquidAccountIds(store), now);
	payments.forEach((c) => {
		running -= c.amount;
		const tr = tbody.createEl("tr");
		const dateCell = tr.createEl("td", { cls: "fp-cell-date" });
		dateCell.createSpan({ text: formatDay(c.date, { short: true }) });
		dateCell.createSpan({ cls: "fp-next30-rel", text: ` ${relativeDays(daysBetween(now, c.date))}` });
		const nameCell = tr.createEl("td");
		nameCell.createSpan({ text: c.label });
		if (c.source === "recurring") nameCell.createSpan({ cls: "fp-next30-tag", text: "detected" });
		tr.createEl("td", { cls: "fp-amount fp-money", text: money(-c.amount, currency, 2) });
		tr.createEl("td", { cls: "fp-amount fp-money" + (running < 0 ? " fp-amount--alarm" : ""), text: money(running, currency) });
	});

	if (p.projected < 0) {
		card.createDiv({ cls: "fp-card-note is-bad", text: "These commitments take the projected balance below zero before month end." });
	}
}

/* ==========================================================================
   Row 7 — accounts overview
   ========================================================================== */

function renderAccountsOverview(container: HTMLElement, plugin: FinancePlugin, today: Date): void {
	const store = plugin.store;
	const currency = portfolioCurrency(store);
	const now = todayIso(today);
	const monthAgo = shiftDays(now, -30);

	const rows = store.accounts.map((account) => {
		const balance = netWorth(store, account.id, now);
		const dates = store.transactions.filter((t) => t.accountId === account.id).map((t) => t.date);
		const lastActivity = dates.reduce<string | undefined>((max, d) => (d && (!max || d > max) ? d : max), undefined);
		return {
			account,
			balance,
			delta30: balance - netWorth(store, account.id, monthAgo),
			lastActivity,
			count: dates.length,
		};
	});

	const assets = rows.filter((r) => r.balance >= 0);
	const liabilities = rows.filter((r) => r.balance < 0);
	const assetTotal = assets.reduce((sum, r) => sum + r.balance, 0);
	const liabilityTotal = liabilities.reduce((sum, r) => sum + r.balance, 0);

	const card = container.createDiv({ cls: "fp-card" });
	cardHead(card, "Accounts");

	// Assets / Liabilities / Net as three explicit figures. The old chart filtered to `worth > 0`,
	// so credit-card debt silently vanished from a card titled "Accounts overview".
	const totals = card.createDiv({ cls: "fp-account-totals" });
	const totalItem = (label: string, value: number, cls?: string) => {
		const item = totals.createDiv({ cls: "fp-account-total" });
		item.createDiv({ cls: "fp-overline", text: label });
		item.createDiv({ cls: `fp-account-total-value fp-money ${cls ?? ""}`.trim(), text: money(value, currency) });
	};
	totalItem("Assets", assetTotal);
	totalItem("Liabilities", liabilityTotal, liabilityTotal < 0 ? "is-liability" : undefined);
	totalItem("Net", assetTotal + liabilityTotal);

	if (assets.length > 0) {
		stackedShareBar(
			card,
			assets.map((r, i) => ({ label: r.account.name, value: r.balance, color: catColor(i) })),
			{ formatValue: (n) => money(n, currency) }
		);
	}

	const wrap = card.createDiv({ cls: "fp-table-scroll" });
	const table = wrap.createEl("table", { cls: "fp-table" });
	const thead = table.createEl("thead").createEl("tr");
	thead.createEl("th", { text: "Account", attr: { scope: "col" } });
	thead.createEl("th", { text: "Type", attr: { scope: "col" } });
	["Balance", "Δ 30 days", "Last activity"].forEach((h) => thead.createEl("th", { text: h, cls: "fp-table-num", attr: { scope: "col" } }));
	const tbody = table.createEl("tbody");

	const group = (label: string, items: typeof rows) => {
		if (items.length === 0) return;
		const header = tbody.createEl("tr", { cls: "fp-table-group" });
		header.createEl("td", { text: label, attr: { colspan: "5" } });
		items.forEach((r) => renderAccountRow(tbody, plugin, r, currency, now));
	};
	group("Assets", assets);
	group("Liabilities", liabilities);
}

function renderAccountRow(
	tbody: HTMLTableSectionElement,
	plugin: FinancePlugin,
	row: { account: Account; balance: number; delta30: number; lastActivity?: string; count: number },
	currency: string,
	now: string
): void {
	const tr = tbody.createEl("tr", { cls: "fp-table-row-clickable", attr: { tabindex: "0" } });
	const open = () => void goToAccount(plugin, row.account.id);
	tr.addEventListener("click", open);
	tr.addEventListener("keydown", (ev: KeyboardEvent) => {
		if (ev.key === "Enter" || ev.key === " ") {
			ev.preventDefault();
			open();
		}
	});

	const nameCell = tr.createEl("td").createDiv({ cls: "fp-accounts-overview-name" });
	icon(nameCell, ACCOUNT_TYPE_META[row.account.type].icon, "fp-accounts-overview-icon");
	nameCell.createSpan({ text: row.account.name });

	tr.createEl("td", { text: ACCOUNT_TYPE_META[row.account.type].label });
	tr.createEl("td", { text: money(row.balance, currency), cls: "fp-table-num fp-money" });
	tr.createEl("td", {
		text: row.count === 0 ? "—" : signedMoney(row.delta30, currency),
		cls: "fp-table-num fp-money" + (row.delta30 > 0 ? " fp-amount--in" : ""),
	});

	// A stale account is usually a forgotten re-import, and every total on this page is wrong by
	// however much it has missed.
	const staleDays = row.lastActivity ? daysBetween(row.lastActivity, now) : undefined;
	tr.createEl("td", {
		text: row.lastActivity ? formatDay(row.lastActivity, { short: true }) : "—",
		cls: "fp-table-num" + (staleDays !== undefined && staleDays > 45 ? " fp-cell-stale" : ""),
	});
}

/* ==========================================================================
   Row 8 — financial independence
   ========================================================================== */

function renderFi(container: HTMLElement, plugin: FinancePlugin, today: Date): void {
	const store = plugin.store;
	const currency = portfolioCurrency(store);
	const ttm = ttmWindow(today);
	const summary = windowSummary(store, ttm.from, ttm.to);
	const worth = honestNetWorth(store).total;

	// Every input is trailing-twelve-month. Fed the calendar year instead, this meter read 4000% on
	// 3 January, because three days of expenses × 25 is not an FI number.
	const fiNumber = summary.expenses * plugin.settings.fiMultiplier;
	const fiRatio = fiNumber > 0 ? worth / fiNumber : 0;
	const monthlyContribution = summary.net / 12;
	const yearsToFi = fiNumber > 0 ? fiProjection(worth, monthlyContribution, plugin.settings.expectedReturn, fiNumber) : undefined;

	renderMeter(container, {
		label: "Progress to financial independence",
		value: fiRatio,
		valueLabel: pct(fiRatio, fiRatio < 0.1 ? 1 : 0),
		tone: "ok",
		sub: fiNumber > 0 ? undefined : "Import 12 months of transactions to calculate your FI number.",
		renderSub:
			fiNumber > 0
				? (el) => {
						el.createSpan({ cls: "fp-money", text: money(worth, currency) });
						el.createSpan({ text: " of " });
						el.createSpan({ cls: "fp-money", text: money(fiNumber, currency) });
						el.createSpan({ text: ` (${plugin.settings.fiMultiplier}× trailing-12-month expenses)` });
						if (yearsToFi !== undefined && monthlyContribution > 0) {
							el.createSpan({ text: " · " });
							el.createSpan({ cls: "fp-money", text: money(monthlyContribution, currency) });
							el.createSpan({
								text: `/mo saved → ${yearsToFi.toFixed(1)} years at ${(plugin.settings.expectedReturn * 100).toFixed(0)}% return`,
							});
						}
				  }
				: undefined,
	});
}

/* ==========================================================================
   Row 9 — historical performance (demoted, kept)
   ========================================================================== */

function renderHistoryTable(panel: HTMLElement, plugin: FinancePlugin, years: YearSummary[], fiMultiplier: number): void {
	const wrap = panel.createDiv({ cls: "fp-table-scroll" });
	const table = wrap.createEl("table", { cls: "fp-table fp-table-metrics" });
	yearHeaderRow(
		table,
		years.map((y) => y.year),
		{ onClick: (year) => new MonthDrilldownModal(plugin.app, plugin, year).open() }
	);
	const tbody = table.createEl("tbody");

	// `formatEUR` is passed by reference on purpose: `metricRow` detects money by identity to attach
	// the privacy hook, and wrapping it would silently drop `.fp-money` from every cell.
	metricRow(tbody, "Total income", years.map((y) => y.income), formatEUR, { heat: "normal" });
	deltaRow(tbody, years.map((y) => y.income));

	metricRow(tbody, "Total expenses", years.map((y) => y.expenses), formatEUR, { heat: "invert" });
	deltaRow(tbody, years.map((y) => y.expenses), { invert: true });

	metricRow(tbody, "Net savings", years.map((y) => y.net), formatEUR, { emphasize: true, heat: "normal" });
	metricRow(tbody, "Savings rate", years.map((y) => y.savingsRate), (n) => tableFormatPct(n), { heat: "normal" });

	metricRow(tbody, "Net worth (EOY)", years.map((y) => y.netWorthEOY), formatEUR, { emphasize: true, heat: "normal" });
	deltaRow(tbody, years.map((y) => y.netWorthEOY));

	metricRow(tbody, `FI number (${fiMultiplier}× expenses)`, years.map((y) => y.expenses * fiMultiplier), formatEUR);
	metricRow(
		tbody,
		"FI ratio",
		years.map((y) => (y.expenses > 0 ? y.netWorthEOY / (y.expenses * fiMultiplier) : 0)),
		(n) => tableFormatPct(n),
		{ heat: "normal" }
	);
	metricRow(tbody, "Passive income", years.map((y) => y.passiveIncome), formatEUR, { heat: "normal" });
}

/**
 * Two charts, not five lines on one axis: net worth is six figures and passive income is three, so
 * sharing a scale flatlines the smaller series into the baseline.
 */
function renderHistoryChart(panel: HTMLElement, years: YearSummary[]): void {
	const categories = years.map((y) => y.year);

	panel.createEl("h4", { cls: "fp-chart-heading", text: "Net worth" });
	lineChart(panel, categories, [{ label: "Net worth (EOY)", color: "var(--fp-series-worth)", values: years.map((y) => y.netWorthEOY) }], {
		area: true,
		title: "Net worth at end of year",
		description: `Year-end net worth from ${categories[0]} to ${categories[categories.length - 1]}.`,
	});

	panel.createEl("h4", { cls: "fp-chart-heading", text: "Income vs expenses" });
	lineChart(
		panel,
		categories,
		[
			{ label: "Income", color: "var(--fp-series-income)", values: years.map((y) => y.income) },
			{ label: "Expenses", color: "var(--fp-series-expenses)", values: years.map((y) => y.expenses) },
			{ label: "Net savings", color: "var(--fp-series-net)", values: years.map((y) => y.net) },
		],
		{ title: "Income, expenses and net savings by year", description: "Annual totals, transfers excluded." }
	);
}

function renderHistory(container: HTMLElement, plugin: FinancePlugin, years: YearSummary[]): void {
	const card = container.createDiv({ cls: "fp-card" });
	cardHead(card, "Historical performance", { sub: `${years[0].year}–${years[years.length - 1].year} · the current year is still partial` });
	tabSwitcher(card, [
		{ label: "Table", render: (panel) => renderHistoryTable(panel, plugin, years, plugin.settings.fiMultiplier) },
		{ label: "Chart", render: (panel) => renderHistoryChart(panel, years) },
	]);
}

/* ==========================================================================
   Entry point
   ========================================================================== */

/** The "All Accounts" home screen: what you're worth, what's about to happen, and what needs doing. */
export function renderAllAccountsDashboard(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;
	const today = new Date();

	if (store.transactions.length === 0) {
		emptyState(container, {
			iconName: "inbox",
			title: "No transactions yet",
			description: "Import a bank or broker export and this page fills in: net worth, cashflow, upcoming payments and insights.",
			actionLabel: "Import transactions",
			onAction: () => openImportWizard(plugin),
		});
		if (store.accounts.length > 0) renderAccountsOverview(container, plugin, today);
		return;
	}

	// Grouping the ledger by merchant is the most expensive thing on this page; five rows need it,
	// so it happens once and is threaded through.
	const series = recurringSeries(store);

	renderTrustBar(container, plugin);
	renderHeroRow(container, plugin, series, today);
	renderProjection(container, plugin, series, today);
	renderBudgetStrip(container, plugin, today);
	renderNext30(container, plugin, series, today);
	renderCategoryFlowCard(container, plugin, { today });
	renderInsightsFeed(container, plugin, series);
	renderAccountsOverview(container, plugin, today);
	renderFi(container, plugin, today);

	const years = summarizeByYear(store);
	if (years.length > 0) renderHistory(container, plugin, years);
}
