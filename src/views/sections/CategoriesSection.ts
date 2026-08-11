import { firstDayOf, lastDayOf, monthOf, shiftMonth, todayIso } from "../../kpi";
import type FinancePlugin from "../../main";
import { openCategoryManager } from "../../modals/CategoryManagerModal";
import { TransactionDetailModal } from "../../modals/TransactionDetailModal";
import { buildUserRule, deriveRulePattern, groupByMerchant, ruleReach, type MerchantGroup } from "../../reviewQueue";
import type { Transaction } from "../../types";
import { badge, categoryChip, emptyState, fillCategorySelect, icon } from "../../ui/dom";
import { openImportWizard } from "../../wizards/ImportWizard";
import { money, portfolioCurrency } from "./shared";

/** The sentinel the category `<select>`s use for "clear this category". */
const CLEAR = "__clear";
/** The sentinel the *filter* uses for "only rows with no category at all". */
const FILTER_UNCATEGORIZED = "__uncategorized";
/** How many groups/rows one page shows before "Load more" — 800 merchant groups at once is a
 *  scroll nobody finishes, and rendering them all costs a visible pause on a 3,000-row ledger. */
const PAGE_SIZE = 100;

type Grouping = "merchant" | "transaction";
type PeriodKey = "all" | "this-year" | "last-3-months" | string;

interface Period {
	key: PeriodKey;
	label: string;
	from?: string;
	to?: string;
}

function buildPeriods(years: string[], today: Date): Period[] {
	const now = todayIso(today);
	const month = monthOf(now);
	const year = now.slice(0, 4);
	const periods: Period[] = [
		{ key: "all", label: "All time" },
		{ key: "this-year", label: `This year (${year})`, from: `${year}-01-01`, to: `${year}-12-31` },
		{ key: "last-3-months", label: "Last 3 months", from: firstDayOf(shiftMonth(month, -2)), to: lastDayOf(month) },
	];
	years
		.filter((y) => y !== year)
		.sort((a, b) => b.localeCompare(a))
		.forEach((y) => periods.push({ key: y, label: y, from: `${y}-01-01`, to: `${y}-12-31` }));
	return periods;
}

/**
 * The category workbench: every transaction in the portfolio, filterable, with the category editable
 * in place — no modal, no losing your scroll position.
 *
 * Grouped by merchant is the default and the whole point. A ledger of 3,000 rows is 3,000 decisions;
 * the same ledger grouped by who was actually paid is a few hundred, and fixing "Oracle Utrecht" once
 * fixes all nine of its rows. The review queue already worked this way but only ever showed
 * *uncategorized* rows — the thing you cannot do there is correct a category that is merely wrong.
 */
export function renderCategoriesSection(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;
	container.addClass("fp-section");
	const root = container.createDiv();

	const header = root.createDiv({ cls: "fp-page-head" });
	const headMain = header.createDiv({ cls: "fp-page-head-main" });
	headMain.createEl("h2", { cls: "fp-page-title", text: "Categories" });
	headMain.createDiv({ cls: "fp-page-sub", text: "Every transaction, grouped by who you paid. Change a category here and it applies to the whole group." });
	const manageBtn = header.createEl("button", {
		cls: "fp-btn fp-btn--secondary",
		attr: { type: "button", title: "Add, rename, recolour or retire the categories themselves" },
	});
	icon(manageBtn, "settings");
	manageBtn.createSpan({ text: "Manage categories" });
	// No callback needed: the manager persists via `refreshViews()`, which rebuilds this whole
	// section from the store — including when the ledger is empty and the code below never ran.
	manageBtn.addEventListener("click", () => openCategoryManager(plugin));

	if (store.transactions.length === 0) {
		emptyState(root, {
			iconName: "inbox",
			title: "No transactions yet",
			description: "Import a bank or broker export and its merchants will show up here for review.",
			actionLabel: "Import transactions",
			onAction: () => openImportWizard(plugin),
		});
		return;
	}

	const today = new Date();
	const years = Array.from(new Set(store.transactions.map((t) => t.date?.slice(0, 4)).filter((y): y is string => !!y)));
	const periods = buildPeriods(years, today);
	const categoryById = new Map(store.categories.map((c) => [c.id, c]));
	const accountById = new Map(store.accounts.map((a) => [a.id, a]));
	const currency = portfolioCurrency(store);

	/* ---------- filter bar ---------- */

	const bar = root.createDiv({ cls: "fp-filterbar" });

	const search = bar.createEl("input", {
		type: "search",
		cls: "fp-input fp-filterbar-search",
		attr: { placeholder: "Search merchant or description…", "aria-label": "Search" },
	});

	const accountSelect = bar.createEl("select", { cls: "fp-select", attr: { "aria-label": "Filter by account" } });
	accountSelect.createEl("option", { text: "All accounts", value: "" });
	store.accounts.forEach((a) => accountSelect.createEl("option", { text: a.name, value: a.id }));

	const categorySelect = bar.createEl("select", { cls: "fp-select", attr: { "aria-label": "Filter by category" } });
	categorySelect.createEl("option", { text: "All categories", value: "" });
	categorySelect.createEl("option", { text: "Uncategorized only", value: FILTER_UNCATEGORIZED });
	fillCategorySelect(categorySelect, store.categories);

	const periodSelect = bar.createEl("select", { cls: "fp-select", attr: { "aria-label": "Filter by period" } });
	periods.forEach((p) => periodSelect.createEl("option", { text: p.label, value: p.key }));

	const groupingToggle = bar.createDiv({ cls: "fp-pill-toggle", attr: { role: "group", "aria-label": "Grouping" } });
	let grouping: Grouping = "merchant";

	const stats = bar.createDiv({ cls: "fp-filterbar-stats" });

	const list = root.createDiv({ cls: "fp-cat-review" });
	const footer = root.createDiv({ cls: "fp-ledger-footer" });

	let visibleCount = PAGE_SIZE;

	/* ---------- data ---------- */

	function scoped(): Transaction[] {
		const needle = search.value.trim().toLowerCase();
		const accountId = accountSelect.value;
		const categoryId = categorySelect.value;
		const period = periods.find((p) => p.key === periodSelect.value) ?? periods[0];

		return store.transactions.filter((t) => {
			if (accountId && t.accountId !== accountId) return false;
			if (categoryId === FILTER_UNCATEGORIZED ? !!t.categoryId : categoryId && t.categoryId !== categoryId) return false;
			if (period.from && (!t.date || t.date < period.from)) return false;
			if (period.to && (!t.date || t.date > period.to)) return false;
			if (needle && !`${t.description} ${t.counterparty ?? ""}`.toLowerCase().includes(needle)) return false;
			return true;
		});
	}

	/**
	 * Applies one category to a whole set of transactions in a single batched ledger write.
	 *
	 * Deliberately does NOT call `plugin.refreshViews()`: that re-enters `renderBody()`, which rebuilds
	 * this section from scratch and throws away every piece of local state — your search text, the
	 * grouping toggle, how far you'd scrolled, which merchants you'd expanded. In a surface whose whole
	 * job is making twenty changes in a row, that's the difference between a workbench and a treadmill.
	 * The dashboards rebuild from the store the moment you navigate to one, so they can't go stale.
	 *
	 * Scroll position is captured and restored around the re-render for the same reason — the list
	 * re-sorts nothing on assign (merchant order is by transaction count), so the row you just edited
	 * is exactly where you left it.
	 */
	async function assign(transactions: Transaction[], categoryId: string | undefined): Promise<void> {
		const patches = new Map<string, string | undefined>();
		transactions.forEach((t) => patches.set(t.id, categoryId));
		await store.recategorize(patches);
		if (!root.isConnected) return;
		const scroller = root.closest<HTMLElement>(".fp-content");
		const scrollTop = scroller?.scrollTop ?? 0;
		render();
		if (scroller) scroller.scrollTop = scrollTop;
	}

	/* ---------- rendering ---------- */

	function categoryPicker(parent: HTMLElement, currentId: string | undefined, onPick: (id: string | undefined) => void): HTMLSelectElement {
		const select = parent.createEl("select", { cls: "fp-select fp-select--sm fp-cat-review-picker", attr: { "aria-label": "Category" } });
		select.createEl("option", { text: "— Uncategorized —", value: CLEAR });
		fillCategorySelect(select, store.categories);
		select.value = currentId ?? CLEAR;
		select.addEventListener("change", () => onPick(select.value === CLEAR ? undefined : select.value));
		return select;
	}

	function renderMerchantRow(group: MerchantGroup): void {
		const ids = new Set(group.transactions.map((t) => t.categoryId ?? ""));
		const mixed = ids.size > 1;
		const currentId = mixed ? undefined : group.transactions[0]?.categoryId;

		const row = list.createDiv({ cls: "fp-cat-review-row" });

		const main = row.createDiv({ cls: "fp-cat-review-main" });
		const nameLine = main.createDiv({ cls: "fp-cat-review-name" });
		nameLine.createSpan({ cls: "fp-sensitive", text: group.displayName });
		if (mixed) badge(nameLine, "Mixed", "warn");
		else if (!currentId) badge(nameLine, "Uncategorized", "warn");

		const meta = main.createDiv({ cls: "fp-cat-review-meta" });
		meta.createSpan({ text: `${group.transactions.length} transaction${group.transactions.length === 1 ? "" : "s"}` });
		meta.createSpan({ text: " · " });
		meta.createSpan({ cls: "fp-money", text: money(group.total, currency) });
		meta.createSpan({ text: ` · ${group.firstSeen} → ${group.lastSeen}` });

		const actions = row.createDiv({ cls: "fp-cat-review-actions" });
		const picker = categoryPicker(actions, currentId, (id) => {
			void (async () => {
				await assign(group.transactions, id);
			})();
		});
		if (mixed) picker.value = CLEAR;

		// "Remember" only makes sense once a category is set and the merchant text is actually
		// matchable — deriveRulePattern refuses to invent a pattern it can't prove would fire.
		const pattern = deriveRulePattern(group.transactions);
		if (pattern && currentId) {
			const already = store.rules.some((r) => r.pattern.toLowerCase() === pattern.toLowerCase());
			if (!already) {
				const remember = actions.createEl("button", {
					cls: "fp-btn fp-btn--ghost fp-btn--icon",
					attr: { type: "button", "aria-label": `Always categorize ${group.displayName} this way`, title: `Always categorize "${pattern}" as this category on future imports` },
				});
				icon(remember, "bookmark-plus");
				remember.addEventListener("click", () => {
					void (async () => {
						store.rules.push(buildUserRule(pattern, currentId));
						await store.saveRules();
						const reach = ruleReach(pattern, store.transactions);
						remember.replaceChildren();
						icon(remember, "check");
						remember.setAttribute("title", `Rule saved — matches ${reach} transaction${reach === 1 ? "" : "s"}`);
						remember.toggleClass("is-active", true);
					})();
				});
			}
		}

		const expand = actions.createEl("button", {
			cls: "fp-btn fp-btn--ghost fp-btn--icon",
			attr: { type: "button", "aria-expanded": "false", "aria-label": `Show ${group.displayName}'s transactions` },
		});
		icon(expand, "chevron-down");
		const detail = row.createDiv({ cls: "fp-cat-review-detail is-hidden" });
		expand.addEventListener("click", () => {
			const open = detail.hasClass("is-hidden");
			detail.toggleClass("is-hidden", !open);
			expand.setAttribute("aria-expanded", String(open));
			if (open && detail.childElementCount === 0) {
				group.transactions
					.slice()
					.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""))
					.forEach((t) => renderTransactionLine(detail, t, { compact: true }));
			}
		});
	}

	function renderTransactionLine(parent: HTMLElement, t: Transaction, opts: { compact?: boolean } = {}): void {
		const row = parent.createDiv({ cls: "fp-cat-review-row" + (opts.compact ? " fp-cat-review-row--compact" : "") });

		const main = row.createDiv({ cls: "fp-cat-review-main" });
		const nameLine = main.createDiv({ cls: "fp-cat-review-name" });
		nameLine.createSpan({ cls: "fp-sensitive", text: t.description });

		const meta = main.createDiv({ cls: "fp-cat-review-meta" });
		meta.createSpan({ text: t.date });
		meta.createSpan({ text: " · " });
		meta.createSpan({ cls: "fp-money", text: money(t.amount, t.currency || currency, 2) });
		if (!opts.compact) {
			const acc = accountById.get(t.accountId);
			if (acc) meta.createSpan({ text: ` · ${acc.name}` });
		}

		const actions = row.createDiv({ cls: "fp-cat-review-actions" });
		if (!opts.compact) {
			const cat = t.categoryId ? categoryById.get(t.categoryId) : undefined;
			if (cat) categoryChip(actions, cat.name, cat.color, cat.icon);
		}
		categoryPicker(actions, t.categoryId, (id) => void assign([t], id));

		const open = actions.createEl("button", {
			cls: "fp-btn fp-btn--ghost fp-btn--icon",
			attr: { type: "button", "aria-label": "Open transaction", title: "Open full details" },
		});
		icon(open, "maximize-2");
		open.addEventListener("click", () => new TransactionDetailModal(plugin.app, plugin, t).open());
	}

	function render(): void {
		list.empty();
		footer.empty();
		stats.empty();

		const transactions = scoped();
		const uncategorized = transactions.filter((t) => !t.categoryId).length;

		stats.createSpan({ text: `${transactions.length.toLocaleString("en-IE")} transaction${transactions.length === 1 ? "" : "s"}` });
		if (uncategorized > 0) {
			stats.createSpan({ text: " · " });
			stats.createSpan({ cls: "fp-cat-review-uncat", text: `${uncategorized.toLocaleString("en-IE")} uncategorized` });
		}

		if (transactions.length === 0) {
			emptyState(list, {
				variant: "inline",
				iconName: "search-x",
				title: "Nothing matches these filters",
				description: "Widen the period, clear the category filter, or search for something else.",
			});
			return;
		}

		if (grouping === "merchant") {
			const groups = groupByMerchant(transactions);
			// Rows whose merchant text normalizes to nothing are dropped by groupByMerchant — surface
			// them rather than letting them silently vanish from a review surface that claims to show
			// everything.
			const grouped = new Set(groups.flatMap((g) => g.transactions.map((t) => t.id)));
			const ungroupable = transactions.filter((t) => !grouped.has(t.id));

			const shown = groups.slice(0, visibleCount);
			shown.forEach(renderMerchantRow);

			if (ungroupable.length > 0 && shown.length === groups.length) {
				list.createDiv({ cls: "fp-cat-review-divider", text: `${ungroupable.length} transaction${ungroupable.length === 1 ? "" : "s"} with no recognisable merchant name` });
				ungroupable.slice(0, PAGE_SIZE).forEach((t) => renderTransactionLine(list, t));
			}

			renderFooter(shown.length, groups.length, "merchant");
		} else {
			const sorted = transactions.slice().sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
			const shown = sorted.slice(0, visibleCount);
			shown.forEach((t) => renderTransactionLine(list, t));
			renderFooter(shown.length, sorted.length, "transaction");
		}
	}

	function renderFooter(shown: number, total: number, unit: string): void {
		footer.createSpan({
			cls: "fp-ledger-footer-count",
			text: `Showing ${shown.toLocaleString("en-IE")} of ${total.toLocaleString("en-IE")} ${unit}${total === 1 ? "" : "s"}`,
		});
		if (shown < total) {
			const more = footer.createEl("button", { cls: "fp-btn fp-btn--secondary", text: "Load more", attr: { type: "button" } });
			more.addEventListener("click", () => {
				visibleCount += PAGE_SIZE;
				render();
			});
		}
	}

	/* ---------- grouping pills ---------- */

	const syncGrouping = () => {
		groupingToggle.querySelectorAll("button").forEach((b) => {
			const isActive = b.getAttribute("data-key") === grouping;
			b.toggleClass("is-active", isActive);
			b.setAttribute("aria-pressed", String(isActive));
		});
	};
	([
		["merchant", "By merchant"],
		["transaction", "Every transaction"],
	] as const).forEach(([key, label]) => {
		const btn = groupingToggle.createEl("button", { text: label, attr: { type: "button", "data-key": key } });
		btn.addEventListener("click", () => {
			if (grouping === key) return;
			grouping = key;
			visibleCount = PAGE_SIZE;
			syncGrouping();
			render();
		});
	});
	syncGrouping();

	const resetAndRender = () => {
		visibleCount = PAGE_SIZE;
		render();
	};
	search.addEventListener("input", resetAndRender);
	accountSelect.addEventListener("change", resetAndRender);
	categorySelect.addEventListener("change", resetAndRender);
	periodSelect.addEventListener("change", resetAndRender);

	render();
}
