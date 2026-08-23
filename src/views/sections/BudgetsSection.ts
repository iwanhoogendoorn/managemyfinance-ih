import { Notice } from "obsidian";
import {
	annualBudgetStatuses,
	budgetForMonth,
	budgetStatuses,
	currentBudgetPeriod,
	currentMonth,
	isIncomeCategory,
	oneOffBudgetStatus,
	resolverFor,
	shiftMonth,
	suggestedBudget,
	yearReview,
	type BudgetPeriodResolver,
} from "../../budgets";
import { primaryCategories, secondaryCategoriesOf } from "../../categories";
import { categoryTotals, primaryCategoryTotals } from "../../kpi";
import { formatMoney, formatMoneyForInput, parseMoney } from "../../money";
import type FinancePlugin from "../../main";
import { CategoryExpensesModal } from "../../modals/CategoryExpensesModal";
import { OneOffBudgetModal } from "../../modals/OneOffBudgetModal";
import { DEFAULT_MIN_CYCLE_GAP_DAYS, derivePayCycles, describePayCycle, salaryDates, shiftPayCycle } from "../../payCycle";
import type { Category, OneOffBudget } from "../../types";
import { barChart } from "../../ui/charts";
import { badge, categoryChip, categoryIconLabel, emptyState, icon, ringGauge, type Tone } from "../../ui/dom";
import { renderMeter, renderRingKpiCard } from "../../ui/kpiCard";
import { openMonthPicker } from "../../ui/monthPicker";

function formatEUR(n: number): string {
	return formatMoney(n);
}

function monthLabel(month: string): string {
	const d = new Date(`${month}-01T00:00:00`);
	if (isNaN(d.getTime())) return month;
	return new Intl.DateTimeFormat("en-IE", { month: "long", year: "numeric" }).format(d);
}

/**
 * Month/expand state lives at module scope, same reasoning as LedgerSection's filterState: a full
 * re-render (e.g. plugin.refreshViews() after an unrelated edit elsewhere) rebuilds this whole section
 * from scratch, and a fresh function-local variable would silently reset the viewed month and collapse
 * every expanded category each time that happens.
 */
type BudgetsTab = "monthly" | "annual" | "oneoff" | "review";

const budgetsState: { month: string; expanded: Set<string>; tab: BudgetsTab; year: string } = {
	month: currentMonth(),
	expanded: new Set(),
	tab: "monthly",
	year: String(new Date().getFullYear()),
};

const TABS: { id: BudgetsTab; label: string; icon: string }[] = [
	{ id: "monthly", label: "Monthly", icon: "calendar" },
	{ id: "annual", label: "Annual", icon: "calendar-range" },
	{ id: "oneoff", label: "One-off", icon: "target" },
	{ id: "review", label: "Year review", icon: "line-chart" },
];

const ROLLOVER_TOOLTIP: Record<"off" | "full" | "debt", string> = {
	off: "Every category resets to plan each period — nothing carries forward",
	full: "Unspent carries forward as extra, overspend carries forward too",
	debt: "Only overspend carries forward, as debt you owe yourself — unspent is never banked as a bonus",
};

/** The plain-language line shown right on the page — stating the current philosophy outright,
 *  rather than leaving it to be inferred from whichever badges happen to be showing. */
const ROLLOVER_DESC: Record<"off" | "full" | "debt", string> = {
	off: "You're not budgeting any rollover strategy — every category resets to its plan each period.",
	full: "You're budgeting in rollover mode — unspent carries forward as extra, and overspend carries forward too.",
	debt: "You're budgeting in debt mode — overspend carries forward as debt you owe yourself; unspent is never banked as a bonus.",
};

const ROLLOVER_NOTICE: Record<"off" | "full" | "debt", string> = {
	off: "Budgeting mode set to off — every category resets to plan each period.",
	full: "Budgeting mode set to rollover — unspent carries forward as extra, overspend carries forward too.",
	debt: "Budgeting mode set to debt — overspend carries forward as debt, but unspent is never banked as a bonus.",
};

/**
 * One row per *primary* category — budgets are planned either as a single total, or (opt-in per
 * category, toggled right on the row) split across that category's own secondary categories, in which
 * case the primary's number is just their sum. Expanding a row always shows the secondary breakdown,
 * whether or not it's the thing being budgeted, so "how much did I spend on car washes this year" is
 * always a click away without needing a dedicated budget line for every secondary category that exists.
 */
export function renderBudgetsSection(container: HTMLElement, plugin: FinancePlugin): void {
	container.addClass("fp-section");
	const store = plugin.store;

	function render(): void {
		container.empty();

		const header = container.createDiv({ cls: "fp-section-header" });
		const headText = header.createDiv({ cls: "fp-section-header-text" });
		const titleRow = headText.createDiv({ cls: "fp-section-title-row" });
		const headIcon = titleRow.createDiv({ cls: "fp-section-icon-badge" });
		icon(headIcon, "piggy-bank");
		titleRow.createEl("h2", { text: "Budgets" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "Monthly limits, whole-year envelopes for the costs that don't divide by twelve, one-off pots for a specific plan, and a year-end look back at how close you got.",
		});

		const tabs = container.createDiv({ cls: "fp-tabs" });
		TABS.forEach((tab) => {
			const btn = tabs.createDiv({ cls: "fp-tab" + (budgetsState.tab === tab.id ? " is-active" : "") });
			icon(btn, tab.icon, "fp-tab-icon");
			btn.createSpan({ text: tab.label });
			btn.addEventListener("click", () => {
				budgetsState.tab = tab.id;
				render();
			});
		});

		const body = container.createDiv({ cls: "fp-tab-panel" });
		if (budgetsState.tab === "annual") renderAnnualTab(body);
		else if (budgetsState.tab === "oneoff") renderOneOffTab(body);
		else if (budgetsState.tab === "review") renderYearReviewTab(body);
		else renderMonthlyTab(body);
	}

	/** A year picker shared by the annual and review tabs. */
	function renderYearNav(parent: HTMLElement): void {
		const nav = parent.createDiv({ cls: "fp-month-nav" });
		const prevBtn = nav.createEl("button", { cls: "fp-btn-icon fp-month-nav-btn" });
		icon(prevBtn, "chevron-left");
		prevBtn.setAttr("aria-label", "Previous year");
		prevBtn.addEventListener("click", () => {
			budgetsState.year = String(Number(budgetsState.year) - 1);
			render();
		});
		nav.createDiv({ cls: "fp-month-nav-label", text: budgetsState.year });
		const nextBtn = nav.createEl("button", { cls: "fp-btn-icon fp-month-nav-btn" });
		icon(nextBtn, "chevron-right");
		nextBtn.setAttr("aria-label", "Next year");
		nextBtn.addEventListener("click", () => {
			budgetsState.year = String(Number(budgetsState.year) + 1);
			render();
		});
	}

	function renderMonthlyTab(container: HTMLElement): void {
		const budgeting = store.budgeting;
		const payCycleMode = budgeting.periodMode === "payCycle";
		const cycles =
			payCycleMode && budgeting.salaryCategoryId
				? derivePayCycles(salaryDates(store, budgeting.salaryCategoryId, budgeting.minCycleGapDays ?? DEFAULT_MIN_CYCLE_GAP_DAYS))
				: [];

		if (payCycleMode && (!budgeting.salaryCategoryId || cycles.length === 0)) {
			emptyState(container, {
				iconName: "calendar-clock",
				title: "Pay-cycle budgeting isn't set up yet",
				description: !budgeting.salaryCategoryId
					? "Choose a salary category in Settings → Budgeting to derive your pay cycles from its actual payday dates."
					: "No income has been recorded in your salary category yet, so no pay cycle can be derived — this fills in as soon as a payday is in the ledger.",
			});
			return;
		}

		const resolver = resolverFor(budgeting, cycles);

		// Land on "now" whenever the stored key doesn't belong to the active mode — a fresh mode
		// switch, or a calendar key left over from before pay-cycle mode was turned on (or vice versa).
		if (payCycleMode) {
			// Falls back to the most recent known cycle on the rare chance every derived cycle starts
			// after "today" (a clock oddity, or future-dated ledger entries) — cycles is non-empty here,
			// so there is always at least that one to land on.
			if (!cycles.some((c) => c.key === budgetsState.month)) {
				budgetsState.month = currentBudgetPeriod(budgeting, cycles) ?? cycles[cycles.length - 1].key;
			}
		} else if (!/^\d{4}-\d{2}$/.test(budgetsState.month)) {
			budgetsState.month = currentMonth();
		}

		const month = budgetsState.month;
		const currentCycle = payCycleMode ? cycles.find((c) => c.key === month) : undefined;
		const periodLabel = payCycleMode && currentCycle ? describePayCycle(currentCycle) : monthLabel(month);

		const rolloverMode = store.budgeting.rolloverMode ?? "off";

		const activeCategories = store.categories.filter((c) => !c.archived);
		const primaries = primaryCategories(activeCategories);
		const statuses = budgetStatuses(store, activeCategories, month, rolloverMode, resolver);
		const statusByCategory = new Map(statuses.map((s) => [s.categoryId, s]));
		const rollupSpend = primaryCategoryTotals(store, resolver.rangeOf(month));

		// Split mode is all-or-nothing across the whole list — one switch up top, not a per-row choice —
		// so a category's own budget line and its rolled-up secondaries can't disagree on what's being planned.
		const categoriesWithSecondaries = primaries.filter((p) => secondaryCategoriesOf(store.categories, p.id).length > 0);
		const globalBudgetMode: "total" | "breakdown" =
			categoriesWithSecondaries.length > 0 && categoriesWithSecondaries.every((p) => p.budgetMode === "breakdown") ? "breakdown" : "total";

		container.createDiv({ cls: "fp-budget-rollover-desc", text: ROLLOVER_DESC[rolloverMode] });

		const inDebt = statuses.filter((s) => s.rollover < 0);
		if (inDebt.length > 0) {
			const totalOwed = inDebt.reduce((sum, s) => sum + -s.rollover, 0);
			const banner = container.createDiv({ cls: "fp-budget-debt-banner" });
			icon(banner, "circle-alert", "fp-budget-debt-banner-icon");
			banner.createSpan({
				text: `You owe yourself ${formatEUR(totalOwed)} across ${inDebt.length} categor${inDebt.length === 1 ? "y" : "ies"} from overspending last period — it's already deducted from what's shown as available below.`,
			});
		}

		const headerActions = container.createDiv({ cls: "fp-section-header-actions fp-budget-toolbar" });

		const monthNav = headerActions.createDiv({ cls: "fp-month-nav" });
		const prevKey = payCycleMode ? shiftPayCycle(cycles, month, -1)?.key : shiftMonth(month, -1);
		const prevBtn = monthNav.createEl("button", { cls: "fp-btn-icon fp-month-nav-btn" });
		icon(prevBtn, "chevron-left");
		prevBtn.setAttr("aria-label", payCycleMode ? "Previous cycle" : "Previous month");
		prevBtn.disabled = !prevKey;
		prevBtn.addEventListener("click", () => {
			if (!prevKey) return;
			budgetsState.month = prevKey;
			render();
		});
		const monthLabelBtn = monthNav.createEl("button", { cls: "fp-month-nav-label fp-month-nav-label-btn", text: periodLabel });
		if (payCycleMode) {
			// An irregular list of derived cycles has no calendar shape for a picker grid to show —
			// prev/next plus "current cycle" (below) is the whole of navigation in this mode.
			monthLabelBtn.disabled = true;
		} else {
			monthLabelBtn.addEventListener("click", () => {
				openMonthPicker(monthLabelBtn, {
					value: month,
					onSelect: (m) => {
						budgetsState.month = m;
						render();
					},
				});
			});
		}
		const nextKey = payCycleMode ? shiftPayCycle(cycles, month, 1)?.key : shiftMonth(month, 1);
		const nextBtn = monthNav.createEl("button", { cls: "fp-btn-icon fp-month-nav-btn" });
		icon(nextBtn, "chevron-right");
		nextBtn.setAttr("aria-label", payCycleMode ? "Next cycle" : "Next month");
		nextBtn.disabled = !nextKey;
		nextBtn.addEventListener("click", () => {
			if (!nextKey) return;
			budgetsState.month = nextKey;
			render();
		});
		const isCurrentPeriod = payCycleMode ? month === currentBudgetPeriod(budgeting, cycles) : month === currentMonth();
		if (!isCurrentPeriod) {
			const todayBtn = monthNav.createEl("button", { cls: "fp-btn fp-btn-ghost fp-month-nav-today" });
			todayBtn.setText(payCycleMode ? "Current cycle" : "This month");
			todayBtn.addEventListener("click", () => {
				budgetsState.month = (payCycleMode ? currentBudgetPeriod(budgeting, cycles) : currentMonth()) ?? budgetsState.month;
				render();
			});
		}

		if (categoriesWithSecondaries.length > 0) {
			const modeToggle = headerActions.createDiv({ cls: "fp-budget-mode-toggle" });
			(
				[
					["total", "Total"],
					["breakdown", "Split"],
				] as const
			).forEach(([m, label]) => {
				const btn = modeToggle.createEl("button", { cls: "fp-budget-mode-btn" + (globalBudgetMode === m ? " is-active" : ""), text: label });
				btn.addEventListener("click", () => void setAllBudgetModes(categoriesWithSecondaries, m));
			});
		}

		// One dial for the whole portfolio, not a per-category setting — see PortfolioBudgetingSettings
		// in types.ts for why: twenty independent switches make the overall philosophy something that
		// just accumulates from individual clicks, rather than something stated plainly in one place.
		const rolloverToggle = headerActions.createDiv({ cls: "fp-budget-mode-toggle" });
		(
			[
				["off", "Off"],
				["full", "Rollover"],
				["debt", "Debt"],
			] as const
		).forEach(([m, label]) => {
			const btn = rolloverToggle.createEl("button", { cls: "fp-budget-mode-btn" + (rolloverMode === m ? " is-active" : ""), text: label });
			btn.setAttribute("title", ROLLOVER_TOOLTIP[m]);
			btn.addEventListener("click", () => void setGlobalRolloverMode(m));
		});

		if (primaries.length > 0) {
			const suggestBtn = headerActions.createEl("button", { cls: "fp-btn fp-btn-primary" });
			icon(suggestBtn, "wand-2");
			suggestBtn.createSpan({ text: "Suggest budget" });
			suggestBtn.addEventListener("click", () => void applyAllSuggestions(primaries, month));
		}

		// Totals read against what's actually spendable, so a category carrying a surplus forward is
		// counted at its real size rather than at this month's line alone.
		const totalBudget = statuses.reduce((s, b) => s + b.available, 0);
		const totalSpent = statuses.reduce((s, b) => s + b.spent, 0);
		const remaining = totalBudget - totalSpent;

		// "Budgeted" ring reads how much of the category list has a plan yet; the other two read against the total planned.
		const budgetedPct = primaries.length > 0 ? statuses.length / primaries.length : 0;
		const spentPct = totalBudget > 0 ? totalSpent / totalBudget : 0;
		const remainingPct = totalBudget > 0 ? Math.max(0, remaining) / totalBudget : 0;
		const remainingTone: Tone = statuses.length === 0 ? "neutral" : remaining < 0 ? "bad" : "good";

		const kpis = container.createDiv({ cls: "fp-stat-grid fp-stat-grid-ring" });
		renderRingKpiCard(kpis, {
			label: "Budgeted",
			iconName: "wallet",
			value: formatEUR(totalBudget),
			sub: "across all categories",
			pct: budgetedPct,
			gaugeCaption: "of budget",
			tone: "neutral",
			accentColor: "var(--fp-neutral)",
		});
		renderRingKpiCard(kpis, {
			label: "Spent so far",
			iconName: "trending-down",
			value: formatEUR(totalSpent),
			sub: payCycleMode ? "this cycle" : "this month",
			pct: spentPct,
			gaugeCaption: "of budget",
			tone: "bad",
			accentColor: "var(--fp-good)",
		});
		renderRingKpiCard(kpis, {
			label: "Remaining",
			iconName: "wallet",
			value: formatEUR(remaining),
			sub: "left to spend",
			pct: remainingPct,
			gaugeCaption: "of budget",
			tone: remainingTone,
			accentColor: "#a855f7",
		});

		if (primaries.length === 0) {
			emptyState(container, {
				iconName: "piggy-bank",
				title: "No categories yet",
				description: "Categories are created as you import and tag transactions — come back once you have some.",
			});
			return;
		}

		// Budgeted categories first (most at-risk first), then everything else — sorted by actual
		// spend so the categories most worth budgeting float to the top.
		const sorted = [...primaries].sort((a, b) => {
			const sa = statusByCategory.get(a.id);
			const sb = statusByCategory.get(b.id);
			if (sa && sb) return sb.pct - sa.pct;
			if (sa) return -1;
			if (sb) return 1;
			return (rollupSpend.get(b.id) ?? 0) - (rollupSpend.get(a.id) ?? 0);
		});

		const card = container.createDiv({ cls: "fp-card" });
		const table = card.createEl("table", { cls: "fp-table fp-budget-table" });
		const thead = table.createEl("thead");
		const headRow = thead.createEl("tr");
		headRow.createEl("th", { text: "Category" });
		headRow.createEl("th", { text: "Planned", cls: "fp-table-num" });
		headRow.createEl("th", { text: "Actual", cls: "fp-table-num" });
		headRow.createEl("th", { text: "Remaining", cls: "fp-table-num" });
		headRow.createEl("th", { text: "% met", cls: "fp-table-num fp-budget-pct-col" });
		headRow.createEl("th", { cls: "fp-budget-expand-col" });
		const tbody = table.createEl("tbody");
		sorted.forEach((c) =>
			renderBudgetRow(tbody, c, month, resolver, periodLabel, statusByCategory.get(c.id), rollupSpend.get(c.id) ?? 0)
		);
	}

	function renderBudgetRow(
		parent: HTMLElement,
		category: Category,
		month: string,
		resolver: BudgetPeriodResolver,
		periodLabel: string,
		status: ReturnType<typeof budgetStatuses>[number] | undefined,
		spent: number
	): void {
		const secondaries = secondaryCategoriesOf(store.categories, category.id);
		const hasSecondaries = secondaries.length > 0;
		const expanded = budgetsState.expanded.has(category.id);
		const mode = category.budgetMode ?? "total";

		const row = parent.createEl("tr", { cls: "fp-budget-row" });

		const catCell = row.createEl("td", { cls: "fp-budget-cat-cell" });
		const catCol = categoryIconLabel(catCell, category.name, category.color, category.icon);

		const catMeta = catCol.createDiv({ cls: "fp-budget-cat-meta" });
		if (isIncomeCategory(category)) badge(catMeta, "income target", "good");
		if (status && status.rollover !== 0) {
			badge(
				catMeta,
				status.rollover > 0 ? `+${formatEUR(status.rollover)} carried in` : `owes ${formatEUR(-status.rollover)}`,
				status.rollover > 0 ? "good" : "bad"
			);
		}

		const catBar = catCol.createDiv({ cls: `fp-budget-cat-bar fp-tone-${status?.tone ?? "neutral"}` });
		const catTrack = catBar.createDiv({ cls: "fp-budget-cat-track" });
		catTrack.createDiv({ cls: "fp-budget-cat-fill" }).style.width = `${Math.max(0, Math.min(100, (status?.pct ?? 0) * 100))}%`;
		catBar.createSpan({ cls: "fp-budget-cat-pct", text: `${Math.round((status?.pct ?? 0) * 100)}%` });

		const plannedCell = row.createEl("td", { cls: "fp-table-num fp-budget-planned-cell" });
		const planned = budgetForMonth(store.categories, category, month);
		if (mode === "breakdown" && hasSecondaries) {
			plannedCell.createDiv({ cls: "fp-budget-computed", text: planned !== undefined ? formatEUR(planned) : "—" });
			plannedCell.createDiv({ cls: "fp-budget-hint-text", text: `from ${secondaries.length} subcategor${secondaries.length === 1 ? "y" : "ies"}` });
		} else {
			// Text, not number: a number input silently discards "1.234,56" (or "1,234.56", depending on
			// which locale the browser is in) rather than reading it. parseMoney handles both — see money.ts.
			const input = plannedCell.createEl("input", {
				type: "text",
				cls: "fp-budget-input-plain",
				attr: { inputmode: "decimal", autocomplete: "off", placeholder: "0" },
			});
			input.value = formatMoneyForInput(planned);
			input.addEventListener("blur", () => void saveCategoryBudget(category, month, input.value));
			input.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") input.blur();
			});
		}

		const spentCell = row.createEl("td", { cls: "fp-table-num fp-money" });
		if (spent > 0) {
			spentCell.addClass("fp-table-value-clickable");
			spentCell.setText(formatEUR(spent));
			spentCell.addEventListener("click", () => new CategoryExpensesModal(plugin.app, plugin, category, resolver.rangeOf(month), periodLabel).open());
		} else {
			spentCell.setText(formatEUR(spent));
		}

		const remainingCell = row.createEl("td", { cls: "fp-table-num fp-money" });
		if (planned) {
			// Against what's actually spendable, so a rolled-over surplus shows up as real headroom.
			const remaining = (status?.available ?? planned) - spent;
			remainingCell.addClass(remaining < 0 ? "fp-budget-remaining-over" : "fp-budget-remaining-under");
			remainingCell.setText(remaining >= 0 ? formatEUR(remaining) : `-${formatEUR(-remaining)}`);
		} else {
			remainingCell.createSpan({ cls: "fp-budget-hint-text", text: "—" });
		}

		const pctCell = row.createEl("td", { cls: "fp-table-num fp-budget-pct-col" });
		ringGauge(pctCell, { pct: status?.pct ?? 0, tone: status?.tone ?? "neutral", size: 40 });

		const expandCell = row.createEl("td", { cls: "fp-budget-expand-col" });
		const chevron = expandCell.createSpan({ cls: "fp-budget-expand" + (hasSecondaries ? "" : " is-empty") });
		if (hasSecondaries) {
			icon(chevron, expanded ? "chevron-down" : "chevron-right");
			chevron.addEventListener("click", () => {
				if (expanded) budgetsState.expanded.delete(category.id);
				else budgetsState.expanded.add(category.id);
				render();
			});
		}

		if (expanded && hasSecondaries) {
			const subRow = parent.createEl("tr", { cls: "fp-budget-subrow" });
			const subCell = subRow.createEl("td", { attr: { colspan: "6" } });
			renderSecondaryBreakdown(subCell, category, secondaries, month, resolver, periodLabel, mode);
		}
	}

	function renderSecondaryBreakdown(
		container: HTMLElement,
		primary: Category,
		secondaries: Category[],
		month: string,
		resolver: BudgetPeriodResolver,
		periodLabel: string,
		mode: "total" | "breakdown"
	): void {
		const wrap = container.createDiv({ cls: "fp-budget-subwrap" });
		const leafSpend = categoryTotals(store, resolver.rangeOf(month));
		const directSpend = leafSpend.get(primary.id) ?? 0;

		if (mode === "breakdown") {
			const table = wrap.createEl("table", { cls: "fp-table fp-budget-subtable" });
			const tbody = table.createEl("tbody");
			secondaries.forEach((sub) => {
				const tr = tbody.createEl("tr");
				const catCell = tr.createEl("td");
				categoryChip(catCell, sub.name, sub.color, sub.icon);

				const plannedCell = tr.createEl("td", { cls: "fp-table-num" });
				const subPlanned = budgetForMonth(store.categories, sub, month);
				const input = plannedCell.createEl("input", {
					type: "text",
					cls: "fp-budget-input-plain",
					attr: { inputmode: "decimal", autocomplete: "off", placeholder: "0" },
				});
				input.value = formatMoneyForInput(subPlanned);
				input.addEventListener("blur", () => void saveCategoryBudget(sub, month, input.value));
				input.addEventListener("keydown", (ev) => {
					if (ev.key === "Enter") input.blur();
				});

				const spentCell = tr.createEl("td", { cls: "fp-table-num fp-money" });
				const subSpent = leafSpend.get(sub.id) ?? 0;
				if (subSpent > 0) {
					spentCell.addClass("fp-table-value-clickable");
					spentCell.setText(formatEUR(subSpent));
					spentCell.addEventListener("click", () => new CategoryExpensesModal(plugin.app, plugin, sub, resolver.rangeOf(month), periodLabel).open());
				} else {
					spentCell.setText(formatEUR(subSpent));
				}

				const remainingCell = tr.createEl("td", { cls: "fp-table-num fp-money" });
				if (subPlanned) {
					const remaining = subPlanned - subSpent;
					remainingCell.addClass(remaining < 0 ? "fp-budget-remaining-over" : "fp-budget-remaining-under");
					remainingCell.setText(remaining >= 0 ? formatEUR(remaining) : `-${formatEUR(-remaining)}`);
				} else {
					remainingCell.createSpan({ cls: "fp-budget-hint-text", text: "—" });
				}
			});
			if (directSpend > 0) {
				const tr = tbody.createEl("tr", { cls: "fp-budget-subrow-other" });
				const catCell = tr.createEl("td");
				catCell.createSpan({ cls: "fp-budget-hint-text", text: `Other ${primary.name} (no subcategory)` });
				tr.createEl("td", { cls: "fp-table-num" });
				tr.createEl("td", { cls: "fp-table-num fp-money", text: formatEUR(directSpend) });
				tr.createEl("td", { cls: "fp-table-num" });
			}
		} else {
			const rows = secondaries
				.map((s) => ({ label: s.name, value: leafSpend.get(s.id) ?? 0, color: s.color, iconName: s.icon }))
				.filter((r) => r.value > 0);
			if (directSpend > 0) rows.push({ label: `Other ${primary.name}`, value: directSpend, color: primary.color, iconName: "more-horizontal" });
			if (rows.length === 0) {
				wrap.createDiv({ cls: "fp-budget-hint-text", text: `No spend recorded under ${primary.name}'s subcategories this month.` });
			} else {
				barChart(
					wrap,
					rows.sort((a, b) => b.value - a.value)
				);
			}
		}
	}

	async function saveCategoryBudget(category: Category, month: string, rawValue: string): Promise<void> {
		if (rawValue.trim() !== "" && parseMoney(rawValue) === undefined) {
			new Notice(`Couldn't read "${rawValue}" as an amount — budget left unchanged.`);
			render();
			return;
		}
		const parsed = parseMoney(rawValue);
		const amount = parsed !== undefined && parsed > 0 ? parsed : undefined;
		const target = store.categories.find((c) => c.id === category.id);
		if (!target) return;
		if ((target.budgetHistory?.[month] ?? undefined) === amount) return;
		target.budgetHistory = { ...target.budgetHistory };
		if (amount === undefined) delete target.budgetHistory[month];
		else target.budgetHistory[month] = amount;
		await store.saveCategories();
		new Notice(
			amount
				? `Budget for "${category.name}" set to ${formatEUR(amount)} for ${monthLabel(month)}`
				: `Budget removed for "${category.name}" for ${monthLabel(month)}`
		);
		render();
	}

	/** All-or-nothing: every category that has secondaries switches to the same mode together, so the
	 *  budgeted-vs-actual math for the whole list is never a mix of totals and breakdowns. */
	async function setAllBudgetModes(categories: Category[], mode: "total" | "breakdown"): Promise<void> {
		const ids = new Set(categories.map((c) => c.id));
		const targets = store.categories.filter((c) => ids.has(c.id));
		if (targets.every((c) => (c.budgetMode ?? "total") === mode)) return;
		targets.forEach((c) => (c.budgetMode = mode));
		await store.saveCategories();
		render();
	}

	async function applyAllSuggestions(primaries: Category[], month: string): Promise<void> {
		let applied = 0;
		for (const p of primaries) {
			if ((p.budgetMode ?? "total") === "breakdown") {
				for (const sub of secondaryCategoriesOf(store.categories, p.id)) {
					if ((sub.budgetHistory?.[month] ?? 0) > 0) continue;
					const suggestion = suggestedBudget(store, sub.id, month);
					if (suggestion) {
						sub.budgetHistory = { ...sub.budgetHistory, [month]: suggestion };
						applied++;
					}
				}
			} else {
				if ((p.budgetHistory?.[month] ?? 0) > 0) continue;
				const suggestion = suggestedBudget(store, p.id, month, 3, "rollup");
				if (suggestion) {
					p.budgetHistory = { ...p.budgetHistory, [month]: suggestion };
					applied++;
				}
			}
		}
		if (applied === 0) {
			new Notice("No suggestions available yet — categories need a bit of spending history first.");
			return;
		}
		await store.saveCategories();
		new Notice(`Applied a suggested budget to ${applied} categor${applied === 1 ? "y" : "ies"} for ${monthLabel(month)}.`);
		render();
	}


	/**
	 * Whole-year envelopes. Some costs simply don't divide into months without lying about them —
	 * annual insurance, road tax, a yearly renewal — and forcing them into a monthly line produces
	 * one month of huge overspend and eleven of meaningless surplus.
	 */
	function renderAnnualTab(container: HTMLElement): void {
		const year = budgetsState.year;
		const toolbar = container.createDiv({ cls: "fp-section-header-actions fp-budget-toolbar" });
		renderYearNav(toolbar);

		const activeCategories = store.categories.filter((c) => !c.archived);
		const primaries = primaryCategories(activeCategories);
		const statuses = annualBudgetStatuses(store, activeCategories, year);
		const statusById = new Map(statuses.map((s) => [s.categoryId, s]));
		const yearSpend = primaryCategoryTotals(store, year);

		const planned = statuses.reduce((sum, s) => sum + s.budget, 0);
		const spent = statuses.reduce((sum, s) => sum + s.spent, 0);
		const kpis = container.createDiv({ cls: "fp-stat-grid fp-stat-grid-ring" });
		renderRingKpiCard(kpis, {
			label: "Planned for the year",
			iconName: "calendar-range",
			value: formatEUR(planned),
			sub: `${statuses.length} categor${statuses.length === 1 ? "y" : "ies"}`,
			pct: primaries.length > 0 ? statuses.length / primaries.length : 0,
			gaugeCaption: "have a plan",
			tone: "neutral",
			accentColor: "var(--fp-neutral)",
		});
		renderRingKpiCard(kpis, {
			label: "Spent so far",
			iconName: "trending-down",
			value: formatEUR(spent),
			sub: `in ${year}`,
			pct: planned > 0 ? spent / planned : 0,
			gaugeCaption: "of plan",
			tone: "bad",
			accentColor: "var(--fp-good)",
		});

		const card = container.createDiv({ cls: "fp-card" });
		card.createEl("h3", { text: `Annual budgets — ${year}` });
		card.createDiv({
			cls: "fp-section-subtitle",
			text: "Tracked against the whole year's spend in the category, independently of any monthly limit you also set.",
		});

		const table = card.createEl("table", { cls: "fp-table fp-budget-table" });
		const headRow = table.createEl("thead").createEl("tr");
		headRow.createEl("th", { text: "Category" });
		headRow.createEl("th", { text: "Planned for the year", cls: "fp-table-num" });
		headRow.createEl("th", { text: `Spent in ${year}`, cls: "fp-table-num" });
		headRow.createEl("th", { text: "Remaining", cls: "fp-table-num" });
		headRow.createEl("th", { text: "% met", cls: "fp-table-num fp-budget-pct-col" });
		const tbody = table.createEl("tbody");

		// Categories with a plan first, then whatever you actually spend most on — the ones worth planning.
		[...primaries]
			.sort((a, b) => {
				const sa = statusById.get(a.id);
				const sb = statusById.get(b.id);
				if (sa && sb) return sb.pct - sa.pct;
				if (sa) return -1;
				if (sb) return 1;
				return (yearSpend.get(b.id) ?? 0) - (yearSpend.get(a.id) ?? 0);
			})
			.forEach((category) => {
				const status = statusById.get(category.id);
				const spentHere = yearSpend.get(category.id) ?? 0;
				const tr = tbody.createEl("tr", { cls: "fp-budget-row" });

				const catCell = tr.createEl("td", { cls: "fp-budget-cat-cell" });
				const col = categoryIconLabel(catCell, category.name, category.color, category.icon);
				if (isIncomeCategory(category)) badge(col, "income", "good");

				const plannedCell = tr.createEl("td", { cls: "fp-table-num fp-budget-planned-cell" });
				const input = plannedCell.createEl("input", {
					type: "text",
					cls: "fp-budget-input-plain",
					attr: { inputmode: "decimal", autocomplete: "off", placeholder: "0" },
				});
				input.value = formatMoneyForInput(category.annualBudgets?.[year]);
				input.addEventListener("blur", () => void saveAnnualBudget(category, year, input.value));
				input.addEventListener("keydown", (ev) => {
					if (ev.key === "Enter") input.blur();
				});

				tr.createEl("td", { cls: "fp-table-num fp-money", text: formatEUR(spentHere) });

				const remainingCell = tr.createEl("td", { cls: "fp-table-num fp-money" });
				if (status) {
					remainingCell.addClass(status.remaining < 0 ? "fp-budget-remaining-over" : "fp-budget-remaining-under");
					remainingCell.setText(status.remaining >= 0 ? formatEUR(status.remaining) : `-${formatEUR(-status.remaining)}`);
				} else {
					remainingCell.createSpan({ cls: "fp-budget-hint-text", text: "—" });
				}

				const pctCell = tr.createEl("td", { cls: "fp-table-num fp-budget-pct-col" });
				ringGauge(pctCell, { pct: status?.pct ?? 0, tone: status?.tone ?? "neutral", size: 40 });
			});
	}

	/** Named pots for one specific plan over one specific window — a holiday, a kitchen, a wedding. */
	function renderOneOffTab(container: HTMLElement): void {
		const toolbar = container.createDiv({ cls: "fp-section-header-actions fp-budget-toolbar" });
		const addBtn = toolbar.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(addBtn, "plus");
		addBtn.createSpan({ text: "New one-off budget" });
		addBtn.addEventListener("click", () => new OneOffBudgetModal(plugin.app, plugin, { onSaved: () => render() }).open());

		const budgets = store.oneOffBudgets.filter((b) => !b.archived);
		if (budgets.length === 0) {
			emptyState(container, {
				iconName: "target",
				title: "No one-off budgets",
				description:
					"For a plan that isn't monthly and isn't annual: a holiday, a renovation, a wedding. It tracks its own spend over its own dates without disturbing your monthly envelopes.",
				actionLabel: "Create one",
				onAction: () => new OneOffBudgetModal(plugin.app, plugin, { onSaved: () => render() }).open(),
			});
			return;
		}

		budgets.forEach((budget) => {
			const status = oneOffBudgetStatus(store, budget);
			const card = container.createDiv({ cls: "fp-card" });
			const head = card.createDiv({ cls: "fp-section-title-row" });
			head.createEl("h3", { text: budget.name });
			badge(head, status.daysLeft >= 0 ? `${status.daysLeft} days left` : "closed", status.daysLeft >= 0 ? "neutral" : "warn");

			const editBtn = head.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-icon" });
			icon(editBtn, "pencil");
			editBtn.addEventListener("click", () => new OneOffBudgetModal(plugin.app, plugin, { budget, onSaved: () => render() }).open());

			renderMeter(card, {
				label: `${budget.startDate} → ${budget.endDate}`,
				value: Math.min(1, status.pct),
				valueLabel: `${Math.round(status.pct * 100)}%`,
				sub: `${formatEUR(status.spent)} of ${formatEUR(status.budget)} · ${
					status.remaining >= 0 ? `${formatEUR(status.remaining)} left` : `${formatEUR(-status.remaining)} over`
				} · ${status.transactionCount} transaction${status.transactionCount === 1 ? "" : "s"}`,
			});

			if (budget.categoryIds && budget.categoryIds.length > 0) {
				const scope = card.createDiv({ cls: "fp-budget-hint-text" });
				scope.setText("Counts spending in: ");
				budget.categoryIds.forEach((id) => {
					const cat = store.categories.find((c) => c.id === id);
					if (cat) categoryChip(scope, cat.name, cat.color, cat.icon);
				});
			}
			if (budget.notes) card.createDiv({ cls: "fp-sub-card-notes", text: budget.notes });
		});
	}

	/**
	 * What you planned against what happened, month by month, for a whole year.
	 *
	 * This is the payoff for keeping a budget per month rather than overwriting one number: a year of
	 * intentions survives next to the outcomes, so "which categories do I consistently under-budget"
	 * becomes a question with an answer.
	 */
	function renderYearReviewTab(container: HTMLElement): void {
		const year = budgetsState.year;
		const toolbar = container.createDiv({ cls: "fp-section-header-actions fp-budget-toolbar" });
		renderYearNav(toolbar);

		const rows = yearReview(store, store.categories.filter((c) => !c.archived), year);
		if (rows.length === 0) {
			emptyState(container, {
				iconName: "line-chart",
				title: `Nothing to review for ${year}`,
				description: "No budgets planned and no spending recorded in this year.",
			});
			return;
		}

		const plannedTotal = rows.reduce((sum, r) => sum + r.plannedTotal, 0);
		const actualTotal = rows.reduce((sum, r) => sum + r.actualTotal, 0);
		const onTarget = rows.reduce((sum, r) => sum + r.monthsOnTarget, 0);
		const monthsPlanned = rows.reduce((sum, r) => sum + r.monthsPlanned, 0);

		const kpis = container.createDiv({ cls: "fp-stat-grid fp-stat-grid-ring" });
		renderRingKpiCard(kpis, {
			label: "Planned",
			iconName: "wallet",
			value: formatEUR(plannedTotal),
			sub: `across ${year}`,
			pct: 1,
			gaugeCaption: "planned",
			tone: "neutral",
			accentColor: "var(--fp-neutral)",
		});
		renderRingKpiCard(kpis, {
			label: "Actual",
			iconName: "trending-down",
			value: formatEUR(actualTotal),
			sub: actualTotal <= plannedTotal ? "under plan" : "over plan",
			pct: plannedTotal > 0 ? actualTotal / plannedTotal : 0,
			gaugeCaption: "of plan",
			tone: actualTotal <= plannedTotal ? "good" : "bad",
			accentColor: "var(--fp-good)",
		});
		renderRingKpiCard(kpis, {
			label: "Months on target",
			iconName: "check-check",
			value: monthsPlanned > 0 ? `${onTarget}/${monthsPlanned}` : "—",
			sub: "category-months within plan",
			pct: monthsPlanned > 0 ? onTarget / monthsPlanned : 0,
			gaugeCaption: "on target",
			tone: "good",
			accentColor: "#a855f7",
		});

		const card = container.createDiv({ cls: "fp-card" });
		card.createEl("h3", { text: `Planned vs actual — ${year}` });
		const wrap = card.createDiv({ cls: "fp-table-scroll" });
		const table = wrap.createEl("table", { cls: "fp-table" });
		const headRow = table.createEl("thead").createEl("tr");
		headRow.createEl("th", { text: "Category" });
		["Planned", "Actual", "Variance", "On target"].forEach((h) => headRow.createEl("th", { text: h, cls: "fp-table-num" }));
		const tbody = table.createEl("tbody");

		rows.forEach((row) => {
			const category = store.categories.find((c) => c.id === row.categoryId);
			const tr = tbody.createEl("tr");
			const catCell = tr.createEl("td");
			if (category) categoryChip(catCell, category.name, category.color, category.icon);
			else catCell.setText(row.categoryName);

			tr.createEl("td", { cls: "fp-table-num fp-money", text: row.plannedTotal > 0 ? formatEUR(row.plannedTotal) : "—" });
			tr.createEl("td", { cls: "fp-table-num fp-money", text: formatEUR(row.actualTotal) });

			const varianceCell = tr.createEl("td", { cls: "fp-table-num fp-money" });
			if (row.plannedTotal > 0) {
				varianceCell.addClass(row.variance >= 0 ? "fp-budget-remaining-under" : "fp-budget-remaining-over");
				varianceCell.setText(row.variance >= 0 ? formatEUR(row.variance) : `-${formatEUR(-row.variance)}`);
			} else {
				varianceCell.createSpan({ cls: "fp-budget-hint-text", text: "never planned" });
			}

			tr.createEl("td", {
				cls: "fp-table-num",
				text: row.monthsPlanned > 0 ? `${row.monthsOnTarget}/${row.monthsPlanned}` : "—",
			});
		});
	}

	async function saveAnnualBudget(category: Category, year: string, rawValue: string): Promise<void> {
		if (rawValue.trim() !== "" && parseMoney(rawValue) === undefined) {
			new Notice(`Couldn't read "${rawValue}" as an amount — budget left unchanged.`);
			render();
			return;
		}
		const parsed = parseMoney(rawValue);
		const amount = parsed !== undefined && parsed > 0 ? parsed : undefined;
		const target = store.categories.find((c) => c.id === category.id);
		if (!target) return;
		if ((target.annualBudgets?.[year] ?? undefined) === amount) return;
		target.annualBudgets = { ...target.annualBudgets };
		if (amount === undefined) delete target.annualBudgets[year];
		else target.annualBudgets[year] = amount;
		await store.saveCategories();
		new Notice(amount ? `Annual budget for "${category.name}" set to ${formatEUR(amount)} for ${year}` : `Annual budget removed for "${category.name}"`);
		render();
	}

	/** One dial for the whole portfolio (see PortfolioBudgetingSettings.rolloverMode in types.ts). */
	async function setGlobalRolloverMode(mode: "off" | "full" | "debt"): Promise<void> {
		if ((store.budgeting.rolloverMode ?? "off") === mode) return;
		store.budgeting.rolloverMode = mode;
		await store.saveBudgeting();
		new Notice(ROLLOVER_NOTICE[mode]);
		render();
	}

	render();
}
