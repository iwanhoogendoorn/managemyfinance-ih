import { App, Modal, Notice } from "obsidian";
import { ACCOUNT_TYPE_META } from "../constants";
import { parseAmount } from "../format";
import type FinancePlugin from "../main";
import { registerOpenModal, unregisterOpenModal } from "../modalRegistry";
import type { Account, AccountType } from "../types";
import { icon } from "../ui/dom";

/**
 * Create-or-edit for one account. Creating adds an empty container whose transactions arrive via the
 * next import; editing (pass `existing`) changes the container's own fields in place. Type is freely
 * editable after creation — transactions reference the account by id only, so switching e.g. a
 * mis-created Debit to Saving just reroutes which dashboard renders it.
 */
export class CreateAccountModal extends Modal {
	private name = "";
	private type: AccountType = "debit";
	private iban = "";
	private openingBalance = "0";

	constructor(
		app: App,
		private plugin: FinancePlugin,
		private onCreated?: (account: Account) => void,
		private existing?: Account
	) {
		super(app);
		if (existing) {
			this.name = existing.name;
			this.type = existing.type;
			this.iban = existing.iban ?? "";
			this.openingBalance = String(existing.openingBalance ?? 0);
		}
	}

	onOpen(): void {
		// Registered so a portfolio switch can close it — see modalRegistry.
		registerOpenModal(this);
		this.modalEl.addClass("fpih-wizard-modal");
		const c = this.contentEl;
		c.addClass("fpih-account-modal");

		c.createEl("h3", { text: this.existing ? "Edit account" : "Create account" });
		c.createEl("p", {
			cls: "fpih-step-desc",
			text: this.existing
				? "Change this account's details — its transactions stay attached either way."
				: "A separate container for this account's transactions and totals — e.g. one per card or bank.",
		});

		const form = c.createDiv({ cls: "fpih-form" });

		const nameRow = form.createDiv({ cls: "fpih-form-row" });
		nameRow.createEl("label", { text: "Name" });
		const nameInput = nameRow.createEl("input", { type: "text", attr: { placeholder: "e.g. Amex Gold" } });
		nameInput.value = this.name;
		nameInput.addEventListener("input", () => (this.name = nameInput.value));

		const typeRow = form.createDiv({ cls: "fpih-form-row" });
		typeRow.createEl("label", { text: "Type" });
		const typeSelect = typeRow.createEl("select");
		(Object.keys(ACCOUNT_TYPE_META) as AccountType[]).forEach((t) => typeSelect.createEl("option", { text: ACCOUNT_TYPE_META[t].label, value: t }));
		typeSelect.value = this.type;
		typeSelect.addEventListener("change", () => (this.type = typeSelect.value as AccountType));

		const ibanRow = form.createDiv({ cls: "fpih-form-row" });
		ibanRow.createEl("label", { text: "IBAN (optional)" });
		const ibanInput = ibanRow.createEl("input", { type: "text", attr: { placeholder: "Auto-matches combined CSV/Excel exports" } });
		ibanInput.value = this.iban;
		ibanInput.addEventListener("input", () => (this.iban = ibanInput.value));

		const balRow = form.createDiv({ cls: "fpih-form-row" });
		balRow.createEl("label", { text: "Opening balance" });
		// Text + inputmode, not type="number": a number input either rejects a Dutch "30,27" outright
		// (en locale → field goes empty → balance silently saved as 0) or re-localizes it invisibly.
		// parseAmount reads both decimal conventions explicitly.
		const balInput = balRow.createEl("input", { type: "text", attr: { inputmode: "decimal", placeholder: "0,00 or 0.00" } });
		balInput.value = this.openingBalance;
		balInput.addEventListener("input", () => (this.openingBalance = balInput.value));

		const footer = c.createDiv({ cls: "fpih-wizard-footer" });
		const left = footer.createDiv({ cls: "fpih-wizard-footer-left" });
		const cancel = left.createEl("button", { cls: "fpih-btn fpih-btn-ghost", text: "Cancel" });
		cancel.addEventListener("click", () => this.close());

		const right = footer.createDiv({ cls: "fpih-wizard-footer-right" });
		const create = right.createEl("button", { cls: "fpih-btn fpih-btn-primary" });
		icon(create, this.existing ? "check" : "plus");
		create.createSpan({ text: this.existing ? "Save changes" : "Create account" });
		create.addEventListener("click", () => void this.submit());

		nameInput.focus();
	}

	private async submit(): Promise<void> {
		if (!this.name.trim()) {
			new Notice("Give the account a name first");
			return;
		}
		if (this.existing) {
			// Mutating the account object in place is deliberate: transactions reference the id, and
			// none of the fields edited here feed the transfer-pair memoisation (which keys on the
			// transactions array, not accounts).
			this.existing.name = this.name.trim();
			this.existing.type = this.type;
			this.existing.openingBalance = parseAmount(this.openingBalance) ?? 0;
			this.existing.iban = this.iban.trim() || undefined;
			await this.plugin.store.saveAccounts();
			new Notice(`Updated "${this.existing.name}"`);
			this.onCreated?.(this.existing);
			this.plugin.refreshViews();
			this.close();
			return;
		}
		const account: Account = {
			id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			name: this.name.trim(),
			type: this.type,
			currency: "EUR",
			openingBalance: parseAmount(this.openingBalance) ?? 0,
			iban: this.iban.trim() || undefined,
		};
		this.plugin.store.accounts.push(account);
		await this.plugin.store.saveAccounts();
		new Notice(`Created account "${account.name}"`);
		this.onCreated?.(account);
		this.plugin.refreshViews();
		this.close();
	}

	onClose(): void {
		unregisterOpenModal(this);
		this.contentEl.empty();
	}
}
