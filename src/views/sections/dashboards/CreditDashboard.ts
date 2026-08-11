import { balanceSeries, firstDayOf, monthOf, netWorth, shiftMonth, todayIso, windowSummary, type KpiStore } from "../../../kpi";
import type FinancePlugin from "../../../main";
import type { Account, Transaction } from "../../../types";
import { groupedColumnChart } from "../../../ui/charts";
import { emptyState, renderStat } from "../../../ui/dom";
import { renderMeter } from "../../../ui/kpiCard";
import { renderCategoryFlowCard } from "../CategoryFlow";
import {
	accountCurrency,
	cardHead,
	editableAmount,
	formatDay,
	formatMonth,
	money,
	monthWindow,
	pct,
	setStatFoot,
	ttmWindow,
} from "../shared";

/** Utilization bands. Under 10% is invisible to a credit file; 30% is where it starts to cost you. */
const UTIL_GOOD = 0.1;
const UTIL_WARN = 0.3;

/** Interest and fee charges are recognisable either by category or by what the bank called the row. */
const INTEREST_PATTERN = /interest|rente|finance charge|late fee|cash advance fee/i;
const FEE_CATEGORY_PATTERN = /fees|charges/i;

function isInterestOrFee(tx: Transaction, feeCategoryIds: Set<string>): boolean {
	if (tx.amount >= 0) return false;
	if (tx.categoryId && feeCategoryIds.has(tx.categoryId)) return true;
	return INTEREST_PATTERN.test(`${tx.description} ${tx.counterparty ?? ""} ${tx.type ?? ""}`);
}

/**
 * The start of the statement cycle currently running: the most recent `statementDay` on or before
 * today. With no statement day set, the calendar month is the honest default rather than a guess.
 */
function cycleStart(account: Account, today: string): string {
	const day = account.statementDay;
	const month = monthOf(today);
	if (!day || day < 1 || day > 28) return firstDayOf(month);
	const thisMonth = `${month}-${String(day).padStart(2, "0")}`;
	return thisMonth <= today ? thisMonth : `${shiftMonth(month, -1)}-${String(day).padStart(2, "0")}`;
}

/** Payments *to* a credit account arrive as credits — money you sent to clear the balance. */
function paymentsIn(store: KpiStore, accountId: string, from: string, to: string): number {
	let total = 0;
	for (const tx of store.transactions) {
		if (tx.accountId !== accountId || tx.amount <= 0 || !tx.date || tx.date < from || tx.date > to) continue;
		total += tx.amount;
	}
	return total;
}

/**
 * A credit card is a liability, and every metric on the checking dashboard it used to borrow was
 * either meaningless here (savings rate on a card) or missing entirely (utilization, the statement
 * cycle, the interest it charges you).
 *
 * If this card charges interest, that is the loudest thing on the page. Carrying a balance at 20%
 * dominates every other financial decision a person is making.
 */
export function renderCreditDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account): void {
	const store = plugin.store;
	const today = new Date();
	const now = todayIso(today);
	const ids = [account.id];
	const currency = accountCurrency(account);

	const balance = netWorth(store, account.id, now);
	const owed = balance < 0 ? -balance : 0;
	const start = cycleStart(account, now);
	const cycle = windowSummary(store, start, now, ids);
	const ttm = ttmWindow(today);

	const feeCategoryIds = new Set(store.categories.filter((c) => FEE_CATEGORY_PATTERN.test(c.name)).map((c) => c.id));
	let interestTtm = 0;
	let interestRecent = 0;
	const threeMonthsAgo = firstDayOf(shiftMonth(monthOf(now), -2));
	for (const tx of store.transactions) {
		if (tx.accountId !== account.id || !tx.date) continue;
		if (!isInterestOrFee(tx, feeCategoryIds)) continue;
		if (tx.date >= ttm.from && tx.date <= now) interestTtm += -tx.amount;
		if (tx.date >= threeMonthsAgo && tx.date <= now) interestRecent += -tx.amount;
	}

	/* ---------- carried-balance banner ---------- */

	if (interestRecent > 0) {
		const banner = container.createDiv({ cls: "fp-banner is-bad" });
		banner.createDiv({ cls: "fp-banner-title", text: "You're carrying a balance on this card" });
		const body = banner.createDiv({ cls: "fp-banner-body" });
		body.createSpan({ cls: "fp-money", text: money(interestRecent, currency) });
		body.createSpan({ text: " of interest and fees in the last three months. Clearing this balance beats any return elsewhere." });
	}

	/* ---------- stats ---------- */

	const grid = container.createDiv({ cls: "fp-stat-grid" });
	const balances = balanceSeries(store, ids, "month", today).slice(-24);

	const owedCard = renderStat(grid, {
		label: "Amount owed",
		value: money(owed, currency),
		size: "hero",
		iconName: "credit-card",
		// Owing money on a credit card is normal; paying interest on it is not. The alarm lives in
		// the banner above, so the hero doesn't cry wolf every month.
		tone: interestRecent > 0 ? "bad" : "neutral",
		// Owed is a positive figure by construction, so the sparkline is inverted to match: a rising
		// line means rising debt.
		sparklineValues: balances.map((b) => -b.balance),
		sparklineColor: "var(--fp-series-expenses)",
	});
	setStatFoot(owedCard, [owed > 0 ? "outstanding right now" : "nothing outstanding — paid in full"]);

	const cycleCard = renderStat(grid, {
		label: "Spend this cycle",
		value: money(cycle.expenses, currency),
		iconName: "calendar-range",
	});
	setStatFoot(cycleCard, [
		account.statementDay ? `since ${formatDay(start)} (statement day ${account.statementDay})` : `since ${formatDay(start)} — no statement day set`,
	]);

	// Interest is only worth a tile when it's non-zero; a permanent "€0" tile trains people to skip it.
	if (interestTtm > 0) {
		const interestCard = renderStat(grid, {
			label: "Interest & fees (12 months)",
			value: money(interestTtm, currency),
			iconName: "alert-triangle",
			tone: "bad",
		});
		setStatFoot(interestCard, ["paid to the card issuer, on top of what you bought"]);
	}

	const paid = paymentsIn(store, account.id, ttm.from, ttm.to);
	const paidCard = renderStat(grid, { label: "Payments made (12 months)", value: money(paid, currency), iconName: "check-circle" });
	const monthlyPayment = paid / 12;
	if (owed > 0 && monthlyPayment > 0) {
		const months = owed / monthlyPayment;
		setStatFoot(paidCard, [
			{ money: money(monthlyPayment, currency) },
			months <= 1.05 ? "/mo — you clear it about as fast as you spend it" : `/mo — about ${Math.ceil(months)} months to clear at that rate`,
		]);
	} else {
		setStatFoot(paidCard, [{ money: money(monthlyPayment, currency) }, "/mo on average"]);
	}

	/* ---------- utilization ---------- */

	renderUtilization(container, plugin, account, owed, currency);

	/* ---------- spend this cycle by category ---------- */

	renderCategoryFlowCard(container, plugin, { accountIds: ids, title: "Spending by category", today });

	/* ---------- utilization trend ---------- */

	if (account.creditLimit && account.creditLimit > 0 && balances.length > 1) {
		const card = container.createDiv({ cls: "fp-card" });
		cardHead(card, "Utilization over time", { sub: "The shape a credit file actually responds to" });
		groupedColumnChart(
			card,
			balances.map((b) => formatMonth(b.key).slice(0, 3)),
			[
				{
					label: "Utilization",
					color: "var(--fp-series-expenses)",
					values: balances.map((b) => Math.max(0, -b.balance) / account.creditLimit!),
				},
			],
			{
				formatValue: (n) => pct(n),
				money: false,
				title: "Credit utilization by month",
				description: "Balance owed at month end as a share of the credit limit.",
			}
		);
	}

	/* ---------- monthly spend vs payments ---------- */

	const months: string[] = [];
	for (let i = 12; i >= 0; i--) months.push(shiftMonth(monthOf(now), -i));
	const spendSeries = months.map((m) => {
		const w = monthWindow(m);
		return windowSummary(store, w.from, w.to, ids).expenses;
	});
	const paymentSeries = months.map((m) => {
		const w = monthWindow(m);
		return paymentsIn(store, account.id, w.from, w.to);
	});
	if (spendSeries.some((v) => v > 0) || paymentSeries.some((v) => v > 0)) {
		const card = container.createDiv({ cls: "fp-card" });
		cardHead(card, "Spend against payments", { sub: "Paying less than you spend is what turns a card into a loan" });
		groupedColumnChart(
			card,
			months.map((m) => formatMonth(m).slice(0, 3)),
			[
				{ label: "Spent", color: "var(--fp-series-expenses)", values: spendSeries },
				{ label: "Paid off", color: "var(--fp-series-income)", values: paymentSeries },
			],
			{ formatValue: (n) => money(n, currency), title: "Monthly spend against payments", description: "Card spend and payments received, per month." }
		);
	}
}

/**
 * Credit utilization — the most consequential consumer-finance number that isn't net worth, and the
 * one thing this dashboard cannot derive: it needs the limit, which lives nowhere in a bank export.
 * Asked for inline; the meter simply doesn't exist until it's given, rather than showing a "—".
 */
function renderUtilization(container: HTMLElement, plugin: FinancePlugin, account: Account, owed: number, currency: string): void {
	const card = container.createDiv({ cls: "fp-card" });
	const head = cardHead(card, "Credit utilization");
	editableAmount(head, {
		emptyLabel: "Set credit limit",
		editLabel: "Change limit",
		value: account.creditLimit,
		placeholder: "5000",
		onSave: async (value) => {
			const target = plugin.store.accounts.find((a) => a.id === account.id);
			if (!target) return;
			target.creditLimit = value;
			await plugin.store.saveAccounts();
			plugin.refreshViews();
		},
	});

	const limit = account.creditLimit;
	if (!limit || limit <= 0) {
		emptyState(card, {
			variant: "inline",
			iconName: "gauge",
			title: "No credit limit set",
			description: "Add this card's limit and you'll see utilization — the number credit scoring reacts to most.",
		});
		return;
	}

	const utilization = owed / limit;
	renderMeter(card, {
		label: "Balance against limit",
		value: utilization,
		valueLabel: pct(utilization),
		tone: utilization >= UTIL_WARN ? "over" : utilization >= UTIL_GOOD ? "warn" : "ok",
		renderSub: (el) => {
			el.createSpan({ cls: "fp-money", text: money(owed, currency) });
			el.createSpan({ text: " of " });
			el.createSpan({ cls: "fp-money", text: money(limit, currency) });
			el.createSpan({
				text:
					utilization >= UTIL_WARN
						? " — above 30% is where utilization starts working against you."
						: utilization >= UTIL_GOOD
						? " — under 10% is where it stops registering at all."
						: " — comfortably low.",
			});
			el.createSpan({ text: " " });
			el.createSpan({ cls: "fp-money", text: money(Math.max(0, limit - owed), currency) });
			el.createSpan({ text: " available." });
		},
	});
}
