import { elapsedFraction } from "../../budgets";
import {
	categorySpend,
	firstDayOf,
	lastDayOf,
	monthOf,
	rollUpCategorySpend,
	shiftMonth,
	todayIso,
	topLevelCategories,
	type SpendWindow,
} from "../../kpi";
import type FinancePlugin from "../../main";
import { icon } from "../../ui/dom";
import { goToLedger, UNCATEGORIZED } from "./LedgerSection";
import { cardHead, money, portfolioCurrency, signedMoney } from "./shared";

/** The trailing window the current month's "is this normal?" comparison is made against. */
const COMPARISON_MONTHS = 3;

/** `categorySpend`'s own bucket key for uncategorized transactions (kpi.ts) — deliberately NOT the
 *  same string as `UNCATEGORIZED` from LedgerSection, which is that module's own filter-dropdown
 *  sentinel ("__uncategorized"). The two only meet at the goToLedger call below, which translates
 *  one into the other on purpose. */
const UNCAT_KEY = "uncategorized";

/** Categories that structurally can never carry spend here, so listing them is just permanent
 *  noise, not "quiet". `categorySpend` (kpi.ts) only sums negative amounts that aren't a transfer:
 *  "Transfers" and "Savings" are excluded unconditionally by name via `isTransfer`'s own
 *  TRANSFER_CATEGORY_NAMES check, and "Income" transactions are essentially always positive-amount
 *  and so excluded by the `tx.amount >= 0` guard before categorization is even consulted. (The one
 *  edge case this hides — a negative-amount row someone deliberately categorized "Income", e.g. a
 *  clawback — is rare enough, and conceptually odd enough for a *spending* card, that it isn't worth
 *  the other 99% of the time showing three permanent zero rows that can never mean anything.) */
const NON_SPEND_CATEGORY_NAMES = new Set(["income", "transfers", "savings", "savings & transfers"]);

export interface CategoryFlowOpts {
	accountIds?: string[];
	title?: string;
	limit?: number;
	today?: Date;
}

interface PeriodOption {
	key: string;
	label: string;
	/** What `categorySpend` is asked for — `undefined` means every transaction, no date filter. */
	window?: SpendWindow;
	/** Inclusive bounds, for the ledger deep-link when a row is clicked. */
	range: { from: string; to: string };
	/** Only an in-progress period gets pace-adjusted deltas against a trailing average — comparing a
	 *  finished year to "your 3-month average" would be meaningless. */
	compare: boolean;
	sub: string;
}

/** The periods the card can show, newest first: the live month, two rolling windows, then every
 *  calendar year the data actually covers, then everything. */
function buildPeriods(years: string[], today: Date): PeriodOption[] {
	const now = todayIso(today);
	const month = monthOf(now);
	const year = now.slice(0, 4);

	const periods: PeriodOption[] = [
		{
			key: "this-month",
			label: "This month",
			window: month,
			range: { from: firstDayOf(month), to: lastDayOf(month) },
			compare: true,
			sub: `This month so far, against your ${COMPARISON_MONTHS}-month average`,
		},
		{
			key: "last-3-months",
			label: "Last 3 months",
			window: { from: firstDayOf(shiftMonth(month, -2)), to: lastDayOf(month) },
			range: { from: firstDayOf(shiftMonth(month, -2)), to: lastDayOf(month) },
			compare: false,
			sub: "The last three months, including this one",
		},
		{
			key: "this-year",
			label: "This year",
			window: year,
			range: { from: `${year}-01-01`, to: `${year}-12-31` },
			compare: false,
			sub: `${year} so far`,
		},
	];

	// Past calendar years, newest first. "This year" already covers the current one.
	years
		.filter((y) => y !== year)
		.sort((a, b) => b.localeCompare(a))
		.forEach((y) =>
			periods.push({
				key: y,
				label: y,
				window: y,
				range: { from: `${y}-01-01`, to: `${y}-12-31` },
				compare: false,
				sub: `All of ${y}`,
			})
		);

	periods.push({
		key: "all",
		label: "All time",
		range: { from: "", to: "" },
		compare: false,
		sub: "Every transaction on record",
	});

	return periods;
}

/**
 * Spending by category over a chosen period, defaulting to the current month with each bar carrying
 * a ghost tick at its trailing three-month mean and a chip saying how far off pace it is.
 *
 * The period picker is the point: locked to the current month, this card reads as broken for the
 * first week of every month — eleven days of data across four categories looks like a categorization
 * failure rather than a quiet fortnight. Any year, the last three months, or all time answers
 * "where does my money actually go" in a way one in-progress month never can.
 */
export function renderCategoryFlowCard(container: HTMLElement, plugin: FinancePlugin, opts: CategoryFlowOpts = {}): void {
	const store = plugin.store;
	const today = opts.today ?? new Date();
	const currency = portfolioCurrency(store);
	const month = monthOf(todayIso(today));
	// Never 0: on the 1st this is 1/31, so an early-month pace is large but finite.
	const elapsed = Math.max(0.01, elapsedFraction(month, today));

	const scoped = opts.accountIds
		? store.transactions.filter((t) => opts.accountIds!.includes(t.accountId))
		: store.transactions;
	const years = Array.from(new Set(scoped.map((t) => t.date?.slice(0, 4)).filter((y): y is string => !!y)));
	const periods = buildPeriods(years, today);

	const categoryById = new Map(store.categories.map((c) => [c.id, c]));
	// Headings only: with subcategories rolled into their parent, also listing each child would
	// double-count on screen and turn a 4-bar card into a 20-bar one.
	const spendableIds = new Set<string>(
		topLevelCategories(store.categories)
			.filter((c) => !c.archived && !NON_SPEND_CATEGORY_NAMES.has(c.name.trim().toLowerCase()))
			.map((c) => c.id)
	);
	if (spendableIds.size === 0) return;

	const card = container.createDiv({ cls: "fp-card" });
	// Seeded with the default period's subtitle so `cardHead` places it inside the head's own left
	// column; `render()` then just rewrites its text as the period changes.
	const head = cardHead(card, opts.title ?? "Where the money went", { sub: periods[0].sub });
	const subEl = head.querySelector<HTMLElement>(".fp-card-sub")!;

	const controls = head.createDiv({ cls: "fp-card-head-controls" });
	const periodSelect = controls.createEl("select", { cls: "fp-select fp-select--sm", attr: { "aria-label": "Period" } });
	periods.forEach((p) => periodSelect.createEl("option", { text: p.label, value: p.key }));
	const pills = controls.createDiv({ cls: "fp-pill-toggle", attr: { role: "group", "aria-label": "Filter categories" } });

	const list = card.createDiv({ cls: "fp-catbars" });

	let filter: "active" | "all" = "active";

	function render(): void {
		const period = periods.find((p) => p.key === periodSelect.value) ?? periods[0];
		subEl.setText(period.sub);

		// Rolled up: a heading's bar has to mean everything filed under it, subcategories included,
		// or the totals silently stop adding up to what the account actually spent.
		const current = rollUpCategorySpend(categorySpend(store, period.window, opts.accountIds), store.categories);

		// The trailing-average comparison only exists for the in-progress month.
		const priorTotals = new Map<string, number>();
		if (period.compare) {
			for (let i = 1; i <= COMPARISON_MONTHS; i++) {
				rollUpCategorySpend(categorySpend(store, shiftMonth(month, -i), opts.accountIds), store.categories).forEach((value, key) =>
					priorTotals.set(key, (priorTotals.get(key) ?? 0) + value)
				);
			}
		}

		const ids = new Set(spendableIds);
		if (current.has(UNCAT_KEY) || priorTotals.has(UNCAT_KEY)) ids.add(UNCAT_KEY);

		const allRows = Array.from(ids)
			.map((id) => {
				const cat = categoryById.get(id);
				const value = current.get(id) ?? 0;
				const mean = (priorTotals.get(id) ?? 0) / COMPARISON_MONTHS;
				return {
					id,
					label: cat?.name ?? (id === UNCAT_KEY ? "Uncategorized" : id),
					color: cat?.color ?? "var(--fp-ink-muted)",
					iconName: cat?.icon,
					value,
					mean,
					// Dividing by the elapsed fraction is what makes an early-month comparison fair.
					delta: period.compare ? value / elapsed - mean : 0,
				};
			})
			// Active categories first (highest spend on top), then everything else alphabetically —
			// otherwise the €0 tail would order itself by category-array position, not anything meaningful.
			.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

		const activeRows = allRows.filter((r) => r.value > 0);

		// A pill offering a set identical to the other one is decoration, not a control.
		const showPills = activeRows.length > 0 && activeRows.length < allRows.length;
		pills.empty();
		pills.toggleClass("is-hidden", !showPills);
		if (showPills) {
			const syncPressedState = () => {
				pills.querySelectorAll("button").forEach((b) => {
					const isActive = b.getAttribute("data-key") === filter;
					b.toggleClass("is-active", isActive);
					b.setAttribute("aria-pressed", String(isActive));
				});
			};
			([
				["active", "Active", activeRows.length],
				["all", "All", allRows.length],
			] as const).forEach(([key, label, count]) => {
				const btn = pills.createEl("button", { attr: { type: "button", "data-key": key } });
				btn.createSpan({ text: label });
				btn.createSpan({ cls: "fp-pill-toggle-count", text: String(count) });
				btn.addEventListener("click", () => {
					if (filter === key) return;
					filter = key;
					syncPressedState();
					renderRows(period, allRows, activeRows);
				});
			});
			syncPressedState();
		}

		renderRows(period, allRows, activeRows);
	}

	type Row = { id: string; label: string; color: string; iconName?: string; value: number; mean: number; delta: number };

	function renderRows(period: PeriodOption, allRows: Row[], activeRows: Row[]): void {
		list.empty();
		const source = filter === "active" && activeRows.length > 0 ? activeRows : allRows;
		const rows = source.slice(0, opts.limit ?? Infinity);

		if (rows.length === 0) {
			list.createDiv({ cls: "fp-card-sub", text: "No spending in this period." });
			return;
		}

		const max = Math.max(...rows.map((r) => Math.max(r.value, r.mean)), 1);

		rows.forEach((r) => {
			// Label only in `title`: the amount is already in the row's `.fp-money` cell, and a native
			// tooltip is browser chrome that no stylesheet — and so no privacy mode — can redact.
			const row = list.createEl("button", { cls: "fp-catbar", attr: { type: "button", title: r.label } });

			const label = row.createDiv({ cls: "fp-catbar-label" });
			if (r.iconName) icon(label, r.iconName, "fp-catbar-icon");
			label.createSpan({ text: r.label });

			const track = row.createDiv({ cls: "fp-catbar-track" });
			const fill = track.createDiv({ cls: "fp-catbar-fill" });
			fill.style.setProperty("--fp-bar-color", r.color);
			fill.style.width = `${(r.value / max) * 100}%`;
			if (period.compare && r.mean > 0) {
				// A ghost tick, not a second bar: the comparison qualifies the figure, it doesn't
				// compete with it.
				const ghost = track.createDiv({ cls: "fp-catbar-ghost", attr: { title: `${COMPARISON_MONTHS}-month average` } });
				ghost.style.left = `${Math.min(100, (r.mean / max) * 100)}%`;
			}

			row.createDiv({ cls: "fp-catbar-value fp-money", text: money(r.value, currency) });

			if (period.compare) {
				const flat = Math.abs(r.delta) < 1;
				const chip = row.createDiv({ cls: "fp-delta " + (flat ? "fp-delta--flat" : r.delta > 0 ? "fp-delta--bad" : "fp-delta--good") });
				chip.createSpan({ cls: flat ? undefined : "fp-money", text: flat ? "on pace" : signedMoney(r.delta, currency) });
			}

			row.addEventListener("click", () =>
				void goToLedger(
					plugin,
					{
						categoryId: r.id === UNCAT_KEY ? UNCATEGORIZED : r.id,
						dateFrom: period.range.from,
						dateTo: period.range.to,
						preset: period.range.from ? "custom" : "all",
					},
					opts.accountIds?.length === 1 ? opts.accountIds[0] : undefined
				)
			);
		});
	}

	periodSelect.addEventListener("change", render);
	render();
}
