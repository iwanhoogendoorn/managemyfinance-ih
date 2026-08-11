import { App, Modal, Notice } from "obsidian";
import { parseAmount } from "../format";
import { applyRules } from "../import/categorize";
import { todayIso } from "../kpi";
import type FinancePlugin from "../main";
import { registerOpenModal, unregisterOpenModal } from "../modalRegistry";
import type { Transaction } from "../types";
import { icon } from "../ui/dom";

/**
 * Manual transaction entry — the one way a row gets into the ledger without a bank export. Cash
 * spending, a reimbursement, a correction. `source: "manual"` was in the Transaction type union from
 * day one; this is the first thing that produces it.
 *
 * The id is unique per entry, NOT the import pipeline's stableHash: hashing account|date|amount|
 * description would silently collapse two deliberately identical rows (two coffees, same café, same
 * day) into one, and manual entry has no re-import-overlap problem for the hash to solve.
 */
export class AddTransactionModal extends Modal {
	private accountId: string;
	private date = todayIso();
	private description = "";
	private counterparty = "";
	private amountRaw = "";
	private direction: "expense" | "income" = "expense";
	private categoryId = "";
	private notes = "";
	/** Guards the save against a portfolio switch while the modal is open — see modalRegistry. */
	private readonly openedAtGeneration: number;

	constructor(app: App, private plugin: FinancePlugin, private onSaved?: (tx: Transaction) => void) {
		super(app);
		this.accountId = plugin.settings.activeAccountId ?? plugin.store.accounts[0]?.id ?? "";
		this.openedAtGeneration = plugin.store.generation;
	}

	onOpen(): void {
		registerOpenModal(this);
		this.modalEl.addClass("fp-wizard-modal");
		this.modalEl.addClass("fp-root");
		const c = this.contentEl;
		c.addClass("fp-account-modal");

		c.createEl("h3", { text: "Add transaction" });
		c.createEl("p", {
			cls: "fp-step-desc",
			text: "A single hand-entered row — for cash spending or anything your bank export doesn't cover.",
		});

		const form = c.createDiv({ cls: "fp-form" });
		const store = this.plugin.store;

		const accountRow = form.createDiv({ cls: "fp-form-row" });
		accountRow.createEl("label", { text: "Account" });
		const accountSelect = accountRow.createEl("select");
		store.accounts.forEach((a) => accountSelect.createEl("option", { text: a.name, value: a.id }));
		accountSelect.value = this.accountId;
		accountSelect.addEventListener("change", () => (this.accountId = accountSelect.value));

		const dateRow = form.createDiv({ cls: "fp-form-row" });
		dateRow.createEl("label", { text: "Date" });
		const dateInput = dateRow.createEl("input", { type: "date" });
		dateInput.value = this.date;
		dateInput.addEventListener("change", () => (this.date = dateInput.value));

		const descRow = form.createDiv({ cls: "fp-form-row" });
		descRow.createEl("label", { text: "Description" });
		const descInput = descRow.createEl("input", { type: "text", attr: { placeholder: "e.g. Groceries at the market" } });
		descInput.addEventListener("input", () => (this.description = descInput.value));

		const cpRow = form.createDiv({ cls: "fp-form-row" });
		cpRow.createEl("label", { text: "Counterparty (optional)" });
		const cpInput = cpRow.createEl("input", { type: "text", attr: { placeholder: "Who was paid — drives auto-categorization" } });
		cpInput.addEventListener("input", () => (this.counterparty = cpInput.value));

		const amountRow = form.createDiv({ cls: "fp-form-row" });
		amountRow.createEl("label", { text: "Amount" });
		const amountWrap = amountRow.createDiv({ cls: "fp-manual-amount" });
		// Direction as an explicit toggle instead of a sign convention: nobody should have to
		// remember that expenses are negative in a form field.
		const dirWrap = amountWrap.createDiv({ cls: "fp-pill-toggle", attr: { role: "group", "aria-label": "Direction" } });
		const expenseBtn = dirWrap.createEl("button", { text: "Expense", attr: { type: "button", "aria-pressed": "true" } });
		const incomeBtn = dirWrap.createEl("button", { text: "Income", attr: { type: "button", "aria-pressed": "false" } });
		const setDirection = (d: "expense" | "income") => {
			this.direction = d;
			expenseBtn.setAttribute("aria-pressed", String(d === "expense"));
			incomeBtn.setAttribute("aria-pressed", String(d === "income"));
			expenseBtn.toggleClass("is-active", d === "expense");
			incomeBtn.toggleClass("is-active", d === "income");
		};
		expenseBtn.addEventListener("click", () => setDirection("expense"));
		incomeBtn.addEventListener("click", () => setDirection("income"));
		setDirection("expense");
		const amountInput = amountWrap.createEl("input", {
			type: "text",
			attr: { inputmode: "decimal", placeholder: "0,00 or 0.00", "aria-label": "Amount" },
		});
		amountInput.addEventListener("input", () => (this.amountRaw = amountInput.value));

		const catRow = form.createDiv({ cls: "fp-form-row" });
		catRow.createEl("label", { text: "Category" });
		const catSelect = catRow.createEl("select");
		catSelect.createEl("option", { text: "Auto (from your rules) / none", value: "" });
		store.categories
			.filter((cat) => !cat.archived)
			.forEach((cat) => catSelect.createEl("option", { text: cat.name, value: cat.id }));
		catSelect.addEventListener("change", () => (this.categoryId = catSelect.value));

		const notesRow = form.createDiv({ cls: "fp-form-row" });
		notesRow.createEl("label", { text: "Notes (optional)" });
		const notesInput = notesRow.createEl("input", { type: "text" });
		notesInput.addEventListener("input", () => (this.notes = notesInput.value));

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const cancel = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel", attr: { type: "button" } });
		cancel.addEventListener("click", () => this.close());
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const save = right.createEl("button", { cls: "fp-btn fp-btn-primary", attr: { type: "button" } });
		icon(save, "plus");
		save.createSpan({ text: "Add transaction" });
		save.addEventListener("click", () => void this.submit(save));

		descInput.focus();
	}

	private async submit(saveBtn: HTMLButtonElement): Promise<void> {
		const store = this.plugin.store;
		if (store.generation !== this.openedAtGeneration) {
			new Notice("Portfolio changed — reopen this dialog");
			this.close();
			return;
		}
		if (!this.accountId) {
			new Notice("Pick an account first");
			return;
		}
		if (!this.description.trim()) {
			new Notice("Give the transaction a description");
			return;
		}
		const amount = parseAmount(this.amountRaw);
		if (amount === undefined || amount <= 0) {
			new Notice("Enter an amount above zero — the Expense/Income toggle carries the sign");
			return;
		}
		if (!this.date) {
			new Notice("Pick a date");
			return;
		}
		saveBtn.disabled = true;

		const account = store.accounts.find((a) => a.id === this.accountId);
		const tx: Transaction = {
			id: `man-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			date: this.date,
			accountId: this.accountId,
			description: this.description.trim(),
			counterparty: this.counterparty.trim() || undefined,
			amount: this.direction === "expense" ? -amount : amount,
			currency: account?.currency ?? "EUR",
			categoryId: this.categoryId || undefined,
			source: "manual",
			notes: this.notes.trim() || undefined,
		};
		// "Auto" runs the same rules the import pipeline uses, so a hand-entered "Albert Heijn" lands
		// in the same category the CSV rows do.
		if (!tx.categoryId) tx.categoryId = applyRules(tx, store.rules);

		try {
			await store.importTransactions([tx]);
		} catch (err) {
			saveBtn.disabled = false;
			new Notice(`Could not save: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}
		new Notice(`Added ${tx.description}`);
		this.onSaved?.(tx);
		this.plugin.refreshViews();
		this.close();
	}

	onClose(): void {
		unregisterOpenModal(this);
		this.contentEl.empty();
	}
}
