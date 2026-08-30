import { App, Modal, Notice } from "obsidian";
import { categoryChain } from "../categories";
import { merchantKey } from "../import/merchantKey";
import { remember } from "../import/merchantMemory";
import type FinancePlugin from "../main";
import { changedByPreview, movingCount, previewRule, seedPatternFor, type RulePreview } from "../rules";
import type { CategoryRule, Transaction } from "../types";
import { categoryChainChip, icon, renderCategoryPicker, type CategoryPickerValue } from "../ui/dom";

/**
 * Turn one transaction into a rule that files every other transaction from the same merchant.
 *
 * Reached by right-clicking a row, because that is the moment the inconsistency is actually visible:
 * you are looking at an Albert Heijn charge under the wrong category and you can see there are forty
 * more like it. Retyping the merchant into a rules dialog and then hunting for the stragglers is the
 * long way round to something the ledger already knows.
 *
 * Two things make this safe enough to be a one-click action. The pattern is seeded from `merchantKey`
 * — the same cleaned-up name the import pipeline groups by, so "ALBERT HEIJN 1423 DEN HAAG" seeds
 * "albert heijn" and picks up every branch — and nothing is written until the preview below has said,
 * in full, how many rows move and out of which categories. Unlike the import-time rule pass, this
 * deliberately *does* overwrite rows that already have a category: filing the stragglers is the point,
 * and the preview is what makes that defensible rather than destructive.
 */
export class CreateCategoryRuleModal extends Modal {
	private pattern: string;
	private isRegex = false;
	private value: CategoryPickerValue;
	private previewEl!: HTMLElement;
	private submitBtn!: HTMLButtonElement;

	constructor(app: App, private plugin: FinancePlugin, private tx: Transaction, private onDone?: () => void) {
		super(app);
		this.pattern = seedPatternFor(tx);
		const chain = categoryChain(plugin.store.categories, tx.categoryId);
		this.value = { primaryId: chain.primary?.id, secondaryId: chain.secondary?.id };
	}

	onOpen(): void {
		this.modalEl.addClass("fp-wizard-modal", "fp-rules-modal");
		this.render();
	}

	/** The category the rule files into — the secondary when one is chosen, else the primary. */
	private targetCategoryId(): string | undefined {
		return this.value.secondaryId || this.value.primaryId;
	}

	private computePreview(): RulePreview {
		return previewRule(this.plugin.store.transactions, { pattern: this.pattern, isRegex: this.isRegex }, this.targetCategoryId());
	}

	private renderPreview(): void {
		const c = this.previewEl;
		c.empty();
		const store = this.plugin.store;
		const target = this.targetCategoryId();

		if (!this.pattern.trim()) {
			c.createDiv({ cls: "fp-step-desc", text: "Type something to match on and this will show you what it would catch." });
			this.submitBtn.disabled = true;
			return;
		}
		if (!target) {
			c.createDiv({ cls: "fp-step-desc", text: "Pick the category this merchant belongs in." });
			this.submitBtn.disabled = true;
			return;
		}

		const p = this.computePreview();
		const willChange = changedByPreview(p).length;
		this.submitBtn.disabled = false;

		if (p.total === 0) {
			c.createDiv({ cls: "fp-step-desc", text: "Nothing in the ledger matches that yet. The rule will still be saved and will catch future imports." });
			return;
		}

		const summary = c.createDiv({ cls: "fp-rule-preview-summary" });
		summary.createSpan({ cls: "fp-rule-preview-count", text: String(p.total) });
		summary.createSpan({ text: ` transaction${p.total === 1 ? "" : "s"} match — ${willChange} will change, ${p.alreadyCorrect.length} already correct.` });

		if (p.uncategorized.length > 0) {
			const row = c.createDiv({ cls: "fp-rule-preview-row" });
			row.createSpan({ cls: "fp-rule-preview-n", text: String(p.uncategorized.length) });
			row.createSpan({ text: " uncategorized → " });
			const chain = categoryChain(store.categories, target);
			categoryChainChip(row, chain.primary, chain.secondary);
		}

		// The part worth reading twice: rows that already have a category and are about to lose it.
		const moving = Array.from(p.moving.entries()).sort((a, b) => b[1].length - a[1].length);
		for (const [fromId, rows] of moving) {
			const row = c.createDiv({ cls: "fp-rule-preview-row is-move" });
			row.createSpan({ cls: "fp-rule-preview-n", text: String(rows.length) });
			row.createSpan({ text: " moving from " });
			const from = categoryChain(store.categories, fromId);
			categoryChainChip(row, from.primary, from.secondary);
			row.createSpan({ cls: "fp-rule-preview-arrow", text: "→" });
			const to = categoryChain(store.categories, target);
			categoryChainChip(row, to.primary, to.secondary);
		}

		const sample = c.createDiv({ cls: "fp-rule-preview-sample" });
		sample.createDiv({ cls: "fp-form-section-label", text: "Examples" });
		const matched = [...p.uncategorized, ...moving.flatMap(([, rows]) => rows), ...p.alreadyCorrect];
		matched.slice(0, 5).forEach((tx) => {
			sample.createDiv({ cls: "fp-rule-preview-example fp-sensitive", text: `${tx.date || "No date"} · ${tx.description}` });
		});
		if (matched.length > 5) {
			sample.createDiv({ cls: "fp-step-desc", text: `…and ${matched.length - 5} more.` });
		}
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();

		const head = c.createDiv({ cls: "fp-detail-header" });
		const headText = head.createDiv();
		headText.createDiv({ cls: "fp-detail-desc", text: "Create a category rule" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "Files every transaction whose description or counterparty contains this text, now and on every future import.",
		});

		const form = c.createDiv({ cls: "fp-form" });

		const fromRow = form.createDiv({ cls: "fp-form-row" });
		fromRow.createEl("label", { text: "From" });
		fromRow.createDiv({ cls: "fp-field-hint fp-sensitive", text: this.tx.description });

		const patternRow = form.createDiv({ cls: "fp-form-row" });
		patternRow.createEl("label", { text: "Match text" });
		const patternControl = patternRow.createDiv({ cls: "fp-field-control" });
		const patternInput = patternControl.createEl("input", { type: "text" });
		patternInput.value = this.pattern;
		patternInput.addEventListener("input", () => {
			this.pattern = patternInput.value;
			this.renderPreview();
		});
		patternControl.createDiv({ cls: "fp-field-hint", text: "Case-insensitive. Shortened from the full description so it catches every branch, not just this one." });

		const regexLabel = patternControl.createEl("label", { cls: "fp-checkbox-row" });
		const regexInput = regexLabel.createEl("input", { type: "checkbox" });
		regexLabel.createSpan({ text: "Treat as a regular expression" });
		regexInput.addEventListener("change", () => {
			this.isRegex = regexInput.checked;
			this.renderPreview();
		});

		const catRow = form.createDiv({ cls: "fp-form-row" });
		catRow.createEl("label", { text: "File as" });
		renderCategoryPicker(catRow.createDiv({ cls: "fp-field-control" }), {
			categories: this.plugin.store.categories,
			value: this.value,
			primaryPlaceholder: "Choose a category…",
			onChange: (v) => {
				this.value = v;
				this.renderPreview();
			},
		});

		this.previewEl = c.createDiv({ cls: "fp-rule-preview" });

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const cancel = right.createEl("button", { cls: "fp-btn fp-btn-ghost" });
		cancel.createSpan({ text: "Cancel" });
		cancel.addEventListener("click", () => this.close());
		this.submitBtn = right.createEl("button", { cls: "fp-btn fp-btn-primary" });
		icon(this.submitBtn, "check");
		this.submitBtn.createSpan({ text: "Create rule" });
		this.submitBtn.addEventListener("click", () => void this.submit());

		this.renderPreview();
		patternInput.focus();
		patternInput.select();
	}

	private async submit(): Promise<void> {
		const target = this.targetCategoryId();
		const pattern = this.pattern.trim();
		if (!pattern || !target) return;
		if (this.isRegex) {
			try {
				new RegExp(pattern, "i");
			} catch {
				new Notice("That isn't a regular expression I can read — check the pattern.");
				return;
			}
		}

		const store = this.plugin.store;
		const rule: CategoryRule = {
			id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			pattern,
			categoryId: target,
		};
		if (this.isRegex) rule.isRegex = true;

		// Ahead of the built-ins and of every older rule: a rule you just wrote about a merchant you
		// were just looking at is the most specific intent in the list, and applyRules takes the first
		// match. Appending would let a broad old keyword rule keep winning.
		store.rules.unshift(rule);
		await store.saveRules();

		const p = this.computePreview();
		const patches = new Map<string, Partial<Transaction>>();
		for (const tx of changedByPreview(p)) {
			patches.set(tx.id, { categoryId: target, categoryRuleId: rule.id });
		}
		// Rows already filed correctly still get the stamp, so the badge tells the truth about every
		// row the rule now owns rather than only the ones that happened to move today.
		for (const tx of p.alreadyCorrect) {
			if (tx.categoryRuleId !== rule.id) patches.set(tx.id, { categoryId: target, categoryRuleId: rule.id });
		}
		const changed = patches.size > 0 ? await store.updateTransactions(patches) : 0;

		// Teach merchant memory too, exactly as the import-time rule pass does — otherwise the next
		// import re-decides this merchant from scratch and can disagree with the rule that just ran.
		for (const tx of changedByPreview(p)) {
			const key = merchantKey(tx);
			if (key) store.merchants = remember(store.merchants, key, target, "rule");
		}
		if (changed > 0) await store.saveMerchants();

		const moved = movingCount(p);
		new Notice(
			p.total === 0
				? `Rule saved for "${pattern}" — nothing matched yet, but future imports will.`
				: `Rule saved — ${p.uncategorized.length} categorized, ${moved} moved.`
		);
		this.close();
		this.onDone?.();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
