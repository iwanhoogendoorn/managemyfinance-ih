import {
	balanceSeries,
	burnRate,
	firstDayOf,
	lastDayOf,
	monthOf,
	netWorth,
	shiftMonth,
	summarizeByYear,
	todayIso,
	windowSummary,
} from "../../../kpi";
import type FinancePlugin from "../../../main";
import { MonthDrilldownModal } from "../../../modals/MonthDrilldownModal";
import { recurringSeries } from "../../../recurring";
import { monthlyCost } from "../../../subscriptions";
import type { Account } from "../../../types";
import { groupedColumnChart } from "../../../ui/charts";
import { renderStat } from "../../../ui/dom";
import { renderMeter } from "../../../ui/kpiCard";
import { deltaRow, formatEUR, formatPct as tableFormatPct, metricRow, yearHeaderRow } from "../../../ui/metricsTable";
import { renderCategoryFlowCard } from "../CategoryFlow";
import {
	accountCurrency,
	cardHead,
	committedPayments,
	daysBetween,
	formatDay,
	formatMonth,
	incomeStability,
	money,
	monthWindow,
	pct,
	projectMonthEnd,
	relativeDays,
	setStatFoot,
	shiftDays,
	signedMoney,
	renderTriStat,
	ttmWindow,
} from "../shared";

/** Months of history in the cashflow chart — a year plus the current partial month. */
const CASHFLOW_MONTHS = 13;

/**
 * A checking account is the everyday spending and income hub, so the whole page answers one
 * question: is more going out than coming in, and what happens between now and payday.
 *
 * Deliberately absent: an account-level savings rate. Savings rate is a portfolio metric — on a
 * single checking account it is distorted by every transfer out that the classifier can't see.
 */
export function renderCheckingDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account): void {
	const store = plugin.store;
	const today = new Date();
	const now = todayIso(today);
	const month = monthOf(now);
	const ids = [account.id];
	const currency = accountCurrency(account);
	const series = recurringSeries(store).filter((s) => s.accountId === account.id);

	const balance = netWorth(store, account.id, now);
	const m0 = windowSummary(store, firstDayOf(month), lastDayOf(month), ids);
	const burn = burnRate(store, ids, 6, today);
	const balances = balanceSeries(store, ids, "month", today).slice(-24);

	/* ---------- stats ---------- */

	const grid = container.createDiv({ cls: "fp-stat-grid" });

	renderStat(grid, {
		label: "Current balance",
		value: money(balance, currency),
		size: "hero",
		iconName: "landmark",
		sparklineValues: balances.map((b) => b.balance),
		sparklineColor: "var(--fp-series-worth)",
	});

	renderTriStat(grid, {
		label: `${formatMonth(month)} so far`,
		iconName: "arrow-left-right",
		items: [
			{ label: "In", value: money(m0.income, currency), tone: "in" },
			{ label: "Out", value: money(m0.expenses, currency) },
			{ label: "Net", value: signedMoney(m0.net, currency), tone: m0.net < 0 ? "alarm" : "neutral" },
		],
	});

	const burnCard = renderStat(grid, {
		label: "Monthly burn",
		value: money(burn, currency),
		iconName: "receipt",
	});
	// Averaged over the last six *complete* months. The old figure divided the year-to-date by 12,
	// which understates by 12/elapsed_months for the whole of January.
	setStatFoot(burnCard, ["average of the last 6 complete months"]);

	// The overdraft read: the worst it got recently, not where it ended up.
	const daily = balanceSeries(store, ids, "day", today).filter((p) => p.key >= shiftDays(now, -89));
	if (daily.length > 0) {
		const low = daily.reduce((min, p) => (p.balance < min.balance ? p : min), daily[0]);
		const lowCard = renderStat(grid, {
			label: "Lowest balance, 90 days",
			value: money(low.balance, currency),
			iconName: "trending-down",
			tone: low.balance < 0 ? "bad" : "neutral",
		});
		setStatFoot(lowCard, [`on ${formatDay(low.key)}`]);
	}

	/* ---------- projection ---------- */

	const projection = projectMonthEnd(store, store.subscriptions, series, ids, today);
	if (projection.committed.length > 0 || projection.dailyDiscretionary > 0) {
		renderMeter(container, {
			label: projection.projected < 0 ? "Projected short before month end" : "Projected end-of-month balance",
			value: balance > 0 ? Math.max(0, projection.projected) / balance : 0,
			valueLabel: money(projection.projected, currency),
			tone: projection.projected < 0 ? "over" : projection.safeToSpend < 0 ? "warn" : "ok",
			renderSub: (el) => {
				el.createSpan({ cls: "fp-money", text: money(projection.scheduledOut, currency) });
				el.createSpan({ text: ` committed over ${projection.committed.length} payment${projection.committed.length === 1 ? "" : "s"} · ` });
				el.createSpan({ cls: "fp-money", text: money(projection.discretionary, currency) });
				el.createSpan({ text: ` of usual spending across ${projection.remainingDays} remaining day${projection.remainingDays === 1 ? "" : "s"}` });
			},
		});
	}

	/* ---------- cashflow ---------- */

	const months: string[] = [];
	for (let i = CASHFLOW_MONTHS - 1; i >= 0; i--) months.push(shiftMonth(month, -i));
	const monthly = months.map((m) => {
		const w = monthWindow(m);
		return windowSummary(store, w.from, w.to, ids);
	});

	if (monthly.some((m) => m.income > 0 || m.expenses > 0)) {
		const card = container.createDiv({ cls: "fp-card" });
		cardHead(card, "Cash flow", { sub: "Money in against money out, by month" });
		groupedColumnChart(
			card,
			months.map((m) => formatMonth(m).slice(0, 3)),
			[
				{ label: "In", color: "var(--fp-series-income)", values: monthly.map((m) => m.income) },
				{ label: "Out", color: "var(--fp-series-expenses)", values: monthly.map((m) => m.expenses) },
			],
			{
				formatValue: (n) => money(n, currency),
				title: "Monthly income and expenses",
				description: `Income and expenses per month for the last ${CASHFLOW_MONTHS} months.`,
			}
		);
	}

	/* ---------- spend by category (this month) ---------- */

	renderCategoryFlowCard(container, plugin, { accountIds: ids, title: "Spending by category", today });

	/* ---------- income shape & commitments ---------- */

	renderIncomeAndCommitments(container, plugin, account, series, today);

	/* ---------- history ---------- */

	const years = summarizeByYear(store, account.id);
	if (years.length > 0) {
		const card = container.createDiv({ cls: "fp-card" });
		cardHead(card, "Historical performance", { sub: "The current year is still partial" });
		const wrap = card.createDiv({ cls: "fp-table-scroll" });
		const table = wrap.createEl("table", { cls: "fp-table fp-table-metrics" });
		yearHeaderRow(
			table,
			years.map((y) => y.year),
			{ onClick: (year) => new MonthDrilldownModal(plugin.app, plugin, year, account.name, account.id).open() }
		);
		const tbody = table.createEl("tbody");
		// `formatEUR` by reference: `metricRow` detects money by identity to attach `.fp-money`.
		metricRow(tbody, "Total income", years.map((y) => y.income), formatEUR, { heat: "normal" });
		deltaRow(tbody, years.map((y) => y.income));
		metricRow(tbody, "Total expenses", years.map((y) => y.expenses), formatEUR, { heat: "invert" });
		deltaRow(tbody, years.map((y) => y.expenses), { invert: true });
		metricRow(tbody, "Net savings", years.map((y) => y.net), formatEUR, { emphasize: true, heat: "normal" });
		metricRow(tbody, "Savings rate", years.map((y) => y.savingsRate), (n) => tableFormatPct(n), { heat: "normal" });
		metricRow(tbody, "Balance (EOY)", years.map((y) => y.netWorthEOY), formatEUR, { emphasize: true, heat: "normal" });
		deltaRow(tbody, years.map((y) => y.netWorthEOY));
	}
}

/**
 * What lands on this account whether you act or not: the recurring commitments it carries, and how
 * regular the money coming in actually is.
 */
function renderIncomeAndCommitments(
	container: HTMLElement,
	plugin: FinancePlugin,
	account: Account,
	series: ReturnType<typeof recurringSeries>,
	today: Date
): void {
	const store = plugin.store;
	const currency = accountCurrency(account);
	const ids = [account.id];
	const now = todayIso(today);
	const ttm = ttmWindow(today);
	const income = windowSummary(store, ttm.from, ttm.to, ids).income;

	const subs = store.subscriptions.filter((s) => s.accountId === account.id);
	const subMonthly = subs.reduce((sum, s) => sum + monthlyCost(s), 0);
	const detected = committedPayments(store.subscriptions, series, shiftDays(now, 365), ids, today).filter((c) => c.source === "recurring");
	const stability = incomeStability(store, ids, today);
	const paycheck = series
		.filter((s) => s.direction === "credit" && s.cycle === "monthly")
		.sort((a, b) => b.medianAmount - a.medianAmount)[0];

	if (subMonthly <= 0 && detected.length === 0 && !stability && !paycheck) return;

	const card = container.createDiv({ cls: "fp-card" });
	cardHead(card, "Regular money", { sub: "What reliably arrives, and what reliably leaves" });
	const grid = card.createDiv({ cls: "fp-stat-grid fp-stat-grid--inner" });

	if (subMonthly > 0) {
		const commitments = renderStat(grid, {
			label: "Tracked commitments",
			value: money(subMonthly, currency),
			size: "compact",
			iconName: "repeat",
		});
		setStatFoot(commitments, [
			`${subs.length} subscription${subs.length === 1 ? "" : "s"} · `,
			income > 0 ? `${pct((subMonthly * 12) / income)} of trailing-12-month income` : "no income recorded yet",
		]);
	}

	if (detected.length > 0) {
		const untracked = renderStat(grid, {
			label: "Untracked recurring",
			value: String(new Set(detected.map((d) => d.merchantKey)).size),
			size: "compact",
			iconName: "search",
			money: false,
		});
		setStatFoot(untracked, ["merchants charging on a schedule that aren't tracked as subscriptions"]);
	}

	if (stability) {
		const stabilityCard = renderStat(grid, {
			label: "Income stability",
			value: stability.label,
			size: "compact",
			iconName: "activity",
			money: false,
			tone: stability.label === "Steady" ? "good" : stability.label === "Irregular" ? "warn" : "neutral",
		});
		setStatFoot(stabilityCard, [{ money: money(stability.mean, currency) }, "/mo on average, ±", pct(stability.cv), " month to month"]);
	}

	if (paycheck) {
		const next = renderStat(grid, {
			label: "Next expected income",
			value: money(paycheck.medianAmount, currency),
			size: "compact",
			iconName: "calendar-clock",
		});
		setStatFoot(next, [`${paycheck.displayName} · ${formatDay(paycheck.expectedNextDate, { short: true })} (${relativeDays(daysBetween(now, paycheck.expectedNextDate))})`]);
	}

}
