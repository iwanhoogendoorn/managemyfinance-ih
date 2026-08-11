import { Notice } from "obsidian";
import { budgetStatuses, budgetSummary, currentMonth, suggestedBudget, type CategoryBudgetStatus } from "../../budgets";
import { monthOf, shiftMonth, todayIso } from "../../kpi";
import type FinancePlugin from "../../main";
import type { Category } from "../../types";
import { categoryChip, emptyState, icon, renderStat } from "../../ui/dom";
import { renderMeter } from "../../ui/kpiCard";
import { cardHead, formatMonth, money, pct, portfolioCurrency, setStatFoot } from "./shared";

/**
 * The month the next render should open on, set by a deep link before navigating here — the same
 * module-state pattern the ledger's filter uses. Consumed once: a later visit opens on the current
 * month again, because "you went over in March" is a fact about one click, not a new home page.
 */
let pendingMonth: string | undefined;

export function setBudgetsMonth(month: string): void {
	pendingMonth = month;
}

/**
 * Simple monthly budgets, one limit per category, no rollover — each month is scored purely on its
 * own spend against its own limit. Budgets live on `Category.budget` (persisted via the same
 * `store.saveCategories()` every other category edit already uses), edited inline here since there's
 * no separate category-management UI in the app to route through instead.
 *
 * Everything is pace-adjusted. Reading 20% of a budget spent on the 3rd as "good" is exactly what
 * makes a budget tool a progress bar: at that rate the month finishes at 200%.
 */
export function renderBudgetsSection(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;
	const today = new Date();
	const thisMonth = currentMonth();
	// The month is steppable: `currentMonth()` with no way back meant last month's result — the only
	// complete one you can actually learn from — was unreachable.
	let month = pendingMonth ?? thisMonth;
	pendingMonth = undefined;

	// The section owns a root of its own rather than painting straight into the shared body element.
	// Every re-render below is reachable from an `await`, and by the time one resolves the user may
	// have navigated: `container` is the view's body and is *always* connected, so it can't tell us
	// whether we still own the page. A root we created can — it dies with the body's next `.empty()`.
	const root = container.createDiv({ cls: "fp-section" });

	// Stepping to 1970 renders today's limits against zero spend for a month that never existed.
	const firstTxDate = store.transactions.reduce<string | undefined>(
		(min, t) => (t.date && (!min || t.date < min) ? t.date : min),
		undefined
	);
	const earliestMonth = firstTxDate ? monthOf(firstTxDate) : thisMonth;

	/** Category id → its card, so a save can repaint one card instead of the whole page. */
	const cardsByCategory = new Map<string, HTMLElement>();
	let statsHost: HTMLElement | undefined;
	let meterHost: HTMLElement | undefined;

	function render(): void {
		if (!root.isConnected) return;
		root.empty();
		cardsByCategory.clear();
		const currency = portfolioCurrency(store);
		const categories = store.categories.filter((c) => !c.archived);
		const statuses = budgetStatuses(store, categories, month, today);
		const statusByCategory = new Map(statuses.map((s) => [s.categoryId, s]));
		// A budget is a single live number with no month dimension (`budgets.ts` scores every month
		// against `Category.budget`), so editing one while looking at March would silently rewrite the
		// limit you are running today. Past months are readable, not editable.
		const editable = month === thisMonth;

		/* ---------- header + month stepper ---------- */

		const header = root.createDiv({ cls: "fp-section-header" });
		const headText = header.createDiv();
		headText.createEl("h2", { text: "Budgets" });
		headText.createDiv({ cls: "fp-section-subtitle", text: "Monthly limits per category — resets each month, no rollover." });

		const stepper = header.createDiv({ cls: "fp-month-stepper" });
		const step = (delta: number, label: string, iconName: string) => {
			const btn = stepper.createEl("button", { cls: "fp-btn fp-btn--ghost fp-btn--icon", attr: { type: "button", "aria-label": label } });
			icon(btn, iconName);
			btn.addEventListener("click", () => {
				month = shiftMonth(month, delta);
				render();
			});
			return btn;
		};
		const prev = step(-1, "Previous month", "chevron-left");
		// Nothing was budgeted before the ledger starts, and nothing was spent there either.
		if (month <= earliestMonth) prev.setAttr("disabled", "true");
		stepper.createSpan({ cls: "fp-month-stepper-label", text: formatMonth(month) });
		const next = step(1, "Next month", "chevron-right");
		// There is nothing to budget in the future, and nothing to score there either.
		if (month >= monthOf(todayIso(today))) next.setAttr("disabled", "true");

		if (!editable) {
			root.createDiv({
				cls: "fp-card-note",
				text: `Read-only — ${formatMonth(month)} is scored against your current limits. Budgets aren't kept per month, so step back to ${formatMonth(
					thisMonth
				)} to change one.`,
			});
		}

		/* ---------- stats ---------- */

		statsHost = root.createDiv();
		drawStats(categories.length, currency);

		if (categories.length === 0) {
			emptyState(root, {
				iconName: "piggy-bank",
				title: "No categories yet",
				description: "Categories are created as you import and tag transactions — come back once you have some.",
			});
			return;
		}

		/* ---------- total meter with the pace marker ---------- */

		meterHost = root.createDiv();
		drawTotalMeter(categories, currency);

		/* ---------- grouped budget cards ---------- */

		const budgeted = statuses.slice().sort((a, b) => b.pace - a.pace);
		const attention = budgeted.filter((s) => s.tone !== "good");
		const onTrack = budgeted.filter((s) => s.tone === "good");
		const categoryById = new Map(categories.map((c) => [c.id, c]));

		const group = (title: string, items: CategoryBudgetStatus[]) => {
			if (items.length === 0) return;
			const head = root.createDiv({ cls: "fp-group-head" });
			head.createSpan({ text: title });
			head.createSpan({ cls: "fp-group-head-count", text: String(items.length) });
			const grid = root.createDiv({ cls: "fp-budget-grid" });
			items.forEach((s) => {
				const category = categoryById.get(s.categoryId);
				if (category) {
					const card = grid.createDiv({ cls: "fp-card fp-card--tight fp-budget-card" });
					cardsByCategory.set(category.id, card);
					drawBudgetCard(card, category, s, currency, editable);
				}
			});
		};
		group("Needs attention", attention);
		group("On track", onTrack);

		/* ---------- unbudgeted, as suggestion chips ---------- */

		const unbudgeted = categories
			.filter((c) => !statusByCategory.has(c.id))
			.map((c) => ({ category: c, suggestion: suggestedBudget(store, c.id, month) }))
			.filter((row) => row.suggestion !== undefined)
			.sort((a, b) => (b.suggestion ?? 0) - (a.suggestion ?? 0));

		if (unbudgeted.length > 0) {
			const card = root.createDiv({ cls: "fp-card" });
			// Eighteen empty cards padding the page is not a list of options, it's noise. A chip row
			// keeps them one click away without pretending they're all decisions to make today.
			cardHead(card, "Not budgeted", {
				sub: editable ? "Suggested from your last 3 months — click to set a limit" : "Suggested from your last 3 months",
			});
			const chips = card.createDiv({ cls: "fp-suggest-chips" });
			unbudgeted.forEach(({ category, suggestion }) => {
				const chip = chips.createEl("button", { cls: "fp-suggest-chip", attr: { type: "button" } });
				chip.style.setProperty("--fp-chip-color", category.color);
				if (category.icon) icon(chip, category.icon, "fp-chip-icon");
				chip.createSpan({ text: category.name });
				chip.createSpan({ cls: "fp-suggest-chip-value fp-money", text: money(suggestion!, currency) });
				if (editable) chip.addEventListener("click", () => void saveBudget(category, String(suggestion), { structural: true }));
				else chip.setAttr("disabled", "true");
			});
		}
	}

	/* ---------- the pieces a save can repaint on its own ---------- */

	/** Every figure here is derived from the budget set, and none of it can hold keyboard focus. */
	function drawStats(categoryCount: number, currency: string): void {
		if (!statsHost) return;
		statsHost.empty();
		const categories = store.categories.filter((c) => !c.archived);
		const statuses = budgetStatuses(store, categories, month, today);
		const summary = budgetSummary(store, categories, month, today);
		const budgetedCount = statuses.length;

		const kpis = statsHost.createDiv({ cls: "fp-stat-grid" });
		const budgetedCard = renderStat(kpis, {
			label: "Budgeted",
			value: money(summary.totalBudget, currency),
			size: "hero",
			iconName: "target",
		});
		setStatFoot(budgetedCard, [`${budgetedCount} of ${categoryCount} categories have a limit`]);

		const spentCard = renderStat(kpis, { label: "Spent", value: money(summary.totalSpent, currency), iconName: "trending-down" });
		setStatFoot(spentCard, [
			summary.totalBudget > 0 ? `${pct(summary.totalSpent / summary.totalBudget)} of budget · ` : "",
			summary.pace >= 1 ? "ahead of pace" : "tracking under pace",
		]);

		const remaining = summary.totalBudget - summary.totalSpent;
		const remainingCard = renderStat(kpis, {
			label: "Remaining",
			value: money(remaining, currency),
			iconName: "wallet",
			tone: budgetedCount === 0 ? "neutral" : remaining < 0 ? "bad" : "good",
		});
		setStatFoot(remainingCard, [`${Math.round((1 - summary.elapsed) * 100)}% of the month left`]);

		if (summary.unbudgetedSpend > 0) {
			// Without this you can read "everything under budget" while most of your money leaves
			// through categories nobody set a limit on.
			const unbudgeted = renderStat(kpis, {
				label: "Unbudgeted spend",
				value: money(summary.unbudgetedSpend, currency),
				iconName: "circle-help",
				tone: summary.totalBudget > 0 && summary.unbudgetedSpend > summary.totalSpent ? "warn" : "neutral",
			});
			setStatFoot(unbudgeted, ["spent this month in categories with no limit"]);
		}
	}

	function drawTotalMeter(categories: Category[], currency: string): void {
		if (!meterHost) return;
		meterHost.empty();
		const summary = budgetSummary(store, categories, month, today);
		if (summary.totalBudget <= 0) return;
		renderMeter(meterHost, {
			label: "Total",
			value: summary.totalSpent / summary.totalBudget,
			valueLabel: `${money(summary.totalSpent, currency)} of ${money(summary.totalBudget, currency)}`,
			pace: summary.elapsed,
			tone: summary.totalSpent > summary.totalBudget ? "over" : summary.pace >= 1 ? "warn" : "ok",
			renderSub: (el) => {
				el.createSpan({
					text:
						summary.pace >= 1
							? `Spending ${(summary.pace * 100 - 100).toFixed(0)}% faster than the month is passing.`
							: `The tick marks how far through ${formatMonth(month)} you are.`,
				});
				if (summary.overCount > 0 || summary.projectedOverCount > 0) {
					const bits: string[] = [];
					if (summary.overCount > 0) bits.push(`${summary.overCount} over`);
					if (summary.projectedOverCount > 0) bits.push(`${summary.projectedOverCount} projected over`);
					el.createSpan({ text: ` ${bits.join(" · ")}.` });
				}
			},
		});
	}

	/** Fills an existing card element, so a repaint can reuse the node the user is looking at. */
	function drawBudgetCard(
		card: HTMLElement,
		category: Category,
		status: CategoryBudgetStatus,
		currency: string,
		editable: boolean
	): void {
		card.empty();
		card.className = `fp-card fp-card--tight fp-budget-card fp-tone-${status.tone}`;

		const top = card.createDiv({ cls: "fp-budget-card-top" });
		categoryChip(top, category.name, category.color, category.icon);

		const inputWrap = top.createDiv({ cls: "fp-budget-input-wrap" });
		inputWrap.createSpan({ cls: "fp-budget-input-prefix", text: "€" });
		const input = inputWrap.createEl("input", {
			type: "number",
			cls: "fp-budget-input",
			attr: { min: "0", step: "1", placeholder: "0", inputmode: "decimal", "aria-label": `Monthly budget for ${category.name}` },
		});
		input.value = category.budget ? String(category.budget) : "";
		if (editable) {
			input.addEventListener("blur", () => void saveBudget(category, input.value));
			input.addEventListener("keydown", (ev) => {
				if (ev.key === "Enter") input.blur();
			});
		} else {
			input.disabled = true;
			input.setAttr("title", "Budgets aren't kept per month — switch to the current month to change this limit.");
		}

		const track = card.createDiv({ cls: "fp-meter-track" });
		const fill = track.createDiv({ cls: "fp-meter-fill" });
		const filled = Math.max(0, Math.min(100, status.pct * 100));
		fill.style.width = `${filled}%`;
		track.style.setProperty("--fp-meter-cap", `${filled}%`);
		card.toggleClass("fp-meter--over", status.pct > 1);
		card.toggleClass("fp-meter--warn", status.pct <= 1 && status.tone === "warn");
		if (status.elapsed > 0 && status.elapsed < 1) {
			const pace = track.createDiv({ cls: "fp-meter-pace" });
			pace.style.left = `${status.elapsed * 100}%`;
			pace.setAttr("title", `${Math.round(status.elapsed * 100)}% through the month`);
		}

		const sub = card.createDiv({ cls: "fp-budget-card-sub" });
		sub.createSpan({ cls: "fp-money", text: `${money(status.spent, currency)} of ${money(status.budget, currency)}` });
		// Color never carries the meaning alone — the word does.
		sub.createSpan({
			cls: "fp-budget-remaining fp-money",
			text: status.remaining >= 0 ? `${money(status.remaining, currency)} left` : `${money(-status.remaining, currency)} over`,
		});

		if (status.pct < 1 && status.pace >= 1) {
			const projection = card.createDiv({ cls: "fp-budget-projection" });
			projection.createSpan({ text: "On pace for " });
			projection.createSpan({ cls: "fp-money", text: money(status.projected, currency) });
			projection.createSpan({ text: " by month end." });
		}
	}

	/**
	 * `opts.structural` marks the saves that change the *shape* of the page — a category gaining or
	 * losing a limit moves between the card grid and the chip row — and only those rebuild it.
	 *
	 * The common case (edit a number, press Tab) repaints exactly one card plus the derived figures
	 * above it. The old full rebuild tore down the section from inside a `blur` handler, so focus fell
	 * to `<body>` and the next keystrokes went nowhere: setting five budgets meant five mouse
	 * round-trips. `plugin.refreshViews()` is deliberately *not* called for the same reason — it
	 * re-enters `renderBody()`, which empties the body and would undo the fix. The overview's budget
	 * strip is rebuilt from scratch the moment the user navigates back to it, so it can't go stale.
	 *
	 * A patched card keeps its place under "Needs attention" / "On track" until the next full render.
	 * Moving it mid-edit would pull the grid out from under the cursor for a heading that the card's
	 * own tone already contradicts on screen.
	 */
	async function saveBudget(category: Category, rawValue: string, opts: { structural?: boolean } = {}): Promise<void> {
		const parsed = parseFloat(rawValue);
		const amount = isFinite(parsed) && parsed > 0 ? parsed : undefined;
		if (category.budget === amount) return;
		const target = store.categories.find((c) => c.id === category.id);
		if (!target) return;
		const hadBudget = target.budget !== undefined;
		target.budget = amount;
		await store.saveCategories();
		if (!root.isConnected) return;
		new Notice(
			amount
				? `Budget for "${category.name}" set to ${money(amount, portfolioCurrency(store))}/mo`
				: `Budget removed for "${category.name}"`
		);

		const card = cardsByCategory.get(category.id);
		const structural = opts.structural || hadBudget !== (amount !== undefined) || !card;
		if (structural) {
			render();
			return;
		}

		const currency = portfolioCurrency(store);
		const categories = store.categories.filter((c) => !c.archived);
		const status = budgetStatuses(store, categories, month, today).find((s) => s.categoryId === category.id);
		if (status) drawBudgetCard(card!, target, status, currency, true);
		drawStats(categories.length, currency);
		drawTotalMeter(categories, currency);
	}

	render();
}
