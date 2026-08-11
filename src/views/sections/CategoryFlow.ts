import { elapsedFraction } from "../../budgets";
import { categorySpend, firstDayOf, lastDayOf, monthOf, shiftMonth, todayIso } from "../../kpi";
import type FinancePlugin from "../../main";
import { icon } from "../../ui/dom";
import { goToLedger, UNCATEGORIZED } from "./LedgerSection";
import { cardHead, money, portfolioCurrency, signedMoney } from "./shared";

/** The trailing window every "is this normal?" comparison is made against. */
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

/**
 * Spending by category for the *current month*, each bar carrying a ghost tick at its trailing
 * three-month mean and a chip saying how far off pace it is.
 *
 * Year-to-date was the wrong window: in November it is an eleven-month average that hides having
 * tripled restaurant spend in October, which is the only thing the user could still act on.
 */
export function renderCategoryFlowCard(container: HTMLElement, plugin: FinancePlugin, opts: CategoryFlowOpts = {}): void {
	const store = plugin.store;
	const today = opts.today ?? new Date();
	const currency = portfolioCurrency(store);
	const month = monthOf(todayIso(today));
	// Never 0: on the 1st this is 1/31, so an early-month pace is large but finite.
	const elapsed = Math.max(0.01, elapsedFraction(month, today));

	const current = categorySpend(store, month, opts.accountIds);

	const priorTotals = new Map<string, number>();
	for (let i = 1; i <= COMPARISON_MONTHS; i++) {
		categorySpend(store, shiftMonth(month, -i), opts.accountIds).forEach((value, key) =>
			priorTotals.set(key, (priorTotals.get(key) ?? 0) + value)
		);
	}

	// Every spend-eligible category, not just ones with spend this month — a €0 row is still useful
	// information ("nothing here yet"), and hiding it made the card look incomplete rather than
	// genuinely quiet. UNCATEGORIZED is included only when it has ever had spend (current or in the
	// comparison window): unlike a real category, showing it permanently at €0 would be a standing
	// accusation of nothing.
	const ids = new Set<string>(
		store.categories.filter((c) => !c.archived && !NON_SPEND_CATEGORY_NAMES.has(c.name.trim().toLowerCase())).map((c) => c.id)
	);
	if (current.has(UNCAT_KEY) || priorTotals.has(UNCAT_KEY)) ids.add(UNCAT_KEY);
	if (ids.size === 0) return;

	const categoryById = new Map(store.categories.map((c) => [c.id, c]));
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
				delta: value / elapsed - mean,
			};
		})
		// Active categories first (highest spend on top), then everything else alphabetically —
		// otherwise the €0 tail would order itself by category-array position, not anything meaningful.
		.sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));

	const activeRows = allRows.filter((r) => r.value > 0);

	const card = container.createDiv({ cls: "fp-card" });
	const head = cardHead(card, opts.title ?? "Where the money went", {
		sub: `This month so far, against your ${COMPARISON_MONTHS}-month average`,
	});
	const list = card.createDiv({ cls: "fp-catbars" });

	// Nothing to filter — the pill toggle would just be a decoration with one working setting.
	const showPills = activeRows.length > 0 && activeRows.length < allRows.length;
	let filter: "active" | "all" = "active";

	function renderRows(): void {
		list.empty();
		const rows = (filter === "active" ? activeRows : allRows).slice(0, opts.limit ?? Infinity);
		const max = Math.max(...rows.map((r) => Math.max(r.value, r.mean)), 1);

		rows.forEach((r) => {
			// Label only in `title`: the amount is already in the row's `.fp-money` cell, and a native
			// tooltip is browser chrome that no stylesheet — and so no privacy mode — can redact.
			const row = list.createEl("button", {
				cls: "fp-catbar",
				attr: { type: "button", title: r.label },
			});

			const label = row.createDiv({ cls: "fp-catbar-label" });
			if (r.iconName) icon(label, r.iconName, "fp-catbar-icon");
			label.createSpan({ text: r.label });

			const track = row.createDiv({ cls: "fp-catbar-track" });
			const fill = track.createDiv({ cls: "fp-catbar-fill" });
			fill.style.setProperty("--fp-bar-color", r.color);
			fill.style.width = `${(r.value / max) * 100}%`;
			if (r.mean > 0) {
				// A ghost tick, not a second bar: the comparison qualifies the figure, it doesn't
				// compete with it.
				const ghost = track.createDiv({
					cls: "fp-catbar-ghost",
					attr: { title: `${COMPARISON_MONTHS}-month average` },
				});
				ghost.style.left = `${Math.min(100, (r.mean / max) * 100)}%`;
			}

			row.createDiv({ cls: "fp-catbar-value fp-money", text: money(r.value, currency) });

			const flat = Math.abs(r.delta) < 1;
			const chip = row.createDiv({ cls: "fp-delta " + (flat ? "fp-delta--flat" : r.delta > 0 ? "fp-delta--bad" : "fp-delta--good") });
			chip.createSpan({ cls: flat ? undefined : "fp-money", text: flat ? "on pace" : signedMoney(r.delta, currency) });

			row.addEventListener("click", () =>
				void goToLedger(
					plugin,
					{
						categoryId: r.id === UNCAT_KEY ? UNCATEGORIZED : r.id,
						dateFrom: firstDayOf(month),
						dateTo: lastDayOf(month),
						preset: "custom",
					},
					opts.accountIds?.length === 1 ? opts.accountIds[0] : undefined
				)
			);
		});
	}

	if (showPills) {
		const pills = head.createDiv({ cls: "fp-pill-toggle", attr: { role: "group", "aria-label": "Filter categories" } });
		const syncPressedState = () => {
			pills.querySelectorAll("button").forEach((b) => {
				const isActive = b.getAttribute("data-key") === filter;
				b.toggleClass("is-active", isActive);
				b.setAttribute("aria-pressed", String(isActive));
			});
		};
		const makePill = (key: "active" | "all", label: string, count: number) => {
			const btn = pills.createEl("button", { attr: { type: "button", "data-key": key } });
			btn.createSpan({ text: label });
			btn.createSpan({ cls: "fp-pill-toggle-count", text: String(count) });
			btn.addEventListener("click", () => {
				if (filter === key) return;
				filter = key;
				syncPressedState();
				renderRows();
			});
		};
		makePill("active", "Active", activeRows.length);
		makePill("all", "All", allRows.length);
		syncPressedState();
	}

	renderRows();
}
