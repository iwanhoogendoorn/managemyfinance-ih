import {
	balanceSeries,
	investingActivityByYear,
	investingHoldings,
	netWorth,
	realizedPLByYear,
	shiftMonth,
	summarizeByYear,
	todayIso,
	monthOf,
	type KpiStore,
} from "../../../kpi";
import type FinancePlugin from "../../../main";
import type { Account, Transaction } from "../../../types";
import { groupedColumnChart, lineChart, stackedShareBar } from "../../../ui/charts";
import { emptyState, renderStat } from "../../../ui/dom";
import { formatEUR, metricRow, yearHeaderRow } from "../../../ui/metricsTable";
import {
	accountCurrency,
	catColor,
	cardHead,
	editableAmount,
	formatMonth,
	money,
	monthWindow,
	pct,
	rawAccountFlows,
	renderMonthPickerCard,
	setStatFoot,
	signedMoney,
	ttmWindow,
	valuationAge,
} from "../shared";

/** Concentration bands — a single position above half the portfolio is the whole portfolio. */
const CONCENTRATION_WARN = 0.3;
const CONCENTRATION_BAD = 0.5;

const DIVIDEND_ACTIONS = ["dividend", "interest"];

/** Net contributions below this share of market value are too small a base to divide by. */
const SIMPLE_RETURN_MIN_BASE = 0.1;

function isDividend(tx: Transaction): boolean {
	const action = (tx.action ?? "").toLowerCase();
	return DIVIDEND_ACTIONS.some((a) => action.startsWith(a));
}

/**
 * An investing account's one job is to answer "how much of this is money I put in, and how much did
 * it make?". The ledger alone can only tell you the first half — so the second half rides on a single
 * manually-entered market value, refreshed whenever the user feels like it, with its own age printed
 * next to every figure derived from it.
 */
export function renderInvestingDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account): void {
	const store = plugin.store;
	const today = new Date();
	const holdings = investingHoldings(store, account.id);
	const hasTickers = store.transactions.some((t) => t.accountId === account.id && t.ticker && t.ticker !== "CASH");

	// A crypto (or generic-CSV) account has no ticker/action vocabulary at all, and the trading
	// dashboard renders as four €0 tiles and two empty tables. Show what the rows *do* support.
	if (holdings.length === 0 && !hasTickers) {
		renderFlowOnlyVariant(container, plugin, account, today);
		return;
	}

	const currency = accountCurrency(account);
	const activity = investingActivityByYear(store, account.id);
	const totalCostBasis = holdings.reduce((sum, h) => sum + h.netInvested, 0);
	const deposits = activity.reduce((sum, y) => sum + y.deposits, 0);
	const withdrawals = activity.reduce((sum, y) => sum + y.withdrawals, 0);
	const netContributions = deposits - withdrawals;
	const totalFees = activity.reduce((sum, y) => sum + y.fees, 0);
	const marketValue = account.marketValue;
	const age = valuationAge(account.marketValueAsOf, today);

	/* ---------- stats ---------- */

	const grid = container.createDiv({ cls: "fp-stat-grid" });

	const valueCard = renderStat(grid, {
		label: marketValue === undefined ? "Holdings (at cost)" : "Portfolio value",
		value: money(marketValue ?? totalCostBasis, currency),
		size: "hero",
		iconName: "candlestick-chart",
	});
	setStatFoot(valueCard, [marketValue === undefined ? "cost basis — no market value entered" : age.text]);
	if (age.stale && marketValue !== undefined) valueCard.addClass("fp-stat--stale");
	editableAmount(valueCard, {
		emptyLabel: "Enter current value",
		editLabel: "Update value",
		value: marketValue,
		placeholder: String(Math.round(totalCostBasis) || 0),
		onSave: async (value) => {
			const target = store.accounts.find((a) => a.id === account.id);
			if (!target) return;
			target.marketValue = value;
			target.marketValueAsOf = value === undefined ? undefined : todayIso(today);
			await store.saveAccounts();
			plugin.refreshViews();
		},
	});

	const contributionsCard = renderStat(grid, {
		label: "Net contributions",
		value: money(netContributions, currency),
		iconName: "download",
	});
	setStatFoot(contributionsCard, [{ money: money(deposits, currency) }, " in, ", { money: money(withdrawals, currency) }, " out"]);

	if (marketValue !== undefined && netContributions > 0) {
		const growth = marketValue - netContributions;
		const simpleReturn = growth / netContributions;
		// Deposits less withdrawals is a *net* figure, so it collapses towards zero on an account that
		// has been drawn down — and dividing by a near-zero base manufactures a triumphant number out of
		// a loss. €100k in, €95k out, €10k left is "+100%" by this formula and −€90k in real life. Below
		// a tenth of the portfolio's value the denominator is noise, so the tile refuses to answer.
		const meaningfulBase = netContributions >= SIMPLE_RETURN_MIN_BASE * marketValue;
		const returnCard = renderStat(grid, {
			label: "Simple return",
			value: meaningfulBase ? pct(simpleReturn, 1) : "—",
			iconName: "trending-up",
			money: false,
			tone: meaningfulBase ? (simpleReturn >= 0 ? "good" : "bad") : "neutral",
		});
		setStatFoot(
			returnCard,
			meaningfulBase
				? [{ money: signedMoney(growth, currency) }, " above what you put in · not annualized"]
				: [
						"deposits and withdrawals have nearly cancelled out (",
						{ money: money(netContributions, currency) },
						" net against ",
						{ money: money(marketValue, currency) },
						" held), so a return against them would say more about the withdrawals than the investments",
				  ]
		);
	}

	// A euro figure for fees changes nothing. "2.1% of everything you contributed" changes behaviour.
	const feeCard = renderStat(grid, {
		label: "Fee drag",
		value: deposits > 0 ? pct(totalFees / deposits, 2) : "—",
		iconName: "receipt",
		money: false,
		tone: deposits > 0 && totalFees / deposits > 0.01 ? "warn" : "neutral",
	});
	setStatFoot(feeCard, [{ money: money(totalFees, currency) }, " of fees against ", { money: money(deposits, currency) }, " contributed"]);

	renderPortfolioShape(container, plugin, account, holdings, totalCostBasis, currency, today);

	/* ---------- contributions vs growth ---------- */

	if (marketValue !== undefined && netContributions > 0) {
		const growth = marketValue - netContributions;
		const card = container.createDiv({ cls: "fp-card" });
		cardHead(card, "Contributions vs growth", { sub: `Market value ${age.text}` });
		if (growth >= 0) {
			stackedShareBar(
				card,
				[
					{ label: "What you put in", value: netContributions, color: "var(--fp-series-net)" },
					{ label: "Growth", value: growth, color: "var(--fp-series-passive)" },
				],
				{ formatValue: (n) => money(n, currency) }
			);
		} else {
			const note = card.createDiv({ cls: "fp-card-note is-bad" });
			note.createSpan({ text: "Currently " });
			note.createSpan({ cls: "fp-money", text: money(-growth, currency) });
			note.createSpan({ text: " below what you contributed — the position is down, not up." });
		}
	}

	/* ---------- monthly contributions ---------- */

	const recentContribMonths: string[] = [];
	for (let i = 23; i >= 0; i--) recentContribMonths.push(shiftMonth(monthOf(todayIso(today)), -i));
	const hasContribActivity = recentContribMonths.some((m) => monthlyContribution(store, account.id, m) !== 0);
	if (hasContribActivity || activity.length > 0) {
		renderMonthPickerCard(container, {
			title: "Contributions by month",
			sub: "Deposits less withdrawals — everything else was annual-only before",
			years: activity.map((a) => a.year),
			recentMonths: recentContribMonths,
			recentLabel: "Last 24 months",
			renderPeriod: (host, months) => {
				const values = months.map((m) => monthlyContribution(store, account.id, m));
				if (!values.some((v) => v !== 0)) {
					host.createDiv({ cls: "fp-card-sub", text: "No activity in this period." });
					return;
				}
				groupedColumnChart(
					host,
					months.map((m) => formatMonth(m).slice(0, 3)),
					[{ label: "Net contribution", color: "var(--fp-series-net)", values }],
					{ formatValue: (n) => money(n, currency), title: "Net contributions by month", description: "Deposits minus withdrawals per month." }
				);
			},
		});
	}

	/* ---------- holdings ---------- */

	const holdingsCard = container.createDiv({ cls: "fp-card" });
	cardHead(holdingsCard, "Holdings", { sub: "Average-cost basis of the shares you still hold" });
	if (holdings.length === 0) {
		emptyState(holdingsCard, {
			variant: "inline",
			iconName: "candlestick-chart",
			title: "No open positions",
			description: "Buys and sells from this account build the holdings breakdown here.",
		});
	} else {
		const wrap = holdingsCard.createDiv({ cls: "fp-table-scroll" });
		const table = wrap.createEl("table", { cls: "fp-table" });
		const thead = table.createEl("thead").createEl("tr");
		["Ticker", "Asset class", "Shares", "Avg. cost", "Cost basis", "Share"].forEach((h, i) =>
			thead.createEl("th", { text: h, cls: i >= 2 ? "fp-table-num" : undefined, attr: { scope: "col" } })
		);
		const tbody = table.createEl("tbody");
		holdings.forEach((h) => {
			const tr = tbody.createEl("tr");
			tr.createEl("td", { text: h.ticker });
			tr.createEl("td", { text: h.assetClass || "—" });
			tr.createEl("td", { text: h.shares.toFixed(4), cls: "fp-table-num" });
			tr.createEl("td", { text: money(h.avgCost, currency, 2), cls: "fp-table-num fp-money" });
			tr.createEl("td", { text: money(h.netInvested, currency), cls: "fp-table-num fp-money" });
			tr.createEl("td", { text: totalCostBasis > 0 ? pct(h.netInvested / totalCostBasis) : "—", cls: "fp-table-num" });
		});
	}

	/* ---------- realized P/L & activity ---------- */

	const realized = realizedPLByYear(store, account.id);
	if (realized.length > 0) {
		const card = container.createDiv({ cls: "fp-card" });
		cardHead(card, "Realized profit & loss", { sub: "Booked on sale — proceeds less the basis those shares carried" });
		const wrap = card.createDiv({ cls: "fp-table-scroll" });
		const table = wrap.createEl("table", { cls: "fp-table fp-table-metrics" });
		yearHeaderRow(table, realized.map((r) => r.year));
		const tbody = table.createEl("tbody");
		metricRow(tbody, "Proceeds", realized.map((r) => r.proceeds), formatEUR);
		metricRow(tbody, "Cost basis sold", realized.map((r) => r.costBasisSold), formatEUR);
		metricRow(tbody, "Realized P/L", realized.map((r) => r.realized), formatEUR, { emphasize: true, heat: "normal" });
	}

	if (activity.length > 0) {
		const card = container.createDiv({ cls: "fp-card" });
		cardHead(card, "Activity by year");
		const wrap = card.createDiv({ cls: "fp-table-scroll" });
		const table = wrap.createEl("table", { cls: "fp-table fp-table-metrics" });
		yearHeaderRow(table, activity.map((y) => y.year));
		const tbody = table.createEl("tbody");
		metricRow(tbody, "Deposits", activity.map((y) => y.deposits), formatEUR, { heat: "normal" });
		metricRow(tbody, "Withdrawals", activity.map((y) => y.withdrawals), formatEUR);
		metricRow(tbody, "Dividends", activity.map((y) => y.dividends), formatEUR, { heat: "normal" });
		metricRow(tbody, "Fees", activity.map((y) => y.fees), formatEUR, { heat: "invert" });
	}
}

/** Allocation, concentration, yield on cost and how consistently you actually invest. */
function renderPortfolioShape(
	container: HTMLElement,
	plugin: FinancePlugin,
	account: Account,
	holdings: ReturnType<typeof investingHoldings>,
	totalCostBasis: number,
	currency: string,
	today: Date
): void {
	const store = plugin.store;
	if (totalCostBasis <= 0) return;

	const card = container.createDiv({ cls: "fp-card" });
	cardHead(card, "Portfolio shape");

	// `assetClass` has been carried on every transaction, propagated into every holding, printed as a
	// bare table column and never once charted.
	const byClass = new Map<string, number>();
	holdings.forEach((h) => byClass.set(h.assetClass || "Unclassified", (byClass.get(h.assetClass || "Unclassified") ?? 0) + h.netInvested));
	if (byClass.size > 1) {
		stackedShareBar(
			card,
			Array.from(byClass.entries())
				.sort((a, b) => b[1] - a[1])
				.map(([label, value], i) => ({ label, value, color: catColor(i) })),
			{ formatValue: (n) => money(n, currency) }
		);
	}

	const grid = card.createDiv({ cls: "fp-stat-grid fp-stat-grid--inner" });

	const top = holdings[0];
	if (top) {
		const share = top.netInvested / totalCostBasis;
		const conc = renderStat(grid, {
			label: "Concentration",
			value: pct(share),
			size: "compact",
			iconName: "pie-chart",
			money: false,
			tone: share >= CONCENTRATION_BAD ? "bad" : share >= CONCENTRATION_WARN ? "warn" : "good",
		});
		setStatFoot(conc, [`${top.ticker} is your largest position`]);
	}

	const ttm = ttmWindow(today);
	let dividends = 0;
	for (const tx of store.transactions) {
		if (tx.accountId !== account.id || !tx.date || tx.date < ttm.from || tx.date > ttm.to) continue;
		if (isDividend(tx)) dividends += Math.abs(tx.amount);
	}
	if (dividends > 0) {
		const yoc = renderStat(grid, {
			label: "Yield on cost",
			value: pct(dividends / totalCostBasis, 2),
			size: "compact",
			iconName: "coins",
			money: false,
			tone: "good",
		});
		setStatFoot(yoc, [{ money: money(dividends, currency) }, " received over 12 months"]);
	}

	// Consistency predicts outcomes better than any single month's size does.
	const contributedMonths = ttm.months.filter((m) => monthlyContribution(store, account.id, m) > 0).length;
	const consistency = renderStat(grid, {
		label: "Contribution consistency",
		value: `${contributedMonths} of 12`,
		size: "compact",
		iconName: "calendar-check",
		money: false,
		tone: contributedMonths >= 10 ? "good" : contributedMonths >= 4 ? "warn" : "neutral",
	});
	setStatFoot(consistency, ["months in the last year with money going in"]);
}

/**
 * Deposits less withdrawals for one month. Falls back to plain cashflow when the import carried no
 * `action` vocabulary at all — a generic CSV should still produce a contribution series.
 */
function monthlyContribution(store: KpiStore, accountId: string, month: string): number {
	const w = monthWindow(month);
	let tagged = 0;
	let sawAction = false;
	for (const tx of store.transactions) {
		if (tx.accountId !== accountId || !tx.date || tx.date < w.from || tx.date > w.to) continue;
		const action = (tx.action ?? "").toLowerCase();
		if (action === "deposit") {
			tagged += Math.abs(tx.amount);
			sawAction = true;
		} else if (action === "withdraw" || action === "withdrawal") {
			tagged -= Math.abs(tx.amount);
			sawAction = true;
		}
	}
	if (sawAction) return tagged;
	// Raw signed flow, not `windowSummary`: a transfer from checking into a broker is exactly what a
	// contribution *is*, and windowSummary strips transfers — so the fallback this comment promises
	// returned 0 for every account funded the normal way.
	return rawAccountFlows(store, accountId, w).net;
}

/**
 * The degenerate case: an account whose rows carry no tickers and no trade actions — a crypto wallet
 * imported from a generic CSV, or a broker export the parser didn't recognise. Holdings, allocation
 * and realized P/L are all unanswerable here, so the page shows the three things the rows *do*
 * support rather than four €0 tiles and two empty tables.
 */
function renderFlowOnlyVariant(container: HTMLElement, plugin: FinancePlugin, account: Account, today: Date): void {
	const store = plugin.store;
	const currency = accountCurrency(account);
	const now = todayIso(today);
	const ids = [account.id];
	const balance = netWorth(store, account.id, now);
	const balances = balanceSeries(store, ids, "month", today);
	const marketValue = account.marketValue;
	const age = valuationAge(account.marketValueAsOf, today);

	const grid = container.createDiv({ cls: "fp-stat-grid" });
	const valueCard = renderStat(grid, {
		label: marketValue === undefined ? "Net contributed" : "Current value",
		value: money(marketValue ?? balance, currency),
		size: "hero",
		iconName: account.type === "crypto" ? "bitcoin" : "candlestick-chart",
	});
	setStatFoot(valueCard, [
		marketValue === undefined ? "no holdings data in this account's rows — this is cash in, cash out" : age.text,
	]);
	editableAmount(valueCard, {
		emptyLabel: "Enter current value",
		editLabel: "Update value",
		value: marketValue,
		placeholder: String(Math.round(balance) || 0),
		onSave: async (value) => {
			const target = store.accounts.find((a) => a.id === account.id);
			if (!target) return;
			target.marketValue = value;
			target.marketValueAsOf = value === undefined ? undefined : todayIso(today);
			await store.saveAccounts();
			plugin.refreshViews();
		},
	});

	const ttm = ttmWindow(today);
	// Raw flows for the same reason as the savings page: funding a wallet from your bank is a transfer,
	// and the transfer-stripping summary reported "€0 paid in" for an account funded every month.
	const flows = rawAccountFlows(store, account.id, ttm);
	const txCount = store.transactions.filter((t) => t.accountId === account.id && t.date >= ttm.from && t.date <= ttm.to).length;
	const inCard = renderStat(grid, {
		label: "Paid in (12 months)",
		value: money(flows.inflow - flows.interest, currency),
		iconName: "download",
	});
	setStatFoot(inCard, [`${txCount} transaction${txCount === 1 ? "" : "s"} in the last 12 months`]);
	renderStat(grid, { label: "Taken out (12 months)", value: money(flows.outflow, currency), iconName: "upload" });

	if (marketValue !== undefined && balance !== 0) {
		const growth = marketValue - balance;
		const growthCard = renderStat(grid, {
			label: "Growth",
			value: signedMoney(growth, currency),
			iconName: "trending-up",
			tone: growth >= 0 ? "good" : "bad",
		});
		setStatFoot(growthCard, ["against ", { money: money(balance, currency) }, " contributed"]);
	}

	if (balances.length > 1) {
		const years = summarizeByYear(store, account.id).map((y) => y.year);
		const recentFlowMonths = balances.slice(-24).map((b) => b.key);
		renderMonthPickerCard(container, {
			title: "Net flows by month",
			years,
			recentMonths: recentFlowMonths,
			recentLabel: "Last 24 months",
			renderPeriod: (host, months) => {
				const values = months.map((m) => rawAccountFlows(store, account.id, monthWindow(m)).net);
				if (!values.some((v) => v !== 0)) {
					host.createDiv({ cls: "fp-card-sub", text: "No activity in this period." });
					return;
				}
				groupedColumnChart(
					host,
					months.map((m) => formatMonth(m).slice(0, 3)),
					[{ label: "Net flow", color: "var(--fp-series-net)", values }],
					{ formatValue: (n) => money(n, currency), title: "Net flows by month", description: "Money in minus money out, per month." }
				);
			},
		});

		const historyCard = container.createDiv({ cls: "fp-card" });
		cardHead(historyCard, "Contributed over time", { sub: "Cost basis, not market value" });
		lineChart(
			historyCard,
			balances.map((b) => b.key),
			[{ label: "Contributed", color: "var(--fp-series-worth)", values: balances.map((b) => b.balance) }],
			{ area: true, formatValue: (n) => money(n, currency), title: "Contributed over time", description: "Running total of cash in and out." }
		);
	} else {
		const card = container.createDiv({ cls: "fp-card" });
		emptyState(card, {
			variant: "inline",
			iconName: "inbox",
			title: "No transactions on this account yet",
			description: "Its balance is whatever opening balance you set. Import an export to see flows over time.",
		});
	}
}
