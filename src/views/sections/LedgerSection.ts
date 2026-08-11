import {
	firstDayOf,
	isoWeekOf,
	isoWeekRange,
	lastDayOf,
	monthOf,
	quarterOf,
	quarterRange,
	shiftIsoWeek,
	shiftMonth,
	shiftQuarter,
	todayIso,
} from "../../kpi";
import type FinancePlugin from "../../main";
import { AddTransactionModal } from "../../modals/AddTransactionModal";
import { TransactionDetailModal } from "../../modals/TransactionDetailModal";
import type { Transaction } from "../../types";
import { badge, categoryChip, emptyState, icon } from "../../ui/dom";
import { openImportWizard } from "../../wizards/ImportWizard";
import { money, portfolioCurrency } from "./shared";

type LedgerSortColumn = "date" | "description" | "account" | "category" | "amount";
type LedgerSortDirection = "asc" | "desc";

/** The sentinel the category `<select>` uses for "has no category at all". */
export const UNCATEGORIZED = "__uncategorized";

export type LedgerDatePreset =
	| "all"
	| "this-month"
	| "last-3-months"
	| "this-year"
	| "last-12-months"
	| "year"
	| "quarter"
	| "month"
	| "week"
	| "custom";

/** The specific instance for a "pick a period" preset — format depends on which one:
 *  "year" → "YYYY" · "quarter" → "YYYY-Q#" · "month" → "YYYY-MM" · "week" → "YYYY-Www" (ISO-8601,
 *  matching `<input type="week">`'s own value format). Unused by the relative presets and "custom". */
export interface LedgerFilterState {
	search: string;
	accountId: string;
	categoryId: string;
	dateFrom: string;
	dateTo: string;
	preset: LedgerDatePreset;
	periodValue: string;
}

export type LedgerFilterPatch = Partial<LedgerFilterState>;

/**
 * Filter + sort state lives at module scope — outside renderLedger's own function scope — so that a
 * full re-render (e.g. the one FinanceView.refresh() triggers after a category edit) doesn't wipe
 * out whatever the user had selected. renderLedger reads from these on every call and writes back
 * to them whenever a control changes.
 */
const filterState: LedgerFilterState = {
	search: "",
	accountId: "",
	categoryId: "",
	dateFrom: "",
	dateTo: "",
	preset: "all",
	periodValue: "",
};

const sortState: LedgerSortState = {
	column: "date",
	direction: "desc",
};

interface LedgerSortState {
	column: LedgerSortColumn;
	direction: LedgerSortDirection;
}

/** First click on a text column reads A→Z; first click on date/amount reads newest/largest first. */
const DEFAULT_SORT_DIRECTION: Record<LedgerSortColumn, LedgerSortDirection> = {
	date: "desc",
	description: "asc",
	account: "asc",
	category: "asc",
	amount: "desc",
};

/** How many rows one page shows. "Load more" adds another page rather than rendering 5,000 rows. */
const PAGE_SIZE = 200;

const PRESET_LABEL: Record<LedgerDatePreset, string> = {
	all: "All time",
	"this-month": "This month",
	"last-3-months": "Last 3 months",
	"this-year": "This year",
	"last-12-months": "Last 12 months",
	year: "Pick a year…",
	quarter: "Pick a quarter…",
	month: "Pick a month…",
	week: "Pick a week…",
	custom: "Custom range…",
};

/** The four "pick a specific one" presets, as opposed to the relative ones ("this month") and "custom". */
const PERIOD_PRESETS: LedgerDatePreset[] = ["year", "quarter", "month", "week"];

/** A sensible starting instance when the user first switches into a period preset — "now", in that
 *  preset's own value format, so the picker doesn't open on a blank/undefined period. */
function defaultPeriodValue(preset: LedgerDatePreset, today: Date = new Date()): string {
	const now = todayIso(today);
	switch (preset) {
		case "year":
			return now.slice(0, 4);
		case "quarter":
			return quarterOf(now);
		case "month":
			return monthOf(now);
		case "week":
			return isoWeekOf(now);
		default:
			return "";
	}
}

/** A preset's own window. `all` and `custom` don't own one — custom keeps whatever the user typed. */
function presetRange(preset: LedgerDatePreset, periodValue: string, today: Date = new Date()): { from: string; to: string } | undefined {
	const now = todayIso(today);
	const month = monthOf(now);
	switch (preset) {
		case "this-month":
			return { from: firstDayOf(month), to: lastDayOf(month) };
		case "last-3-months":
			return { from: firstDayOf(shiftMonth(month, -2)), to: lastDayOf(month) };
		case "this-year":
			return { from: `${now.slice(0, 4)}-01-01`, to: `${now.slice(0, 4)}-12-31` };
		case "last-12-months":
			return { from: firstDayOf(shiftMonth(month, -11)), to: lastDayOf(month) };
		case "year":
			return periodValue ? { from: `${periodValue}-01-01`, to: `${periodValue}-12-31` } : undefined;
		case "quarter":
			return periodValue ? quarterRange(periodValue) : undefined;
		case "month":
			return periodValue ? { from: firstDayOf(periodValue), to: lastDayOf(periodValue) } : undefined;
		case "week":
			return periodValue ? isoWeekRange(periodValue) : undefined;
		default:
			return undefined;
	}
}

/** The label a period preset's chip/dropdown-adjacent text should show — "2025", "Q3 2025",
 *  "July 2025", "Week 33, 2025" — since the raw value formats aren't human-readable as-is. */
function periodLabel(preset: LedgerDatePreset, periodValue: string): string {
	if (!periodValue) return PRESET_LABEL[preset];
	switch (preset) {
		case "year":
			return periodValue;
		case "quarter":
			return `Q${periodValue.slice(6, 7)} ${periodValue.slice(0, 4)}`;
		case "month": {
			const [y, m] = periodValue.split("-");
			const monthName = new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" });
			return `${monthName} ${y}`;
		}
		case "week":
			return `Week ${periodValue.slice(6, 8)}, ${periodValue.slice(0, 4)}`;
		default:
			return PRESET_LABEL[preset];
	}
}

/**
 * Merges a patch into the shared ledger filter. The deep-link seam: insight cards, the review queue
 * and the "uncategorized" chips all navigate by setting a filter and switching view rather than by
 * passing props through a render tree that doesn't have any.
 */
export function setLedgerFilter(patch: LedgerFilterPatch): void {
	Object.assign(filterState, patch);
	// An explicit window that didn't come from a preset is, by definition, custom.
	if ((patch.dateFrom !== undefined || patch.dateTo !== undefined) && patch.preset === undefined) {
		filterState.preset = filterState.dateFrom || filterState.dateTo ? "custom" : "all";
	}
}

export function getLedgerFilter(): Readonly<LedgerFilterState> {
	return filterState;
}

export function clearLedgerFilter(): void {
	setLedgerFilter({ search: "", accountId: "", categoryId: "", dateFrom: "", dateTo: "", preset: "all", periodValue: "" });
}

/**
 * Where an account-less ledger link actually lands. Exported so a caller can *name* its destination
 * before sending the user there: a portfolio-wide figure that opens one account's rows is a lie the
 * label has to own, and it can only do that if it knows which account.
 */
export function busiestAccountId(store: { accounts: { id: string }[]; transactions: { accountId: string }[] }): string | undefined {
	const counts = new Map<string, number>();
	for (const tx of store.transactions) counts.set(tx.accountId, (counts.get(tx.accountId) ?? 0) + 1);
	return store.accounts.slice().sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0))[0]?.id;
}

/**
 * Deep link into the ledger with a filter applied. The ledger only renders on an account page (All
 * Accounts is an overview, not a transaction browser), so a link carrying no account of its own
 * falls back to the busiest account rather than navigating somewhere with nothing to show.
 */
export async function goToLedger(plugin: FinancePlugin, patch: LedgerFilterPatch, accountId?: string): Promise<void> {
	setLedgerFilter(patch);
	const store = plugin.store;
	let target = accountId ?? patch.accountId ?? plugin.settings.activeAccountId;
	if (!target || !store.accounts.some((a) => a.id === target)) target = busiestAccountId(store);
	if (!target) return;
	// The account filter is redundant once the page is scoped to that account, and leaving it set
	// would silently hide every row if the user later switched to a different account.
	if (filterState.accountId === target) filterState.accountId = "";
	plugin.settings.activeAccountId = target;
	plugin.settings.activeView = undefined;
	await plugin.saveSettings();
	plugin.refreshViews();
}

/** The transactions table for the current scope (one account, or all) — no page header of its own; the caller supplies that. */
export function renderLedger(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;

	const activeAccountId = plugin.settings.activeAccountId;
	const activeAccount = activeAccountId ? store.accounts.find((a) => a.id === activeAccountId) : undefined;

	const scopedTransactions = activeAccountId ? store.transactions.filter((t) => t.accountId === activeAccountId) : store.transactions;
	if (scopedTransactions.length === 0) {
		const empty = emptyState(container, {
			iconName: "inbox",
			title: activeAccount ? `No transactions yet for ${activeAccount.name}` : "No transactions yet",
			description: "Import a bank or broker CSV/Excel export to populate the ledger.",
			actionLabel: "Import transactions",
			onAction: () => openImportWizard(plugin),
		});
		// A cash account will never have an export — manual entry is its only door in, so it has to
		// be offered right here, not hidden behind a filter bar that only renders once rows exist.
		const manual = empty.createEl("button", { cls: "fp-btn fp-btn--ghost", attr: { type: "button" } });
		icon(manual, "plus");
		manual.createSpan({ text: "Add one manually" });
		manual.addEventListener("click", () => new AddTransactionModal(plugin.app, plugin).open());
		return;
	}

	const categoryById = new Map(store.categories.map((c) => [c.id, c]));
	const accountById = new Map(store.accounts.map((a) => [a.id, a]));
	const showAccountColumn = !activeAccountId;
	const totalsCurrency = portfolioCurrency(store);
	let visibleCount = PAGE_SIZE;

	/* ---------- filter bar (design §2.3.6: one row, above everything it scopes) ---------- */

	const bar = container.createDiv({ cls: "fp-filterbar" });

	const search = bar.createEl("input", {
		type: "search",
		cls: "fp-input fp-filterbar-search",
		attr: { placeholder: "Search description or counterparty…", "aria-label": "Search transactions" },
	});
	search.value = filterState.search;

	let accountSelect: HTMLSelectElement | undefined;
	if (showAccountColumn) {
		accountSelect = bar.createEl("select", { cls: "fp-select", attr: { "aria-label": "Filter by account" } });
		accountSelect.createEl("option", { text: "All accounts", value: "" });
		store.accounts.forEach((a) => accountSelect!.createEl("option", { text: a.name, value: a.id }));
		accountSelect.value = accountById.has(filterState.accountId) ? filterState.accountId : "";
	}

	const categorySelect = bar.createEl("select", { cls: "fp-select", attr: { "aria-label": "Filter by category" } });
	categorySelect.createEl("option", { text: "All categories", value: "" });
	categorySelect.createEl("option", { text: "Uncategorized", value: UNCATEGORIZED });
	store.categories.forEach((c) => categorySelect.createEl("option", { text: c.name, value: c.id }));
	categorySelect.value = filterState.categoryId === UNCATEGORIZED || categoryById.has(filterState.categoryId) ? filterState.categoryId : "";

	const presetSelect = bar.createEl("select", { cls: "fp-select", attr: { "aria-label": "Filter by date range" } });
	(Object.keys(PRESET_LABEL) as LedgerDatePreset[]).forEach((p) => presetSelect.createEl("option", { text: PRESET_LABEL[p], value: p }));
	presetSelect.value = filterState.preset;

	// Two bare date inputs are a poor default; they only appear once the user asks for a custom window.
	const customWrap = bar.createDiv({ cls: "fp-daterange-custom-inline" });
	const dateFrom = customWrap.createEl("input", { type: "date", cls: "fp-input", attr: { "aria-label": "From date" } });
	dateFrom.value = filterState.dateFrom;
	customWrap.createSpan({ cls: "fp-filter-date-sep", text: "→" });
	const dateTo = customWrap.createEl("input", { type: "date", cls: "fp-input", attr: { "aria-label": "To date" } });
	dateTo.value = filterState.dateTo;

	// Period picker: shown only for the four "pick a specific one" presets. Year/quarter get prev/next
	// arrows around a computed label (there's no native input for either); month/week use the browser's
	// own <input type="month"|"week"> — Obsidian runs on Chromium, which supports both natively — plus
	// the same prev/next arrows for quick browsing, matching the ◀ month ▶ pattern used elsewhere in the app.
	const periodWrap = bar.createDiv({ cls: "fp-period-picker" });
	const periodPrev = periodWrap.createEl("button", { cls: "fp-btn fp-btn--ghost fp-btn--icon", attr: { type: "button", "aria-label": "Previous period" } });
	icon(periodPrev, "chevron-left");
	const periodLabelEl = periodWrap.createSpan({ cls: "fp-period-picker-label" });
	const periodMonthInput = periodWrap.createEl("input", { type: "month", cls: "fp-input fp-period-picker-input", attr: { "aria-label": "Pick a month" } });
	const periodWeekInput = periodWrap.createEl("input", { type: "week", cls: "fp-input fp-period-picker-input", attr: { "aria-label": "Pick a week" } });
	const periodNext = periodWrap.createEl("button", { cls: "fp-btn fp-btn--ghost fp-btn--icon", attr: { type: "button", "aria-label": "Next period" } });
	icon(periodNext, "chevron-right");

	const stats = bar.createDiv({ cls: "fp-filterbar-stats" });

	// Manual entry lives where the rows live — commanding "add-transaction" from the palette works
	// too, but the ledger is where you notice something is missing.
	const addBtn = bar.createEl("button", {
		cls: "fp-btn fp-btn--secondary fp-filterbar-add",
		attr: { type: "button", "aria-label": "Add transaction manually" },
	});
	icon(addBtn, "plus");
	addBtn.createSpan({ text: "Add" });
	addBtn.addEventListener("click", () => {
		new AddTransactionModal(plugin.app, plugin).open();
	});

	const chips = bar.createDiv({ cls: "fp-filterbar-chips" });

	/* ---------- table ---------- */

	const tableCard = container.createDiv({ cls: "fp-card fp-card--flush fp-ledger-table-wrap fp-table-scroll" });
	const table = tableCard.createEl("table", { cls: "fp-table fp-ledger-table" });
	const thead = table.createEl("thead").createEl("tr");

	const columns: { id: LedgerSortColumn; label: string; num?: boolean }[] = [
		{ id: "date", label: "Date" },
		{ id: "description", label: "Description" },
		...(showAccountColumn ? ([{ id: "account", label: "Account" }] as { id: LedgerSortColumn; label: string }[]) : []),
		{ id: "category", label: "Category" },
		{ id: "amount", label: "Amount", num: true },
	];

	const headerCells = new Map<LedgerSortColumn, HTMLElement>();
	const sortIndicators = new Map<LedgerSortColumn, HTMLElement>();
	function updateSortIndicators(): void {
		columns.forEach((col) => {
			const th = headerCells.get(col.id);
			const active = sortState.column === col.id;
			th?.setAttribute("aria-sort", active ? (sortState.direction === "asc" ? "ascending" : "descending") : "none");
			const indicator = sortIndicators.get(col.id);
			if (!indicator) return;
			indicator.empty();
			if (active) icon(indicator, sortState.direction === "asc" ? "chevron-up" : "chevron-down", "fp-th-sort-icon");
		});
	}
	columns.forEach((col) => {
		const th = thead.createEl("th", {
			cls: "fp-th-sort" + (col.num ? " fp-table-num" : ""),
			attr: { "aria-sort": "none", scope: "col" },
		});
		// A real <button>, so sorting is focusable, announced and keyboard-operable.
		const btn = th.createEl("button", { cls: "fp-th-sort-btn", text: col.label, attr: { type: "button" } });
		const indicator = btn.createSpan({ cls: "fp-th-sort-indicator" });
		headerCells.set(col.id, th);
		sortIndicators.set(col.id, indicator);
		btn.addEventListener("click", () => {
			if (sortState.column === col.id) sortState.direction = sortState.direction === "asc" ? "desc" : "asc";
			else {
				sortState.column = col.id;
				sortState.direction = DEFAULT_SORT_DIRECTION[col.id];
			}
			updateSortIndicators();
			draw();
		});
	});
	updateSortIndicators();

	const tbody = table.createEl("tbody");
	const footer = container.createDiv({ cls: "fp-ledger-footer" });

	function compareTransactions(a: Transaction, b: Transaction): number {
		const dir = sortState.direction === "asc" ? 1 : -1;
		switch (sortState.column) {
			case "description":
				return dir * a.description.localeCompare(b.description);
			case "account":
				return dir * (accountById.get(a.accountId)?.name ?? "").localeCompare(accountById.get(b.accountId)?.name ?? "");
			case "category": {
				const an = a.categoryId ? categoryById.get(a.categoryId)?.name ?? "" : "";
				const bn = b.categoryId ? categoryById.get(b.categoryId)?.name ?? "" : "";
				return dir * an.localeCompare(bn);
			}
			case "amount":
				return dir * (a.amount - b.amount);
			case "date":
			default:
				return dir * (a.date > b.date ? 1 : a.date < b.date ? -1 : 0);
		}
	}

	function appendRow(t: Transaction): void {
		const tr = tbody.createEl("tr", { cls: "fp-ledger-row", attr: { tabindex: "0" } });
		const open = () => new TransactionDetailModal(plugin.app, plugin, t).open();
		tr.addEventListener("click", open);
		tr.addEventListener("keydown", (ev: KeyboardEvent) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				open();
				return;
			}
			if (ev.key !== "ArrowDown" && ev.key !== "ArrowUp") return;
			ev.preventDefault();
			const sibling = ev.key === "ArrowDown" ? tr.nextElementSibling : tr.previousElementSibling;
			(sibling as HTMLElement | null)?.focus?.();
		});

		tr.createEl("td", { text: t.date, cls: "fp-cell-date" });
		tr.createEl("td", { text: t.description, cls: "fp-sensitive" });
		if (showAccountColumn) tr.createEl("td", { text: accountById.get(t.accountId)?.name ?? "—" });
		const catCell = tr.createEl("td");
		const cat = t.categoryId ? categoryById.get(t.categoryId) : undefined;
		if (cat) categoryChip(catCell, cat.name, cat.color, cat.icon);
		else badge(catCell, "Uncategorized", "warn");
		// Outgoings stay in normal ink — the minus sign already says "out". Only income is colored.
		tr.createEl("td", {
			cls: "fp-amount fp-money" + (t.amount > 0 ? " fp-amount--in" : ""),
			text: money(t.amount, t.currency || totalsCurrency, 2),
		});
	}

	/* ---------- active-filter chips ---------- */

	function addChip(label: string, onClear: () => void): void {
		const chip = chips.createDiv({ cls: "fp-filter-chip" });
		chip.createSpan({ cls: "fp-filter-chip-label", text: label });
		const clear = chip.createEl("button", { cls: "fp-filter-chip-clear", attr: { type: "button", "aria-label": `Remove filter: ${label}` } });
		icon(clear, "x");
		clear.addEventListener("click", onClear);
	}

	function renderChips(): void {
		chips.empty();
		let any = false;
		if (filterState.search) {
			any = true;
			addChip(`Search: ${filterState.search}`, () => {
				search.value = "";
				draw();
			});
		}
		if (accountSelect && filterState.accountId) {
			any = true;
			addChip(`Account: ${accountById.get(filterState.accountId)?.name ?? filterState.accountId}`, () => {
				accountSelect!.value = "";
				draw();
			});
		}
		if (filterState.categoryId) {
			const name = filterState.categoryId === UNCATEGORIZED ? "Uncategorized" : categoryById.get(filterState.categoryId)?.name ?? filterState.categoryId;
			any = true;
			addChip(`Category: ${name}`, () => {
				categorySelect.value = "";
				draw();
			});
		}
		if (filterState.dateFrom || filterState.dateTo) {
			any = true;
			const label =
				filterState.preset === "custom"
					? `${filterState.dateFrom || "…"} → ${filterState.dateTo || "…"}`
					: PERIOD_PRESETS.includes(filterState.preset)
					? periodLabel(filterState.preset, filterState.periodValue)
					: PRESET_LABEL[filterState.preset];
			addChip(label, () => {
				presetSelect.value = "all";
				filterState.periodValue = "";
				dateFrom.value = "";
				dateTo.value = "";
				draw();
			});
		}
		if (!any) return;
		const clearAll = chips.createEl("button", { cls: "fp-btn fp-btn--ghost fp-filter-clear-all", text: "Clear all", attr: { type: "button" } });
		clearAll.addEventListener("click", () => {
			search.value = "";
			if (accountSelect) accountSelect.value = "";
			categorySelect.value = "";
			presetSelect.value = "all";
			filterState.periodValue = "";
			dateFrom.value = "";
			dateTo.value = "";
			draw();
		});
	}

	/* ---------- draw ---------- */

	function draw(): void {
		tbody.empty();
		footer.empty();

		const preset = presetSelect.value as LedgerDatePreset;
		const isPeriodPreset = PERIOD_PRESETS.includes(preset);

		if (isPeriodPreset && !filterState.periodValue) {
			filterState.periodValue = defaultPeriodValue(preset);
		}
		const range = presetRange(preset, filterState.periodValue);
		if (range) {
			dateFrom.value = range.from;
			dateTo.value = range.to;
		} else if (preset === "all") {
			dateFrom.value = "";
			dateTo.value = "";
		}
		customWrap.toggleClass("is-hidden", preset !== "custom");
		periodWrap.toggleClass("is-hidden", !isPeriodPreset);
		periodMonthInput.toggleClass("is-hidden", preset !== "month");
		periodWeekInput.toggleClass("is-hidden", preset !== "week");
		periodLabelEl.toggleClass("is-hidden", preset === "month" || preset === "week");
		if (isPeriodPreset) {
			periodLabelEl.setText(periodLabel(preset, filterState.periodValue));
			if (preset === "month") periodMonthInput.value = filterState.periodValue;
			if (preset === "week") periodWeekInput.value = filterState.periodValue;
		}

		filterState.search = search.value;
		filterState.accountId = accountSelect ? accountSelect.value : "";
		filterState.categoryId = categorySelect.value;
		filterState.dateFrom = dateFrom.value;
		filterState.dateTo = dateTo.value;
		filterState.preset = preset;

		const needle = filterState.search.toLowerCase();
		const { accountId: accountFilter, categoryId: categoryFilter, dateFrom: from, dateTo: to } = filterState;

		const filtered = scopedTransactions
			.filter((t) => !needle || `${t.description} ${t.counterparty ?? ""}`.toLowerCase().includes(needle))
			.filter((t) => !accountFilter || t.accountId === accountFilter)
			.filter((t) => {
				if (!categoryFilter) return true;
				if (categoryFilter === UNCATEGORIZED) return !t.categoryId;
				return t.categoryId === categoryFilter;
			})
			.filter((t) => !from || t.date >= from)
			.filter((t) => !to || t.date <= to)
			.sort(compareTransactions);

		const total = filtered.reduce((sum, t) => sum + t.amount, 0);
		stats.empty();
		stats.createSpan({ text: `${filtered.length.toLocaleString("en-IE")} of ${scopedTransactions.length.toLocaleString("en-IE")} transactions · ` });
		stats.createSpan({ cls: "fp-money", text: money(total, totalsCurrency, 2) });

		// Seeing the uncategorized count is what starts the review habit; hiding it behind a
		// <select> is why nobody ever did.
		const uncategorized = scopedTransactions.filter((t) => !t.categoryId).length;
		if (uncategorized > 0 && categoryFilter !== UNCATEGORIZED) {
			const chip = stats.createEl("button", {
				cls: "fp-uncat-chip",
				attr: { type: "button", title: "Show only uncategorized transactions" },
			});
			icon(chip, "alert-triangle");
			chip.createSpan({ text: `Uncategorized (${uncategorized})` });
			chip.addEventListener("click", () => {
				categorySelect.value = UNCATEGORIZED;
				draw();
			});
		}

		renderChips();

		if (filtered.length === 0) {
			const tr = tbody.createEl("tr");
			const cell = tr.createEl("td", { attr: { colspan: String(columns.length) } });
			emptyState(cell, {
				variant: "row",
				iconName: "search-x",
				title: "No matching transactions",
				description: "Nothing in this account matches the current filters.",
				actionLabel: "Clear filters",
				onAction: () => {
					search.value = "";
					if (accountSelect) accountSelect.value = "";
					categorySelect.value = "";
					presetSelect.value = "all";
					filterState.periodValue = "";
					dateFrom.value = "";
					dateTo.value = "";
					draw();
				},
			});
			return;
		}

		const shown = Math.min(visibleCount, filtered.length);
		filtered.slice(0, shown).forEach(appendRow);

		// The old `slice(0, 200)` was silent, so a user with 1,400 transactions believed they had 200.
		footer.createSpan({
			cls: "fp-ledger-footer-count",
			text: `Showing ${shown.toLocaleString("en-IE")} of ${filtered.length.toLocaleString("en-IE")}`,
		});
		if (shown < filtered.length) {
			const more = footer.createEl("button", { cls: "fp-btn fp-btn--secondary", text: "Load more", attr: { type: "button" } });
			more.addEventListener("click", () => {
				visibleCount += PAGE_SIZE;
				draw();
			});
		}
	}

	draw();
	search.addEventListener("input", () => {
		visibleCount = PAGE_SIZE;
		draw();
	});
	const resetAndDraw = () => {
		visibleCount = PAGE_SIZE;
		draw();
	};
	accountSelect?.addEventListener("change", resetAndDraw);
	categorySelect.addEventListener("change", resetAndDraw);
	presetSelect.addEventListener("change", () => {
		// A stale periodValue from a different preset kind ("2025-07" left over from Month while
		// switching to Year) would format-mismatch — clearing it lets draw() compute a fresh default.
		filterState.periodValue = "";
		resetAndDraw();
	});
	dateFrom.addEventListener("change", () => {
		presetSelect.value = "custom";
		resetAndDraw();
	});
	dateTo.addEventListener("change", () => {
		presetSelect.value = "custom";
		resetAndDraw();
	});

	function shiftPeriod(delta: number): void {
		const preset = presetSelect.value as LedgerDatePreset;
		const v = filterState.periodValue;
		filterState.periodValue =
			preset === "year"
				? String(Number(v) + delta)
				: preset === "quarter"
				? shiftQuarter(v, delta)
				: preset === "month"
				? shiftMonth(v, delta)
				: preset === "week"
				? shiftIsoWeek(v, delta)
				: v;
		resetAndDraw();
	}
	periodPrev.addEventListener("click", () => shiftPeriod(-1));
	periodNext.addEventListener("click", () => shiftPeriod(1));
	periodMonthInput.addEventListener("change", () => {
		if (periodMonthInput.value) filterState.periodValue = periodMonthInput.value;
		resetAndDraw();
	});
	periodWeekInput.addEventListener("change", () => {
		if (periodWeekInput.value) filterState.periodValue = periodWeekInput.value;
		resetAndDraw();
	});
}
