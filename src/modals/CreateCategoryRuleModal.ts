import { App, Modal, Notice } from "obsidian";
import { categoryChain } from "../categories";
import { formatMoney } from "../money";
import { merchantKey } from "../import/merchantKey";
import { remember } from "../import/merchantMemory";
import type FinancePlugin from "../main";
import { changedByPreview, previewRule, rulePatches, seedPatternFor, type RulePreview } from "../rules";
import type { CategoryRule, Transaction } from "../types";
import { categoryChainChip, icon, renderCategoryPicker, type CategoryPickerValue } from "../ui/dom";

/** A read-only list this long is already past the point of being scanned; beyond it, narrowing the
 *  pattern is the better answer than a longer list. */
const ALREADY_CORRECT_LIMIT = 500;

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
	/** Off by default: see `previewRule` on why transfers are held back from a merchant rule. */
	private includeNeutral = false;
	private value: CategoryPickerValue;
	private previewEl!: HTMLElement;
	/** Rows the user has explicitly unticked. Exclusions rather than inclusions, so a row that appears
	 *  after the pattern widens arrives selected. */
	private excluded = new Set<string>();
	private submitLabelEl!: HTMLElement;
	/** Remembered across re-renders — the preview panel is rebuilt on every keystroke. */
	private showAlreadyCorrect = false;
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
		return previewRule(
			this.plugin.store,
			{ pattern: this.pattern, isRegex: this.isRegex },
			this.targetCategoryId(),
			{ includeNeutral: this.includeNeutral }
		);
	}

	private renderPreview(): void {
		const c = this.previewEl;
		c.empty();
		const store = this.plugin.store;
		const target = this.targetCategoryId();

		if (!this.pattern.trim()) {
			c.createDiv({ cls: "fp-step-desc", text: "Type something to match on and this will show you what it would catch." });
			this.submitBtn.disabled = true;
			this.submitLabelEl.setText("Create rule");
			return;
		}
		if (!target) {
			c.createDiv({ cls: "fp-step-desc", text: "Pick the category this merchant belongs in." });
			this.submitBtn.disabled = true;
			this.submitLabelEl.setText("Create rule");
			return;
		}

		const p = this.computePreview();
		const willChange = changedByPreview(p).length;
		this.submitBtn.disabled = false;

		if (p.total === 0) {
			c.createDiv({ cls: "fp-step-desc", text: "Nothing in the ledger matches that yet. The rule will still be saved and will catch future imports." });
			this.submitLabelEl.setText("Create rule");
			return;
		}

		const summary = c.createDiv({ cls: "fp-rule-preview-summary" });
		summary.createSpan({ cls: "fp-rule-preview-count", text: String(p.total) });
		summary.createSpan({ text: ` transaction${p.total === 1 ? " matches" : "s match"} — ${willChange} will change, ${p.alreadyCorrect.length} already correct.` });

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

		// Rendered whenever there are neutral matches at all, not only while they are being held back —
		// otherwise ticking the box removes the box, and there is no way to change your mind.
		if (p.protectedNeutral.length > 0) {
			// Only while they are being held back does this group need a line of its own. Once opted in
			// they appear among the movers above, and repeating the count here said "54" twice.
			if (!p.neutralIncluded) {
				const row = c.createDiv({ cls: "fp-rule-preview-row is-protected" });
				row.createSpan({ cls: "fp-rule-preview-n", text: String(p.protectedNeutral.length) });
				row.createSpan({
					text: ` left alone — transfers and other money movements, not spending on this merchant (e.g. "${p.protectedNeutral[0].description}").`,
				});
			}
			const optIn = c.createEl("label", { cls: "fp-checkbox-row fp-rule-preview-optin" });
			const optInInput = optIn.createEl("input", { type: "checkbox" });
			optInInput.checked = this.includeNeutral;
			optIn.createSpan({
				text: p.neutralIncluded
					? `Re-filing ${p.protectedNeutral.length} transfer${p.protectedNeutral.length === 1 ? "" : "s"} as spending — untick to leave them alone`
					: "Re-file these too",
			});
			optInInput.addEventListener("change", () => {
				this.includeNeutral = optInInput.checked;
				this.renderPreview();
			});
		}

		this.renderChangeTable(c, p, target);
		this.renderAlreadyCorrect(c, p, target);
	}

	/**
	 * Every row the rule is about to write, each one tickable and ticked to begin with.
	 *
	 * A count and five examples told you the rule was broad without telling you *which* rows it had
	 * swept up, and on a pattern like "Apple" the difference between 1 correct move and 55 wrong ones
	 * is only visible row by row. This is the same shape as the Review page's own list, for the same
	 * reason: deciding is faster when the evidence is a list you can act on than when it's a number.
	 *
	 * Exclusions are tracked rather than inclusions, so a row that appears after you widen the pattern
	 * arrives ticked — the default stays "do the obvious thing", and unticking is always deliberate.
	 */
	private renderChangeTable(c: HTMLElement, p: RulePreview, target: string): void {
		const rows = changedByPreview(p);
		const store = this.plugin.store;

		if (rows.length === 0) {
			// The disclosure rendered just below already names the already-correct rows, so this line
			// only has to say that nothing moves.
			c.createDiv({
				cls: "fp-rule-preview-sample",
				text:
					p.alreadyCorrect.length > 0
						? "Nothing to change — every match is already filed here. The rule will keep them that way."
						: "Nothing to change.",
			});
			this.updateSubmitLabel(p);
			return;
		}

		const head = c.createDiv({ cls: "fp-rule-table-head" });
		const headLabel = head.createDiv({ cls: "fp-form-section-label", text: "Will change" });
		const toChain = categoryChain(store.categories, target);
		const dest = head.createDiv({ cls: "fp-rule-table-dest" });
		dest.createSpan({ text: "all ticked rows → " });
		categoryChainChip(dest, toChain.primary, toChain.secondary);

		const wrap = c.createDiv({ cls: "fp-table-scroll fp-rule-table-scroll" });
		const table = wrap.createEl("table", { cls: "fp-table fp-rule-table" });
		const headRow = table.createEl("thead").createEl("tr");
		const selectAllTh = headRow.createEl("th", { cls: "fp-ledger-th-select" });
		const selectAll = selectAllTh.createEl("input", { type: "checkbox" });
		selectAll.setAttribute("aria-label", "Select every row shown");
		headRow.createEl("th", { text: "Date" });
		headRow.createEl("th", { text: "Description" });
		headRow.createEl("th", { text: "Currently" });
		headRow.createEl("th", { text: "Amount", cls: "fp-table-num" });

		const tbody = table.createEl("tbody");
		const countEl = headLabel.createSpan({ cls: "fp-rule-table-count" });

		const refreshHeader = (): void => {
			const picked = rows.filter((t) => !this.excluded.has(t.id)).length;
			countEl.setText(` — ${picked} of ${rows.length} selected`);
			selectAll.checked = picked === rows.length;
			selectAll.indeterminate = picked > 0 && picked < rows.length;
			this.updateSubmitLabel(p);
		};

		rows.forEach((t) => {
			const tr = tbody.createEl("tr", { cls: "fp-rule-table-row" });
			const checkCell = tr.createEl("td", { cls: "fp-ledger-td-select" });
			const check = checkCell.createEl("input", { type: "checkbox" });
			check.checked = !this.excluded.has(t.id);
			check.setAttribute("aria-label", `Include ${t.description}`);
			tr.toggleClass("is-excluded", this.excluded.has(t.id));
			check.addEventListener("change", () => {
				if (check.checked) this.excluded.delete(t.id);
				else this.excluded.add(t.id);
				tr.toggleClass("is-excluded", !check.checked);
				// Only the header counters depend on this — redrawing the table would drop focus and
				// make ticking a run of rows unusable (the same reason ReviewSection doesn't).
				refreshHeader();
			});

			tr.createEl("td", { text: t.date || "No date", cls: "fp-cell-date" });
			const descCell = tr.createEl("td", { cls: "fp-sensitive" });
			descCell.createDiv({ cls: "fp-rule-table-desc", text: t.description || "(no description)" });
			if (t.counterparty && t.counterparty !== t.description) {
				descCell.createDiv({ cls: "fp-rule-table-sub fp-sensitive", text: t.counterparty });
			}
			const fromCell = tr.createEl("td");
			const from = categoryChain(store.categories, t.categoryId);
			if (from.primary) categoryChainChip(fromCell, from.primary, from.secondary);
			else fromCell.createSpan({ cls: "fp-budget-hint-text", text: "Uncategorized" });
			tr.createEl("td", {
				cls: "fp-cell-amount fp-money " + (t.amount < 0 ? "is-negative" : "is-positive"),
				text: formatMoney(t.amount, { currency: t.currency || "EUR" }),
			});
		});

		selectAll.addEventListener("change", () => {
			if (selectAll.checked) rows.forEach((t) => this.excluded.delete(t.id));
			else rows.forEach((t) => this.excluded.add(t.id));
			tbody.findAll("input[type=checkbox]").forEach((el) => ((el as HTMLInputElement).checked = selectAll.checked));
			tbody.findAll("tr").forEach((el) => el.toggleClass("is-excluded", !selectAll.checked));
			refreshHeader();
		});

		c.createDiv({
			cls: "fp-rule-table-note",
			text: "Unticked rows keep the category they have now. The rule is still created either way.",
		});

		refreshHeader();
	}

	/**
	 * The matches that are already filed where the rule wants them, behind a disclosure.
	 *
	 * They are not actionable — nothing about them changes, so there is nothing to tick — but they are
	 * the evidence for whether the pattern is too broad. "Apple" reporting 203 rows already correct is
	 * reassuring; the same 203 turning out to be full of things you never thought of as Apple purchases
	 * is not, and a bare count cannot tell those apart. Collapsed by default so the rows that *do*
	 * change stay the thing you see first.
	 *
	 * Populated only when opened, and the open/closed state is remembered across re-renders, since this
	 * whole panel is rebuilt on every keystroke in the pattern box.
	 */
	private renderAlreadyCorrect(c: HTMLElement, p: RulePreview, target: string): void {
		if (p.alreadyCorrect.length === 0) return;
		const store = this.plugin.store;

		const details = c.createEl("details", { cls: "fp-rule-done" });
		details.open = this.showAlreadyCorrect;
		const summary = details.createEl("summary", { cls: "fp-rule-done-summary" });
		summary.createSpan({ cls: "fp-rule-preview-n", text: String(p.alreadyCorrect.length) });
		summary.createSpan({ text: " already filed here — " });
		const chain = categoryChain(store.categories, target);
		categoryChainChip(summary, chain.primary, chain.secondary);

		const body = details.createDiv();
		let populated = false;
		const populate = (): void => {
			if (populated) return;
			populated = true;
			const wrap = body.createDiv({ cls: "fp-table-scroll fp-rule-table-scroll" });
			const table = wrap.createEl("table", { cls: "fp-table fp-rule-table" });
			const headRow = table.createEl("thead").createEl("tr");
			headRow.createEl("th", { text: "Date" });
			headRow.createEl("th", { text: "Description" });
			headRow.createEl("th", { text: "Amount", cls: "fp-table-num" });
			const tbody = table.createEl("tbody");
			p.alreadyCorrect.slice(0, ALREADY_CORRECT_LIMIT).forEach((t) => {
				const tr = tbody.createEl("tr");
				tr.createEl("td", { text: t.date || "No date", cls: "fp-cell-date" });
				const descCell = tr.createEl("td", { cls: "fp-sensitive" });
				descCell.createDiv({ cls: "fp-rule-table-desc", text: t.description || "(no description)" });
				if (t.counterparty && t.counterparty !== t.description) {
					descCell.createDiv({ cls: "fp-rule-table-sub fp-sensitive", text: t.counterparty });
				}
				tr.createEl("td", {
					cls: "fp-cell-amount fp-money " + (t.amount < 0 ? "is-negative" : "is-positive"),
					text: formatMoney(t.amount, { currency: t.currency || "EUR" }),
				});
			});
			if (p.alreadyCorrect.length > ALREADY_CORRECT_LIMIT) {
				body.createDiv({
					cls: "fp-rule-table-note",
					text: `Showing the first ${ALREADY_CORRECT_LIMIT} of ${p.alreadyCorrect.length}. Narrow the match text to see fewer.`,
				});
			}
		};

		if (details.open) populate();
		details.addEventListener("toggle", () => {
			this.showAlreadyCorrect = details.open;
			if (details.open) populate();
		});
	}

	/** Selected rows, in ledger order — what submit writes and what the button counts. */
	private selectedRows(p: RulePreview): Transaction[] {
		return changedByPreview(p).filter((t) => !this.excluded.has(t.id));
	}

	private updateSubmitLabel(p: RulePreview): void {
		const n = this.selectedRows(p).length;
		this.submitLabelEl.setText(n === 0 ? "Create rule only" : `Create rule & update ${n} transaction${n === 1 ? "" : "s"}`);
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
		this.submitLabelEl = this.submitBtn.createSpan({ text: "Create rule" });
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
		// Only the rows still ticked. An unticked row keeps the category it has, and deliberately does
		// not get the rule's stamp either — the badge means "this rule filed this row", and a row the
		// rule was told to leave alone would be lying about its own provenance.
		const writing = this.selectedRows(p);
		// Counted now, not after the write: `updateTransactions` assigns onto these very objects, so
		// reading `!t.categoryId` afterwards would report every filled blank as zero.
		const filled = writing.filter((t) => !t.categoryId).length;
		const moved = writing.length - filled;
		const skipped = changedByPreview(p).length - writing.length;

		const patches = rulePatches(p, this.excluded, rule);
		const changed = patches.size > 0 ? await store.updateTransactions(patches) : 0;

		// Teach merchant memory too, exactly as the import-time rule pass does — otherwise the next
		// import re-decides this merchant from scratch and can disagree with the rule that just ran.
		for (const tx of writing) {
			const key = merchantKey(tx);
			if (key) store.merchants = remember(store.merchants, key, target, "rule");
		}
		if (changed > 0) await store.saveMerchants();

		new Notice(
			p.total === 0
				? `Rule saved for "${pattern}" — nothing matched yet, but future imports will.`
				: `Rule saved — ${filled} categorized, ${moved} moved` + (skipped > 0 ? `, ${skipped} left as they were.` : ".")
		);
		this.close();
		this.onDone?.();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
