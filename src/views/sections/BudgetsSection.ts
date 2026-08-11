import { Notice } from "obsidian";
import { budgetStatuses, budgetSummary, currentMonth, suggestedBudget, type CategoryBudgetStatus } from "../../budgets";
import { monthOf, shiftMonth, todayIso } from "../../kpi";
import type FinancePlugin from "../../main";
import type { Category } from "../../types";
import { categoryChip, emptyState, icon, renderStat } from "../../ui/dom";
import { renderMeter } from "../../ui/kpiCard";
import { cardHead, formatMonth, money, pct, portfolioCurrency, setStatFoot } from "./shared";

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
	container.addClass("fp-section");
	const store = plugin.store;
	const today = new Date();
	// The month is steppable: `currentMonth()` with no way back meant last month's result — the only
	// complete one you can actually learn from — was unreachable.
	let month = currentMonth();

	function render(): void {
		container.empty();
		const currency = portfolioCurrency(store);
		const categories = store.categories.filter((c) => !c.archived);
		const statuses = budgetStatuses(store, categories, month, today);
		const summary = budgetSummary(store, categories, month, today);
		const statusByCategory = new Map(statuses.map((s) => [s.categoryId, s]));

		/* ---------- header + month stepper ---------- */

		const header = container.createDiv({ cls: "fp-section-header" });
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
		step(-1, "Previous month", "chevron-left");
		stepper.createSpan({ cls: "fp-month-stepper-label", text: formatMonth(month) });
		const next = step(1, "Next month", "chevron-right");
		// There is nothing to budget in the future, and nothing to score there either.
		if (month >= monthOf(todayIso(today))) next.setAttr("disabled", "true");

		/* ---------- stats ---------- */

		const budgetedCount = statuses.length;
		const kpis = container.createDiv({ cls: "fp-stat-grid" });
		const budgetedCard = renderStat(kpis, {
			label: "Budgeted",
			value: money(summary.totalBudget, currency),
			size: "hero",
			iconName: "target",
		});
		setStatFoot(budgetedCard, [`${budgetedCount} of ${categories.length} categories have a limit`]);

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

		if (categories.length === 0) {
			emptyState(container, {
				iconName: "piggy-bank",
				title: "No categories yet",
				description: "Categories are created as you import and tag transactions — come back once you have some.",
			});
			return;
		}

		/* ---------- total meter with the pace marker ---------- */

		if (summary.totalBudget > 0) {
			renderMeter(container, {
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

		/* ---------- grouped budget cards ---------- */

		const budgeted = statuses.slice().sort((a, b) => b.pace - a.pace);
		const attention = budgeted.filter((s) => s.tone !== "good");
		const onTrack = budgeted.filter((s) => s.tone === "good");
		const categoryById = new Map(categories.map((c) => [c.id, c]));

		const group = (title: string, items: CategoryBudgetStatus[]) => {
			if (items.length === 0) return;
			const head = container.createDiv({ cls: "fp-group-head" });
			head.createSpan({ text: title });
			head.createSpan({ cls: "fp-group-head-count", text: String(items.length) });
			const grid = container.createDiv({ cls: "fp-budget-grid" });
			items.forEach((s) => {
				const category = categoryById.get(s.categoryId);
				if (category) renderBudgetCard(grid, category, s, currency);
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
			const card = container.createDiv({ cls: "fp-card" });
			// Eighteen empty cards padding the page is not a list of options, it's noise. A chip row
			// keeps them one click away without pretending they're all decisions to make today.
			cardHead(card, "Not budgeted", { sub: "Suggested from your last 3 months — click to set a limit" });
			const chips = card.createDiv({ cls: "fp-suggest-chips" });
			unbudgeted.forEach(({ category, suggestion }) => {
				const chip = chips.createEl("button", { cls: "fp-suggest-chip", attr: { type: "button" } });
				chip.style.setProperty("--fp-chip-color", category.color);
				if (category.icon) icon(chip, category.icon, "fp-chip-icon");
				chip.createSpan({ text: category.name });
				chip.createSpan({ cls: "fp-suggest-chip-value fp-money", text: money(suggestion!, currency) });
				chip.addEventListener("click", () => void saveBudget(category, String(suggestion)));
			});
		}
	}

	function renderBudgetCard(parent: HTMLElement, category: Category, status: CategoryBudgetStatus, currency: string): void {
		const card = parent.createDiv({ cls: `fp-card fp-card--tight fp-budget-card fp-tone-${status.tone}` });

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
		input.addEventListener("blur", () => void saveBudget(category, input.value));
		input.addEventListener("keydown", (ev) => {
			if (ev.key === "Enter") input.blur();
		});

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

	async function saveBudget(category: Category, rawValue: string): Promise<void> {
		const parsed = parseFloat(rawValue);
		const amount = isFinite(parsed) && parsed > 0 ? parsed : undefined;
		if (category.budget === amount) return;
		const target = store.categories.find((c) => c.id === category.id);
		if (!target) return;
		target.budget = amount;
		await store.saveCategories();
		new Notice(
			amount
				? `Budget for "${category.name}" set to ${money(amount, portfolioCurrency(store))}/mo`
				: `Budget removed for "${category.name}"`
		);
		render();
	}

	render();
}
