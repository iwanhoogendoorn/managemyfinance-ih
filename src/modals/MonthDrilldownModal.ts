import { App, Modal } from "obsidian";
import { budgetStatuses } from "../budgets";
import { formatMoney, formatPct as formatPctValue } from "../format";
import { firstDayOf, lastDayOf, monthOf, shiftMonth, summarizeByMonth, todayIso, windowSummary, categorySpend } from "../kpi";
import type FinancePlugin from "../main";
import { registerOpenModal, unregisterOpenModal } from "../modalRegistry";
import { merchantSourceText, normalizeMerchantKey } from "../recurring";
import type { Transaction } from "../types";
import { barChart } from "../ui/charts";
import { categoryChip, emptyState, icon, renderStat, tabSwitcher } from "../ui/dom";
import { formatEUR, formatPct, metricRow, yearHeaderRow, yoy } from "../ui/metricsTable";
import { goToLedger, UNCATEGORIZED } from "../views/sections/LedgerSection";
import { setStatFoot } from "../views/sections/shared";
import { openImportWizard } from "../wizards/ImportWizard";
import { openReviewQueue } from "./ReviewQueueModal";
import { TransactionDetailModal } from "./TransactionDetailModal";

const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** How many rows the "biggest expenses" and "where it went" panels show before they stop being a summary. */
const TOP_N = 5;
/** How far back a merchant has to be absent for this month's charge to count as "new". */
const NEW_MERCHANT_LOOKBACK_MONTHS = 6;

function monthLabel(month: string): string {
	const idx = Number(month.slice(5, 7)) - 1;
	return `${MONTH_NAMES[idx] ?? month} ${month.slice(0, 4)}`;
}

/**
 * Month (and year) in review.
 *
 * Was a 12-column table and a Close button — the deepest point in the app, and it went nowhere. It is
 * now two tabs: **Month**, the review proper, and **Year**, the original table kept verbatim.
 *
 * Almost nothing here needed new calculation logic. `categorySpend` prefix-matches dates, so a
 * "YYYY-MM" already worked; `budgetStatuses` already took a month; `yoy()` is a generic two-value
 * delta that reads month-over-month exactly as well as year-over-year. The work was surfacing them.
 *
 * The class name and constructor are unchanged because three sections construct it with a year.
 * `MonthDrilldownModal.openMonth()` is the month-first entry point (the command palette, the
 * dashboard action row); a year entry still lands on the Year tab, so clicking a year header does
 * what it always did.
 */
export class MonthDrilldownModal extends Modal {
	/** Which tab opens first — set by the entry point, not by the user. */
	private initialTab: "month" | "year" = "year";
	private month: string;
	private monthPanel?: HTMLElement;

	constructor(app: App, private plugin: FinancePlugin, private year: string, private accountName?: string, private accountId?: string) {
		super(app);
		this.month = `${year}-01`;
	}

	/** Opens straight on the Month tab for `month` ("YYYY-MM"). */
	static openMonth(app: App, plugin: FinancePlugin, month: string, accountName?: string, accountId?: string): MonthDrilldownModal {
		const modal = new MonthDrilldownModal(app, plugin, month.slice(0, 4), accountName, accountId);
		modal.month = month;
		modal.initialTab = "month";
		modal.open();
		return modal;
	}

	private get accountIds(): string[] | undefined {
		return this.accountId ? [this.accountId] : undefined;
	}

	private scopedTransactions(): Transaction[] {
		const all = this.plugin.store.transactions;
		return this.accountId ? all.filter((t) => t.accountId === this.accountId) : all;
	}

	/** The months the data actually covers — the bounds the ◀ / ▶ buttons stop at. */
	private bounds(): { first: string; last: string } | undefined {
		let first: string | undefined;
		let last: string | undefined;
		for (const tx of this.scopedTransactions()) {
			if (!tx.date) continue;
			const m = monthOf(tx.date);
			if (!first || m < first) first = m;
			if (!last || m > last) last = m;
		}
		if (!first || !last) return undefined;
		// The live month is always reachable even when nothing has landed in it yet — "no activity in
		// October" is information, and refusing to navigate there hides it.
		const now = monthOf(todayIso());
		return { first, last: last > now ? last : now };
	}

	onOpen(): void {
		// Registered so a portfolio switch can close it — see modalRegistry.
		registerOpenModal(this);
		this.modalEl.addClass("fp-wizard-modal");
		this.modalEl.addClass("fp-root");
		this.modalEl.addClass("fp-drilldown-modal");
		const c = this.contentEl;
		c.addClass("fp-account-modal");
		c.addClass("fp-month-review");

		// If the entry point was a year and that year has data, start the Month tab on its last active
		// month rather than a blank January.
		if (this.initialTab === "year") this.month = this.lastActiveMonthOf(this.year) ?? `${this.year}-01`;

		c.createEl("h3", {
			text: this.accountName ? `In review — ${this.accountName}` : "In review",
		});

		const tabHost = c.createDiv({ cls: "fp-month-review-tabs" });
		tabSwitcher(tabHost, [
			{
				label: "Month",
				render: (panel) => {
					this.monthPanel = panel;
					this.renderMonth();
				},
			},
			{ label: "Year", render: (panel) => this.renderYear(panel) },
		]);

		// tabSwitcher has no programmatic selection API, so the year entry point selects its tab the
		// same way a user would. Deliberate over reordering the tabs per entry point — a tab strip
		// whose order changes depending on how you got there is worse than one extra click.
		if (this.initialTab === "year") {
			const buttons = tabHost.querySelectorAll<HTMLElement>(".fp-tabs .fp-tab");
			buttons[1]?.click();
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const closeBtn = right.createEl("button", { cls: "fp-btn fp-btn--primary fp-btn-primary", attr: { type: "button" } });
		icon(closeBtn, "check");
		closeBtn.createSpan({ text: "Close" });
		closeBtn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		unregisterOpenModal(this);
		this.contentEl.empty();
	}

	private lastActiveMonthOf(year: string): string | undefined {
		let last: string | undefined;
		for (const tx of this.scopedTransactions()) {
			if (!tx.date?.startsWith(year)) continue;
			const m = monthOf(tx.date);
			if (!last || m > last) last = m;
		}
		return last;
	}

	// ---------- Month tab ----------

	private renderMonth(): void {
		const panel = this.monthPanel;
		if (!panel) return;
		panel.empty();

		this.renderMonthNav(panel);

		const store = this.plugin.store;
		const from = firstDayOf(this.month);
		const to = lastDayOf(this.month);
		const summary = windowSummary(store, from, to, this.accountIds);
		const prevMonth = shiftMonth(this.month, -1);
		const prev = windowSummary(store, firstDayOf(prevMonth), lastDayOf(prevMonth), this.accountIds);

		const monthTxs = this.scopedTransactions().filter((t) => t.date && t.date >= from && t.date <= to);
		if (monthTxs.length === 0) {
			// With no transactions at all there are no bounds, so both arrows above are disabled —
			// "use the arrows" was pointing at two dead buttons. The only thing that helps here is rows.
			const hasAnyData = !!this.bounds();
			emptyState(panel, {
				iconName: "calendar-off",
				title: `No transactions in ${monthLabel(this.month)}`,
				description: hasAnyData
					? "Use the arrows above to look at another month."
					: "This account has no transactions yet — import a bank or broker export and this fills itself in.",
				actionLabel: hasAnyData ? undefined : "Import transactions",
				onAction: hasAnyData
					? undefined
					: () => {
							this.close();
							openImportWizard(this.plugin);
						},
			});
			return;
		}

		const stats = panel.createDiv({ cls: "fp-stat-grid" });
		const prevLabel = MONTH_LABELS[Number(prevMonth.slice(5, 7)) - 1];
		// `sub` is a plain string, so money inside it escapes privacy redaction entirely — the whole
		// reason `setStatFoot` exists. These two footnotes carry last month's actual figures.
		const income = renderStat(stats, {
			label: "Income",
			value: formatMoney(summary.income, "EUR", { decimals: 0 }),
			iconName: "arrow-down-left",
			delta: prev.income > 0 ? { value: yoy(summary.income, prev.income) ?? 0 } : undefined,
		});
		setStatFoot(income, ["vs ", { money: formatMoney(prev.income, "EUR", { decimals: 0 }) }, ` in ${prevLabel}`]);
		const expenses = renderStat(stats, {
			label: "Expenses",
			value: formatMoney(summary.expenses, "EUR", { decimals: 0 }),
			iconName: "arrow-up-right",
			delta: prev.expenses > 0 ? { value: yoy(summary.expenses, prev.expenses) ?? 0, goodIfUp: false } : undefined,
		});
		setStatFoot(expenses, ["vs ", { money: formatMoney(prev.expenses, "EUR", { decimals: 0 }) }, ` in ${prevLabel}`]);
		renderStat(stats, {
			label: "Net",
			value: formatMoney(summary.net, "EUR", { decimals: 0 }),
			iconName: "wallet",
			delta: prev.net !== 0 ? { value: yoy(summary.net, prev.net) ?? 0 } : undefined,
		});
		renderStat(stats, {
			label: "Savings rate",
			value: formatPctValue(summary.savingsRate),
			iconName: "piggy-bank",
			money: false,
			sub: `${formatPctValue(prev.savingsRate)} last month`,
		});

		this.renderCategoryBreakdown(panel);
		this.renderBiggestExpenses(panel, monthTxs);
		this.renderNewMerchants(panel, monthTxs);
		this.renderUncategorized(panel, monthTxs);
		this.renderBudgets(panel);
	}

	private renderMonthNav(panel: HTMLElement): void {
		const bounds = this.bounds();
		const nav = panel.createDiv({ cls: "fp-month-nav" });

		const prev = nav.createEl("button", { cls: "fp-btn fp-btn--ghost fp-btn-ghost fp-btn--icon fp-btn-icon", attr: { type: "button", "aria-label": "Previous month" } });
		icon(prev, "chevron-left");
		prev.disabled = !bounds || shiftMonth(this.month, -1) < bounds.first;
		prev.addEventListener("click", () => {
			this.month = shiftMonth(this.month, -1);
			this.renderMonth();
		});

		nav.createDiv({ cls: "fp-month-nav-label", text: monthLabel(this.month) });

		const next = nav.createEl("button", { cls: "fp-btn fp-btn--ghost fp-btn-ghost fp-btn--icon fp-btn-icon", attr: { type: "button", "aria-label": "Next month" } });
		icon(next, "chevron-right");
		next.disabled = !bounds || shiftMonth(this.month, 1) > bounds.last;
		next.addEventListener("click", () => {
			this.month = shiftMonth(this.month, 1);
			this.renderMonth();
		});
	}

	private renderCategoryBreakdown(panel: HTMLElement): void {
		const store = this.plugin.store;
		const spend = categorySpend(store, this.month, this.accountIds);
		if (spend.size === 0) return;

		const card = panel.createDiv({ cls: "fp-card" });
		card.createEl("h4", { cls: "fp-card-title", text: "Where it went" });
		const entries = [...spend.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
		const rows = entries.map(([categoryId, total]) => {
			const category = store.categories.find((c) => c.id === categoryId);
			return {
				label: category?.name ?? "Uncategorized",
				value: total,
				color: category?.color ?? "var(--fp-ink-muted)",
				iconName: category?.icon,
			};
		});
		// Each bar deep-links into the ledger scoped to this category and month — the drill-down
		// used to be the deepest point in the app with nowhere left to go.
		barChart(card, rows, {
			onRowClick: (i) => {
				const [categoryId] = entries[i];
				this.close();
				void goToLedger(
					this.plugin,
					{
						categoryId: store.categories.some((c) => c.id === categoryId) ? categoryId : UNCATEGORIZED,
						dateFrom: firstDayOf(this.month),
						dateTo: lastDayOf(this.month),
					},
					this.accountIds?.[0]
				);
			},
		});
	}

	private renderBiggestExpenses(panel: HTMLElement, monthTxs: Transaction[]): void {
		const biggest = monthTxs.filter((t) => t.amount < 0).sort((a, b) => a.amount - b.amount).slice(0, TOP_N);
		if (biggest.length === 0) return;

		const card = panel.createDiv({ cls: "fp-card" });
		card.createEl("h4", { cls: "fp-card-title", text: "Biggest expenses this month" });
		const table = card.createEl("table", { cls: "fp-table fp-table--dense" });
		const tbody = table.createEl("tbody");
		biggest.forEach((tx) => {
			const tr = tbody.createEl("tr", { cls: "fp-table-row-clickable" });
			tr.createEl("td", { cls: "fp-cell-date", text: tx.date });
			tr.createEl("td", { cls: "fp-sensitive", text: tx.description });
			tr.createEl("td", { cls: "fp-table-num" }).createSpan({
				cls: "fp-money fp-cell-amount is-negative",
				text: formatMoney(tx.amount, tx.currency || "EUR"),
			});
			tr.addEventListener("click", () => new TransactionDetailModal(this.app, this.plugin, tx).open());
		});
	}

	private renderNewMerchants(panel: HTMLElement, monthTxs: Transaction[]): void {
		const before = shiftMonth(this.month, -NEW_MERCHANT_LOOKBACK_MONTHS);
		const seenBefore = new Set<string>();
		for (const tx of this.scopedTransactions()) {
			if (!tx.date) continue;
			const m = monthOf(tx.date);
			if (m >= this.month || m < before) continue;
			const key = normalizeMerchantKey(merchantSourceText(tx));
			if (key) seenBefore.add(key);
		}

		const fresh = new Map<string, string>();
		for (const tx of monthTxs) {
			if (tx.amount >= 0) continue;
			const key = normalizeMerchantKey(merchantSourceText(tx));
			if (!key || seenBefore.has(key) || fresh.has(key)) continue;
			fresh.set(key, merchantSourceText(tx));
		}
		if (fresh.size === 0) return;

		const card = panel.createDiv({ cls: "fp-card fp-card--tight" });
		card.createEl("h4", { cls: "fp-card-title", text: "New this month" });
		card.createDiv({
			cls: "fp-month-new-merchants fp-sensitive",
			text: `${fresh.size} merchant${fresh.size === 1 ? "" : "s"} you haven't paid in the last ${NEW_MERCHANT_LOOKBACK_MONTHS} months: ${[...fresh.values()].slice(0, 6).join(", ")}`,
		});
	}

	private renderUncategorized(panel: HTMLElement, monthTxs: Transaction[]): void {
		const uncategorized = monthTxs.filter((t) => !t.categoryId);
		if (uncategorized.length === 0) return;

		const row = panel.createDiv({ cls: "fp-month-warn fp-card fp-card--tight fp-tone-warn" });
		icon(row, "alert-triangle");
		row.createSpan({
			cls: "fp-month-warn-text",
			text: `${uncategorized.length} transaction${uncategorized.length === 1 ? "" : "s"} this month ${uncategorized.length === 1 ? "is" : "are"} uncategorized`,
		});
		const btn = row.createEl("button", { cls: "fp-btn fp-btn--primary fp-btn-primary", text: "Review them", attr: { type: "button" } });
		btn.addEventListener("click", () => {
			const ids = new Set(uncategorized.map((t) => t.id));
			this.close();
			openReviewQueue(this.plugin, { transactionIds: ids, title: `Review ${monthLabel(this.month)}` });
		});
	}

	private renderBudgets(panel: HTMLElement): void {
		const store = this.plugin.store;
		// Budgets are portfolio-wide: `budgetStatuses` has no account dimension. Under an
		// account-named heading ("In review — ING Checking"), where every other panel *is* that
		// account, showing them would be a figure that quietly means something else. Portfolio scope
		// only, until budgets themselves can be scoped.
		if (this.accountId) return;
		const statuses = budgetStatuses(store, store.categories, this.month).sort((a, b) => b.pct - a.pct);
		if (statuses.length === 0) return;

		const card = panel.createDiv({ cls: "fp-card" });
		card.createEl("h4", { cls: "fp-card-title", text: `Budgets — ${monthLabel(this.month)}` });
		statuses.forEach((status) => {
			const category = store.categories.find((c) => c.id === status.categoryId);
			if (!category) return;
			const row = card.createDiv({ cls: "fp-month-budget-row" });
			categoryChip(row, category.name, category.color, category.icon);
			const figures = row.createDiv({ cls: "fp-month-budget-figures" });
			figures.createSpan({ cls: "fp-money", text: formatMoney(status.spent, "EUR", { decimals: 0 }) });
			figures.createSpan({ text: " / " });
			figures.createSpan({ cls: "fp-money", text: formatMoney(status.budget, "EUR", { decimals: 0 }) });
			const track = row.createDiv({ cls: "fp-meter-track" });
			const fill = track.createDiv({ cls: "fp-meter-fill fp-tone-" + status.tone });
			fill.style.width = `${Math.min(100, Math.round(status.pct * 100))}%`;
			row.createDiv({
				cls: "fp-month-budget-verdict fp-tone-" + status.tone,
				text:
					status.remaining >= 0
						? `${formatMoney(status.remaining, "EUR", { decimals: 0 })} left`
						: `${formatMoney(-status.remaining, "EUR", { decimals: 0 })} over`,
			});
		});
	}

	// ---------- Year tab (unchanged output) ----------

	private renderYear(panel: HTMLElement): void {
		const months = summarizeByMonth(this.plugin.store, this.year, this.accountId);
		const hasActivity = months.some((m) => m.income > 0 || m.expenses > 0);

		panel.createEl("h4", { cls: "fp-card-title", text: `${this.year} by month` });

		if (!hasActivity) {
			panel.createEl("p", { cls: "fp-step-desc", text: "No transactions recorded for this year." });
			return;
		}

		const wrap = panel.createDiv({ cls: "fp-table-scroll" });
		const table = wrap.createEl("table", { cls: "fp-table fp-table-metrics" });
		// Month headers are buttons now: the Year tab is a map, and every cell in it should lead
		// somewhere. Clicking one opens that month in the Month tab.
		yearHeaderRow(table, MONTH_LABELS, {
			onClick: (label) => {
				const idx = MONTH_LABELS.indexOf(label);
				if (idx === -1) return;
				this.month = `${this.year}-${String(idx + 1).padStart(2, "0")}`;
				this.renderMonth();
				const buttons = this.contentEl.querySelectorAll<HTMLElement>(".fp-tabs .fp-tab");
				buttons[0]?.click();
			},
		});
		const tbody = table.createEl("tbody");

		metricRow(tbody, "Total income", months.map((m) => m.income), formatEUR, { heat: "normal" });
		metricRow(tbody, "Total expenses", months.map((m) => m.expenses), formatEUR, { heat: "invert" });
		metricRow(tbody, "Net savings", months.map((m) => m.net), formatEUR, { emphasize: true, heat: "normal" });
		metricRow(tbody, "Savings rate", months.map((m) => m.savingsRate), (n) => formatPct(n), { heat: "normal" });
		metricRow(tbody, "Passive income", months.map((m) => m.passiveIncome), formatEUR, { heat: "normal" });
	}
}

/** Command-palette / action-row entry point: this month, in review. */
export function openMonthInReview(plugin: FinancePlugin): void {
	const accountId = plugin.settings.activeAccountId;
	const account = accountId ? plugin.store.accounts.find((a) => a.id === accountId) : undefined;
	MonthDrilldownModal.openMonth(plugin.app, plugin, monthOf(todayIso()), account?.name, account?.id);
}
