import { App, Modal, Notice } from "obsidian";
import { categoryChain } from "../categories";
import { formatMoney } from "../money";
import { merchantKey } from "../import/merchantKey";
import { remember } from "../import/merchantMemory";
import type FinancePlugin from "../main";
import { amountGroups, changedByPreview, previewRule, rulePatches, seedRuleFor, type RulePreview } from "../rules";
import type { CategoryRule, CategoryRuleMatch, RuleAmountCondition, RuleAmountOp, Transaction } from "../types";
import { categoryChainChip, icon, renderCategoryPicker, type CategoryPickerValue } from "../ui/dom";

const AMOUNT_OPS: { value: RuleAmountOp | "any"; label: string }[] = [
	{ value: "any", label: "Any amount" },
	{ value: "exactly", label: "Is exactly" },
	{ value: "between", label: "Is between" },
	{ value: "at-most", label: "Is at most" },
	{ value: "at-least", label: "Is at least" },
];

function describeAmountCondition(c: RuleAmountCondition): string {
	const money = (v: number): string => formatMoney(v, { currency: "EUR" });
	switch (c.op) {
		case "exactly":
			return `Only charges of exactly ${money(c.value)}.`;
		case "at-most":
			return `Only charges of ${money(c.value)} or less.`;
		case "at-least":
			return `Only charges of ${money(c.value)} or more.`;
		case "between": {
			const lo = Math.min(c.value, c.value2 ?? c.value);
			const hi = Math.max(c.value, c.value2 ?? c.value);
			return `Only charges between ${money(lo)} and ${money(hi)}.`;
		}
	}
}

/** Accepts what people actually type — "9,99", "€9.99", " 9.99 ". Undefined for anything unreadable,
 *  which is treated as "no condition yet" rather than as zero. */
function parseAmountInput(raw: string): number | undefined {
	const cleaned = raw.replace(/[^0-9.,-]/g, "").replace(",", ".");
	if (!cleaned) return undefined;
	const n = Number.parseFloat(cleaned);
	return Number.isFinite(n) ? Math.abs(n) : undefined;
}

/** Ordered narrowest first, which is also the order they are worth trying in. */
const MATCH_MODES: { value: CategoryRuleMatch; label: string; hint: string }[] = [
	{
		value: "exact",
		label: "Is exactly this",
		hint: "The description (or counterparty) is exactly this and nothing more — so \u201cApple\u201d leaves \u201cApple Store\u201d alone.",
	},
	{
		value: "starts-with",
		label: "Starts with this",
		hint: "Catches every branch and reference that follows the merchant name, e.g. \u201cALBERT HEIJN 1423 DEN HAAG\u201d.",
	},
	{
		value: "contains",
		label: "Contains this anywhere",
		hint: "The widest option: matches wherever the text appears, including inside a longer merchant name.",
	},
	{ value: "regex", label: "Regular expression", hint: "Matched case-insensitively against the description and counterparty together." },
];

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
	private match: CategoryRuleMatch;
	/** Unset means "any amount" — never presumed from the row you clicked, since one charge is not
	 *  evidence that the amount is what identifies the merchant. */
	private amount?: RuleAmountCondition;
	/** Off by default: see `previewRule` on why transfers are held back from a merchant rule. */
	private includeNeutral = false;
	private value: CategoryPickerValue;
	private previewEl!: HTMLElement;
	/** Rows the user has explicitly unticked. Exclusions rather than inclusions, so a row that appears
	 *  after the pattern widens arrives selected. */
	private excluded = new Set<string>();
	private submitLabelEl!: HTMLElement;
	/** Set by render(); lets the amount chips below drive the controls above. */
	private setAmountCondition: (next?: RuleAmountCondition) => void = () => {};
	/** Remembered across re-renders — the preview panel is rebuilt on every keystroke. */
	private showAlreadyCorrect = false;
	private submitBtn!: HTMLButtonElement;

	constructor(app: App, private plugin: FinancePlugin, private tx: Transaction, private onDone?: () => void) {
		super(app);
		const seed = seedRuleFor(tx);
		this.pattern = seed.pattern;
		this.match = seed.match;
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
			{ pattern: this.pattern, match: this.match, amount: this.amount },
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

		this.renderAmountStrip(c, p);

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
	 * The distinct amounts inside the current match, each one a click away from becoming a condition.
	 *
	 * Where a merchant bills everything under one description this is the only readable structure in
	 * the match, and reading it off a 201-row table by eye is not a thing anyone should have to do.
	 * The cadence is shown, not judged: "35 · 33 months · ~30d apart" is enough to recognise a
	 * subscription, and calling it one on the user's behalf would be right only until the first annual
	 * plan.
	 */
	private renderAmountStrip(c: HTMLElement, p: RulePreview): void {
		if (this.amount) {
			const active = c.createDiv({ cls: "fp-rule-amount-active" });
			active.createSpan({ text: describeAmountCondition(this.amount) });
			const clear = active.createEl("button", { cls: "fp-btn fp-btn-ghost fp-btn-tiny" });
			clear.createSpan({ text: "Clear" });
			clear.addEventListener("click", () => this.setAmountCondition(undefined));
			return;
		}

		const all = [...changedByPreview(p), ...p.alreadyCorrect, ...p.protectedNeutral];
		const groups = amountGroups(all);
		// One amount is not a choice, and a match this small is already readable in the table below.
		if (groups.length < 2 || all.length < 4) return;

		const strip = c.createDiv({ cls: "fp-rule-amount-strip" });
		strip.createDiv({ cls: "fp-rule-amount-strip-label", text: "Amounts in this match — click one to narrow to it" });
		const chips = strip.createDiv({ cls: "fp-rule-amount-chips" });
		groups.forEach((g) => {
			const chip = chips.createEl("button", { cls: "fp-rule-amount-chip" });
			chip.createSpan({ cls: "fp-rule-amount-chip-value", text: formatMoney(g.value, { currency: g.currency }) });
			const cadence =
				g.medianGapDays !== undefined && g.months > 2 ? ` · ${g.months} months · ~${g.medianGapDays}d apart` : "";
			chip.createSpan({ cls: "fp-rule-amount-chip-meta", text: `${g.count}\u00d7${cadence}` });
			chip.setAttribute(
				"title",
				g.medianGapDays !== undefined
					? `${g.count} charges of this amount, across ${g.months} month${g.months === 1 ? "" : "s"}, typically ${g.medianGapDays} days apart.`
					: `${g.count} charge${g.count === 1 ? "" : "s"} of this amount.`
			);
			chip.addEventListener("click", () => this.setAmountCondition({ op: "exactly", value: g.value }));
		});
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
		patternControl.createDiv({ cls: "fp-field-hint", text: "Case-insensitive, and trimmed back from the full description so it names the merchant rather than this one charge." });

		const modeRow = form.createDiv({ cls: "fp-form-row" });
		modeRow.createEl("label", { text: "Match how" });
		const modeControl = modeRow.createDiv({ cls: "fp-field-control" });
		const modeSelect = modeControl.createEl("select", { cls: "fp-setup-select" });
		MATCH_MODES.forEach(({ value, label }) => modeSelect.createEl("option", { text: label, value }));
		modeSelect.value = this.match;
		const modeHint = modeControl.createDiv({ cls: "fp-field-hint" });
		const describeMode = (): void => modeHint.setText(MATCH_MODES.find((m) => m.value === this.match)?.hint ?? "");
		modeSelect.addEventListener("change", () => {
			this.match = modeSelect.value as CategoryRuleMatch;
			describeMode();
			this.renderPreview();
		});
		describeMode();

		const amountRow = form.createDiv({ cls: "fp-form-row" });
		amountRow.createEl("label", { text: "Amount" });
		const amountControl = amountRow.createDiv({ cls: "fp-field-control" });
		const amountLine = amountControl.createDiv({ cls: "fp-rule-amount-line" });
		const amountSelect = amountLine.createEl("select", { cls: "fp-setup-select" });
		AMOUNT_OPS.forEach(({ value, label }) => amountSelect.createEl("option", { text: label, value }));
		amountSelect.value = this.amount?.op ?? "any";
		const valueInput = amountLine.createEl("input", { type: "text", cls: "fp-rule-amount-input", attr: { inputmode: "decimal", placeholder: "0.00" } });
		const andSpan = amountLine.createSpan({ cls: "fp-rule-amount-and", text: "and" });
		const value2Input = amountLine.createEl("input", { type: "text", cls: "fp-rule-amount-input", attr: { inputmode: "decimal", placeholder: "0.00" } });
		amountControl.createDiv({
			cls: "fp-field-hint",
			text: "Compared on the amount as printed, ignoring the minus sign — so a refund of the same size counts too. Useful where one merchant bills everything under the same description.",
		});

		const syncAmountInputs = (): void => {
			const op = amountSelect.value;
			amountLine.toggleClass("has-value", op !== "any");
			amountLine.toggleClass("has-range", op === "between");
			valueInput.toggle(op !== "any");
			andSpan.toggle(op === "between");
			value2Input.toggle(op === "between");
		};
		const readAmount = (): void => {
			const op = amountSelect.value;
			if (op === "any") {
				this.amount = undefined;
			} else {
				const value = parseAmountInput(valueInput.value);
				if (value === undefined) {
					this.amount = undefined;
				} else {
					this.amount = { op: op as RuleAmountOp, value };
					if (op === "between") this.amount.value2 = parseAmountInput(value2Input.value) ?? value;
				}
			}
			this.renderPreview();
		};
		amountSelect.addEventListener("change", () => {
			syncAmountInputs();
			// Seed the box with this row's own amount the first time a condition is asked for, so the
			// common case — "everything at exactly this price" — is one click rather than retyping it.
			if (amountSelect.value !== "any" && !valueInput.value) {
				valueInput.value = Math.abs(this.tx.amount).toFixed(2);
			}
			readAmount();
		});
		valueInput.addEventListener("input", readAmount);
		value2Input.addEventListener("input", readAmount);
		syncAmountInputs();
		this.setAmountCondition = (next) => {
			this.amount = next;
			amountSelect.value = next?.op ?? "any";
			valueInput.value = next ? next.value.toFixed(2) : "";
			value2Input.value = next?.value2 !== undefined ? next.value2.toFixed(2) : "";
			syncAmountInputs();
			this.renderPreview();
		};

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
		if (this.match === "regex") {
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
			match: this.match,
			categoryId: target,
		};
		if (this.amount) rule.amount = this.amount;
		// Written alongside `match`, never instead of it, so anything still reading the old flag —
		// ManageRulesModal's REGEX badge among them — keeps seeing the truth.
		if (this.match === "regex") rule.isRegex = true;

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
