import { balanceSeries, burnRate, fiProjection, netWorth, summarizeByYear, todayIso } from "../../../kpi";
import type FinancePlugin from "../../../main";
import type { Account } from "../../../types";
import { groupedColumnChart, lineChart, stackedShareBar } from "../../../ui/charts";
import { emptyState, renderStat } from "../../../ui/dom";
import { renderMeter } from "../../../ui/kpiCard";
import {
	accountCurrency,
	balanceOf,
	cardHead,
	editableAmount,
	formatDay,
	formatMonth,
	liquidAccountIds,
	money,
	monthWindow,
	pct,
	rawAccountFlows,
	renderMonthPickerCard,
	setStatFoot,
	signedMoney,
	spendingAccountIds,
	ttmWindow,
} from "../shared";

/** Yield bands. Below 0.5% your bank is quietly keeping the interest; above 3% it is competitive. */
const YIELD_GOOD = 0.03;
const YIELD_WARN = 0.005;

/**
 * A savings account holds a buffer and grows. So the page answers three things: how long the buffer
 * lasts, how much of the growth is yours versus the bank's, and how far off the goal is.
 */
export function renderSavingsDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account): void {
	const store = plugin.store;
	const today = new Date();
	const now = todayIso(today);
	const ids = [account.id];
	const currency = accountCurrency(account);

	const balance = netWorth(store, account.id, now);
	const ttm = ttmWindow(today);
	// Raw signed flows, NOT `windowSummary`: that helper strips transfers by design, and a savings
	// deposit *is* a transfer — pair-matched to the debit in checking, and marker-matched by its
	// Deposit/Withdrawal type. Every figure on this page ran through it, so a €500/mo standing order
	// rendered as "€0 contributed", a flat net-contributions chart and a goal card claiming there was
	// no pace to project. Money moving between your own accounts doesn't change your net worth, but on
	// this account's own page it is the entire subject.
	const ttmFlows = rawAccountFlows(store, account.id, ttm);
	const contributions = ttmFlows.inflow - ttmFlows.interest;
	const withdrawn = ttmFlows.outflow;
	const interest = ttmFlows.interest;

	const balances = balanceSeries(store, ids, "month", today);
	const ttmBalances = balances.filter((b) => ttm.months.includes(b.key)).map((b) => b.balance);
	const meanBalance = ttmBalances.length > 0 ? ttmBalances.reduce((a, b) => a + b, 0) / ttmBalances.length : 0;
	const effectiveYield = meanBalance > 0 ? interest / meanBalance : undefined;

	// Coverage is a portfolio question, not an account one: the buffer covers everything you spend,
	// wherever you spend it from — credit included, or the runway is materially overstated.
	const burn = burnRate(store, spendingAccountIds(store), 6, today);
	const liquid = balanceOf(store, liquidAccountIds(store), now);
	const monthsCovered = burn > 0 ? liquid / burn : undefined;

	/* ---------- stats ---------- */

	const grid = container.createDiv({ cls: "fpih-stat-grid" });

	renderStat(grid, {
		label: "Current balance",
		value: money(balance, currency, 2),
		size: "hero",
		iconName: "piggy-bank",
		sparklineValues: balances.slice(-24).map((b) => b.balance),
		sparklineColor: "var(--fpih-series-worth)",
	});

	const coverage = renderStat(grid, {
		label: "Emergency fund coverage",
		value: monthsCovered === undefined ? "—" : `${monthsCovered.toFixed(1)} mo`,
		iconName: "shield",
		money: false,
		tone: monthsCovered === undefined ? "neutral" : monthsCovered >= 6 ? "good" : monthsCovered >= 3 ? "warn" : "bad",
	});
	setStatFoot(coverage, [
		{ money: money(liquid, currency) },
		" liquid against ",
		{ money: money(burn, currency) },
		"/mo of everyday spending",
	]);

	const yieldCard = renderStat(grid, {
		label: "Effective yield (12 months)",
		value: effectiveYield === undefined ? "—" : pct(effectiveYield, 2),
		iconName: "percent",
		money: false,
		tone: effectiveYield === undefined ? "neutral" : effectiveYield >= YIELD_GOOD ? "good" : effectiveYield >= YIELD_WARN ? "warn" : "bad",
	});
	setStatFoot(yieldCard, [{ money: money(interest, currency) }, " of interest on an average balance of ", { money: money(meanBalance, currency) }]);

	const withdrawalMonths = ttm.months.filter((m) => rawAccountFlows(store, account.id, monthWindow(m)).outflow > 0).length;
	const withdrawals = renderStat(grid, {
		label: "Withdrawals",
		value: `${withdrawalMonths} of 12 months`,
		iconName: "arrow-up-from-line",
		money: false,
		tone: withdrawalMonths >= 6 ? "warn" : "neutral",
	});
	setStatFoot(withdrawals, [{ money: money(withdrawn, currency) }, " taken out over the last 12 months"]);

	/* ---------- goal ---------- */

	// Net of withdrawals and net of the bank's interest: the pace *you* set.
	renderGoal(container, plugin, account, balance, (ttmFlows.net - interest) / 12, currency);

	/* ---------- contributions vs interest ---------- */

	if (contributions > 0 || interest > 0) {
		const card = container.createDiv({ cls: "fpih-card" });
		cardHead(card, "Where the growth came from", { sub: "Trailing 12 months — your deposits against the bank's interest" });
		stackedShareBar(
			card,
			[
				{ label: "Your contributions", value: Math.max(0, contributions), color: "var(--fpih-series-net)" },
				{ label: "Interest earned", value: Math.max(0, interest), color: "var(--fpih-series-passive)" },
			],
			{ formatValue: (n) => money(n, currency) }
		);
	}

	/* ---------- net contribution trend ---------- */

	const trendMonths = balances.slice(-24).map((b) => b.key);
	if (trendMonths.length > 1) {
		const years = summarizeByYear(store, account.id).map((y) => y.year);
		renderMonthPickerCard(container, {
			title: "Net contributions",
			sub: "Deposits less withdrawals, interest excluded",
			years,
			recentMonths: trendMonths,
			renderPeriod: (host, months) => {
				const values = months.map((m) => {
					const f = rawAccountFlows(store, account.id, monthWindow(m));
					// Interest isn't a contribution — conflating the two is how "net deposits" quietly
					// credits you with the bank's money.
					return f.net - f.interest;
				});
				groupedColumnChart(
					host,
					months.map((m) => formatMonth(m).slice(0, 3)),
					[{ label: "Net contribution", color: "var(--fpih-series-net)", values }],
					{ formatValue: (n) => money(n, currency), title: "Net contributions by month", description: "Deposits minus withdrawals, per month." }
				);
			},
		});
	}

	/* ---------- balance history ---------- */

	if (balances.length > 1) {
		const card = container.createDiv({ cls: "fpih-card" });
		cardHead(card, "Balance history");
		lineChart(
			card,
			balances.map((b) => b.key),
			[{ label: "Balance", color: "var(--fpih-series-worth)", values: balances.map((b) => b.balance) }],
			{
				area: true,
				formatValue: (n) => money(n, currency),
				title: "Balance over time",
				description: `Month-end balance from ${balances[0].key} to ${balances[balances.length - 1].key}.`,
			}
		);
	} else if (balances.length === 0) {
		const card = container.createDiv({ cls: "fpih-card" });
		emptyState(card, {
			variant: "inline",
			iconName: "piggy-bank",
			title: "No transactions on this account yet",
			description: "Its balance is whatever opening balance you set. Import a statement to see growth over time.",
		});
	}
}

/**
 * Goal progress. A savings account without a target is a bucket — but the target is one number the
 * user has to give us, so it is asked for inline, next to the figure it changes, rather than behind
 * an account-settings modal.
 */
function renderGoal(
	container: HTMLElement,
	plugin: FinancePlugin,
	account: Account,
	balance: number,
	monthlyContribution: number,
	currency: string
): void {
	const card = container.createDiv({ cls: "fpih-card fpih-goal-card" });
	const head = cardHead(card, "Savings goal");
	editableAmount(head, {
		emptyLabel: "Set a goal",
		editLabel: "Change goal",
		value: account.goalAmount,
		placeholder: "10000",
		onSave: async (value) => {
			const target = plugin.store.accounts.find((a) => a.id === account.id);
			if (!target) return;
			target.goalAmount = value;
			await plugin.store.saveAccounts();
			plugin.refreshViews();
		},
	});

	const goal = account.goalAmount;
	if (!goal || goal <= 0) {
		emptyState(card, {
			variant: "inline",
			iconName: "target",
			title: "No goal set",
			description: "Give this account a target and it will tell you how far along you are and when you'd get there.",
		});
		return;
	}

	// A zero expected return: a goal is a plan, and a plan shouldn't be underwritten by a market
	// assumption the user never made.
	const years = monthlyContribution > 0 ? fiProjection(balance, monthlyContribution, 0, goal) : undefined;
	const monthsToGoal = years === undefined ? undefined : Math.round(years * 12);

	renderMeter(card, {
		label: account.goalDate ? `Target by ${formatDay(account.goalDate)}` : "Progress to goal",
		value: balance / goal,
		valueLabel: `${money(balance, currency)} of ${money(goal, currency)}`,
		tone: "ok",
		renderSub: (el) => {
			if (balance >= goal) {
				el.createSpan({ text: "Goal reached — " });
				el.createSpan({ cls: "fpih-money", text: money(balance - goal, currency) });
				el.createSpan({ text: " past the target." });
				return;
			}
			el.createSpan({ cls: "fpih-money", text: money(goal - balance, currency) });
			el.createSpan({ text: " to go" });
			if (monthsToGoal !== undefined && monthlyContribution > 0) {
				el.createSpan({ text: " · at " });
				el.createSpan({ cls: "fpih-money", text: signedMoney(monthlyContribution, currency) });
				el.createSpan({ text: `/mo that's about ${monthsToGoal} month${monthsToGoal === 1 ? "" : "s"}` });
			} else if (monthlyContribution > 0) {
				// `fiProjection` returned nothing despite a positive pace, which means the goal is more
				// than its 60-year horizon away. Saying "no net contributions" here was simply false.
				el.createSpan({ text: " · at " });
				el.createSpan({ cls: "fpih-money", text: signedMoney(monthlyContribution, currency) });
				el.createSpan({ text: "/mo that's further out than this projection goes — more than 60 years" });
			} else {
				el.createSpan({ text: " · no net contributions in the last 12 months, so there's no pace to project" });
			}
		},
	});
}
