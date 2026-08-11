import { burnRate, categorySpend, firstDayOf, lastDayOf, monthOf, netWorth, todayIso, windowSummary } from "../../../kpi";
import type FinancePlugin from "../../../main";
import type { Account } from "../../../types";
import { emptyState, renderStat } from "../../../ui/dom";
import { accountCurrency, cardHead, daysBetween, formatDay, formatMonth, money, setStatFoot, signedMoney } from "../shared";

/** The seeded category cash withdrawals land in — the other side of "where did this cash come from". */
const ATM_CATEGORY_PATTERN = /cash|atm/i;

/** After a month of silence, a wallet's balance is a guess rather than a figure. */
const STALE_DAYS = 30;

/**
 * Physical cash is rarely tracked transaction by transaction, so this page stays deliberately light:
 * what's in the wallet, what it's costing, and — the one genuinely useful thing the ledger can add —
 * how much was withdrawn against how much was logged as spent.
 *
 * Deliberately dropped: "transactions logged". That's a data-entry statistic, not a financial one,
 * and it occupied a third of the page.
 */
export function renderCashDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account): void {
	const store = plugin.store;
	const today = new Date();
	const now = todayIso(today);
	const month = monthOf(now);
	const ids = [account.id];
	const currency = accountCurrency(account);

	const balance = netWorth(store, account.id, now);
	const m0 = windowSummary(store, firstDayOf(month), lastDayOf(month), ids);
	const burn = burnRate(store, ids, 6, today);

	const grid = container.createDiv({ cls: "fp-stat-grid" });

	renderStat(grid, { label: "Current balance", value: money(balance, currency), size: "hero", iconName: "banknote" });

	const netCard = renderStat(grid, {
		label: `Net this month`,
		value: signedMoney(m0.net, currency),
		iconName: "arrow-left-right",
	});
	setStatFoot(netCard, [{ money: money(m0.income, currency) }, " in, ", { money: money(m0.expenses, currency) }, ` out in ${formatMonth(month)}`]);

	const burnCard = renderStat(grid, { label: "Cash burn", value: money(burn, currency), iconName: "flame" });
	setStatFoot(burnCard, ["average of the last 6 complete months"]);

	renderCashSources(container, plugin, account, m0.income, currency, month);

	// A wallet nobody has logged in six weeks makes every figure above a guess. Say so.
	const dates = store.transactions.filter((t) => t.accountId === account.id).map((t) => t.date).filter(Boolean);
	const last = dates.reduce<string | undefined>((max, d) => (!max || d > max ? d : max), undefined);
	if (!last) {
		const card = container.createDiv({ cls: "fp-card" });
		emptyState(card, {
			variant: "inline",
			iconName: "banknote",
			title: "Nothing logged on this account yet",
			description: "Its balance is whatever opening balance you set — log a withdrawal or a purchase to start tracking it.",
		});
		return;
	}
	const staleDays = daysBetween(last, now);
	if (staleDays > STALE_DAYS) {
		const note = container.createDiv({ cls: "fp-card fp-card--inset fp-card-note is-warn" });
		note.setText(`Last logged ${formatDay(last)} — ${staleDays} days ago. The balance above is only as good as the last entry.`);
	}
}

/**
 * Cash withdrawn from *other* accounts against cash logged as arriving here. The gap is money that
 * left the bank and was never accounted for, which is the single biggest blind spot in a hand-tracked
 * wallet — and it costs nothing to surface, because ATM withdrawals are already a seeded category.
 */
function renderCashSources(
	container: HTMLElement,
	plugin: FinancePlugin,
	account: Account,
	loggedIn: number,
	currency: string,
	month: string
): void {
	const store = plugin.store;
	const atmCategoryIds = new Set(store.categories.filter((c) => ATM_CATEGORY_PATTERN.test(c.name)).map((c) => c.id));
	if (atmCategoryIds.size === 0) return;

	const otherAccountIds = store.accounts.filter((a) => a.id !== account.id).map((a) => a.id);
	if (otherAccountIds.length === 0) return;

	const spend = categorySpend(store, month, otherAccountIds);
	let withdrawn = 0;
	atmCategoryIds.forEach((id) => (withdrawn += spend.get(id) ?? 0));
	if (withdrawn <= 0) return;

	const card = container.createDiv({ cls: "fp-card" });
	cardHead(card, "Where the cash came from", { sub: `Withdrawals from your other accounts in ${formatMonth(month)}` });

	const row = card.createDiv({ cls: "fp-reconcile" });
	const item = (label: string, value: string, tone?: string) => {
		const cell = row.createDiv({ cls: "fp-reconcile-item" });
		cell.createDiv({ cls: "fp-overline", text: label });
		cell.createDiv({ cls: `fp-reconcile-value fp-money ${tone ?? ""}`.trim(), text: value });
	};
	item("Withdrawn", money(withdrawn, currency));
	item("Logged here", money(loggedIn, currency));
	const gap = withdrawn - loggedIn;
	item("Unaccounted", money(Math.max(0, gap), currency), gap > 0 ? "is-warn" : undefined);

	if (gap > 0) {
		const note = card.createDiv({ cls: "fp-card-note" });
		note.createSpan({ cls: "fp-money", text: money(gap, currency) });
		note.createSpan({
			text: " came out of an account this month without being logged here — either add it, or this wallet balance is overstating what you actually have.",
		});
	}
}
