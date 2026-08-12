import { App, Modal, Notice } from "obsidian";
import { currentMonth, suggestedBudget } from "../budgets";
import { formatMoney, parseAmount } from "../format";
import type FinancePlugin from "../main";
import { registerOpenModal, unregisterOpenModal } from "../modalRegistry";
import type { Category } from "../types";
import { categoryChip, emptyState, icon } from "../ui/dom";

/** How many categories start checked. Five is enough to cover most of a month's spend without turning
 *  the first budget anyone sets into a twenty-six-line commitment they abandon. */
const PRESELECT = 5;

interface BudgetRow {
	category: Category;
	/** Three-month average — what `suggestedBudget` extracted from this category's own history. */
	suggested: number;
	checked: boolean;
	/** What the user will actually save; starts at the suggestion. */
	value: number;
}

/**
 * Flow D2 — guided budget setup from actual spending.
 *
 * Every number here comes from `suggestedBudget()`, unchanged: a three-month average of the
 * category's own spend, rounded to €5. The one thing this screen adds beyond a list of suggestions is
 * the running total against real average spend — a budget set that silently totals more than you
 * spend is worse than no budget at all, and that is invisible when you set limits one card at a time.
 */
export class BudgetSetupModal extends Modal {
	private rows: BudgetRow[] = [];
	private bodyEl!: HTMLElement;
	private month = currentMonth();

	constructor(app: App, private plugin: FinancePlugin) {
		super(app);
	}

	onOpen(): void {
		// Registered so a portfolio switch can close it — see modalRegistry.
		registerOpenModal(this);
		this.modalEl.addClass("fpih-wizard-modal");
		this.modalEl.addClass("fpih-root");
		this.modalEl.addClass("fpih-budget-setup-modal");
		this.contentEl.addClass("fpih-account-modal");

		this.rows = this.buildRows();
		this.bodyEl = this.contentEl.createDiv();
		this.render();
	}

	onClose(): void {
		unregisterOpenModal(this);
		this.contentEl.empty();
	}

	/** Only categories with real spending history — a suggestion of `undefined` means there is nothing
	 *  to extract a pattern from, and a budget on a category you have never spent in is noise. */
	private buildRows(): BudgetRow[] {
		const store = this.plugin.store;
		const rows: BudgetRow[] = [];
		for (const category of store.categories) {
			if (category.archived) continue;
			const suggested = suggestedBudget(store, category.id, this.month);
			if (!suggested) continue;
			rows.push({ category, suggested, checked: false, value: category.budget ?? suggested });
		}
		rows.sort((a, b) => b.suggested - a.suggested || a.category.name.localeCompare(b.category.name));
		rows.slice(0, PRESELECT).forEach((row) => (row.checked = true));
		return rows;
	}

	private render(): void {
		this.bodyEl.empty();

		this.bodyEl.createEl("h3", { text: "Set up budgets from your spending" });

		if (this.rows.length === 0) {
			emptyState(this.bodyEl, {
				iconName: "calendar-clock",
				title: "Not enough history yet",
				description:
					this.plugin.store.transactions.length === 0
						? "Import some transactions first — budgets are suggested from your own averages, not from generic advice."
						: "Come back after a month of transactions and we'll suggest a limit for every category you actually spend in.",
				actionLabel: "Close",
				onAction: () => this.close(),
			});
			return;
		}

		this.bodyEl.createEl("p", {
			cls: "fpih-step-desc",
			text: "Based on your last 3 months. Adjust anything before saving — these are starting points, not verdicts.",
		});

		const list = this.bodyEl.createDiv({ cls: "fpih-budget-setup-list" });
		this.rows.forEach((row) => this.renderRow(list, row));

		const summary = this.bodyEl.createDiv({ cls: "fpih-budget-setup-summary" });
		this.renderSummary(summary);

		const footer = this.bodyEl.createDiv({ cls: "fpih-wizard-footer" });
		const left = footer.createDiv({ cls: "fpih-wizard-footer-left" });
		const right = footer.createDiv({ cls: "fpih-wizard-footer-right" });

		const cancel = left.createEl("button", { cls: "fpih-btn fpih-btn--ghost fpih-btn-ghost", text: "Cancel", attr: { type: "button" } });
		cancel.addEventListener("click", () => this.close());

		// Counted the same way `save()` counts: a checked row with the amount zeroed out writes nothing,
		// so promising "Set 5 budgets" and then reporting 4 was the button describing a different set of
		// rows than the one it acts on.
		const count = this.rows.filter((r) => r.checked && r.value > 0).length;
		const save = right.createEl("button", { cls: "fpih-btn fpih-btn--primary fpih-btn-primary", attr: { type: "button" } });
		icon(save, "target");
		const checked = this.rows.filter((r) => r.checked).length;
		save.createSpan({
			text: count > 0 ? `Set ${count} budget${count === 1 ? "" : "s"}` : checked === 0 ? "Nothing selected" : "Every selected limit is 0",
		});
		save.disabled = count === 0;
		save.addEventListener("click", () => void this.save());
	}

	private renderRow(list: HTMLElement, row: BudgetRow): void {
		const el = list.createDiv({ cls: "fpih-budget-setup-row" + (row.checked ? " is-checked" : "") });

		const check = el.createEl("input", { type: "checkbox" });
		check.checked = row.checked;
		check.addEventListener("change", () => {
			row.checked = check.checked;
			this.render();
		});

		categoryChip(el, row.category.name, row.category.color, row.category.icon);

		const avg = el.createDiv({ cls: "fpih-budget-setup-avg" });
		avg.createSpan({ text: "avg " });
		avg.createSpan({ cls: "fpih-money", text: formatMoney(row.suggested, "EUR", { decimals: 0 }) });
		avg.createSpan({ text: "/mo" });
		if (row.category.budget) {
			avg.createSpan({ cls: "fpih-budget-setup-existing", text: ` · currently ${formatMoney(row.category.budget, "EUR", { decimals: 0 })}` });
		}

		const inputWrap = el.createDiv({ cls: "fpih-budget-input-wrap" });
		inputWrap.createSpan({ cls: "fpih-budget-input-prefix", text: "€" });
		const input = inputWrap.createEl("input", { cls: "fpih-budget-input", type: "text", attr: { inputmode: "decimal" } });
		input.value = String(row.value);
		input.disabled = !row.checked;
		input.addEventListener("input", () => {
			row.value = Math.max(0, parseAmount(input.value) ?? 0);
		});
		// Live totals only need to settle when the user stops typing — re-rendering per keystroke would
		// steal focus out of the field they are still in.
		input.addEventListener("change", () => this.render());
	}

	private renderSummary(container: HTMLElement): void {
		const selected = this.rows.filter((r) => r.checked);
		const budgeted = selected.reduce((sum, r) => sum + r.value, 0);
		const actual = selected.reduce((sum, r) => sum + r.suggested, 0);
		const delta = actual - budgeted;

		const line = container.createDiv({ cls: "fpih-budget-setup-total" });
		line.createSpan({ text: "Budgeting " });
		line.createSpan({ cls: "fpih-money", text: formatMoney(budgeted, "EUR", { decimals: 0 }) });
		line.createSpan({ text: "/mo against " });
		line.createSpan({ cls: "fpih-money", text: formatMoney(actual, "EUR", { decimals: 0 }) });
		line.createSpan({ text: "/mo average spend" });

		if (Math.abs(delta) < 1) {
			container.createDiv({ cls: "fpih-budget-setup-verdict", text: "— exactly your current pace." });
			return;
		}
		const verdict = container.createDiv({ cls: "fpih-budget-setup-verdict fpih-tone-" + (delta > 0 ? "good" : "warn") });
		verdict.createSpan({ text: "— " });
		verdict.createSpan({ cls: "fpih-money", text: formatMoney(Math.abs(delta), "EUR", { decimals: 0 }) });
		verdict.createSpan({ text: delta > 0 ? "/mo tighter than your current pace." : "/mo looser than your current pace." });
	}

	private async save(): Promise<void> {
		const store = this.plugin.store;
		let count = 0;
		for (const row of this.rows) {
			if (!row.checked || row.value <= 0) continue;
			const category = store.categories.find((c) => c.id === row.category.id);
			if (!category) continue;
			category.budget = row.value;
			count++;
		}
		await store.saveCategories();
		this.plugin.settings.activeView = "budgets";
		await this.plugin.saveSettings();
		await this.plugin.activateView();
		this.plugin.refreshViews();
		new Notice(`Set ${count} budget${count === 1 ? "" : "s"}`);
		this.close();
	}
}

export function openBudgetSetup(plugin: FinancePlugin): void {
	new BudgetSetupModal(plugin.app, plugin).open();
}
