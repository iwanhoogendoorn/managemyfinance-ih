import { App, Modal, Notice } from "obsidian";
import type FinancePlugin from "../main";
import { registerOpenModal, unregisterOpenModal } from "../modalRegistry";
import { icon } from "../ui/dom";

type ResetScope = "account" | "transactions" | "everything";

/** The word the user has to type before the two destructive scopes will run. Deliberately not "yes":
 *  it should be impossible to do this by reflex. */
const CONFIRM_WORD = "DELETE";

function timestamp(now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}${p(now.getMinutes())}`;
}

/**
 * Start over — with the scope as the first question, not an afterthought.
 *
 * "I want a smaller dataset" almost never means "throw away the category tree and the merchant rules
 * I built getting here", so clearing transactions while keeping everything else is the default and
 * the recommended path. A full reset is available but has to be chosen and then typed out.
 *
 * Every destructive run writes a timestamped copy of the data folder first, on by default, because
 * the entire dataset is plain text in the vault and a backup costs a second — turning an irreversible
 * action into a recoverable one for as long as the user keeps the folder.
 */
export class ResetDataModal extends Modal {
	private resetScope: ResetScope = "transactions";
	private accountId: string;
	private backup = true;

	constructor(app: App, private plugin: FinancePlugin) {
		super(app);
		this.accountId = plugin.settings.activeAccountId ?? plugin.store.accounts[0]?.id ?? "";
	}

	onOpen(): void {
		registerOpenModal(this);
		this.modalEl.addClass("fpih-wizard-modal");
		this.modalEl.addClass("fpih-root");
		this.render();
	}

	onClose(): void {
		unregisterOpenModal(this);
		this.contentEl.empty();
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();
		c.addClass("fpih-account-modal");

		c.createEl("h3", { text: "Start over" });
		c.createEl("p", {
			cls: "fpih-step-desc",
			text: "Everything this plugin stores lives as plain JSON and CSV in your vault, so this deletes files — nothing is sent anywhere, and a backup is taken first unless you turn it off.",
		});

		const store = this.plugin.store;
		const counts = store.summarize();

		const form = c.createDiv({ cls: "fpih-form" });

		/* ---------- scope ---------- */

		const scopeRow = form.createDiv({ cls: "fpih-form-row" });
		scopeRow.createEl("label", { text: "What to delete" });
		const scopeSelect = scopeRow.createEl("select", { cls: "fpih-select" });
		scopeSelect.createEl("option", { text: "Transactions only — keep accounts, categories and rules", value: "transactions" });
		if (store.accounts.length > 0) {
			scopeSelect.createEl("option", { text: "One account's transactions", value: "account" });
		}
		scopeSelect.createEl("option", { text: "Everything — back to a fresh install", value: "everything" });
		scopeSelect.value = this.resetScope;

		const accountRow = form.createDiv({ cls: "fpih-form-row" });
		accountRow.createEl("label", { text: "Account" });
		const accountSelect = accountRow.createEl("select", { cls: "fpih-select" });
		store.accounts.forEach((a) => accountSelect.createEl("option", { text: a.name, value: a.id }));
		accountSelect.value = this.accountId;
		accountSelect.addEventListener("change", () => {
			this.accountId = accountSelect.value;
			drawSummary();
		});

		/* ---------- what this will do ---------- */

		const summary = c.createDiv({ cls: "fpih-reset-summary" });
		const drawSummary = () => {
			summary.empty();
			accountRow.toggleClass("is-hidden", this.resetScope !== "account");

			const line = (label: string, value: string, kept = false) => {
				const row = summary.createDiv({ cls: "fpih-reset-line" + (kept ? " is-kept" : "") });
				icon(row, kept ? "check" : "trash-2");
				row.createSpan({ text: `${value} ${label}` });
			};

			if (this.resetScope === "account") {
				const account = store.accounts.find((a) => a.id === this.accountId);
				const scoped = store.summarize(this.accountId);
				line(`transactions from ${account?.name ?? "this account"}`, scoped.transactions.toLocaleString("en-IE"));
				line("the account itself, and every other account", "kept:", true);
				line("categories, rules, subscriptions and cards", "kept:", true);
			} else if (this.resetScope === "transactions") {
				line("transactions, across every account", counts.transactions.toLocaleString("en-IE"));
				line(`accounts (${counts.accounts}), categories (${counts.categories}) and rules (${counts.rules})`, "kept:", true);
				line(`subscriptions (${counts.subscriptions}) and cards (${counts.cards})`, "kept:", true);
			} else {
				line("transactions", counts.transactions.toLocaleString("en-IE"));
				line("accounts", counts.accounts.toLocaleString("en-IE"));
				line("auto-categorization rules", counts.rules.toLocaleString("en-IE"));
				line("subscriptions", counts.subscriptions.toLocaleString("en-IE"));
				line("cards", counts.cards.toLocaleString("en-IE"));
				line("categories reset to the standard set — any you added or renamed are lost", `${counts.categories} →`);
			}
		};

		/* ---------- backup ---------- */

		const backupRow = c.createDiv({ cls: "fpih-reset-backup" });
		const backupBox = backupRow.createEl("input", { type: "checkbox", attr: { id: "fpih-reset-backup" } });
		backupBox.checked = this.backup;
		backupRow.createEl("label", {
			text: `Copy everything to "${this.plugin.settings.dataFolder} (backup …)" in this vault first`,
			attr: { for: "fpih-reset-backup" },
		});
		backupBox.addEventListener("change", () => (this.backup = backupBox.checked));

		/* ---------- typed confirmation ---------- */

		const confirmRow = c.createDiv({ cls: "fpih-form-row fpih-reset-confirm" });
		confirmRow.createEl("label", { text: `Type ${CONFIRM_WORD} to confirm` });
		const confirmInput = confirmRow.createEl("input", { type: "text", attr: { placeholder: CONFIRM_WORD, autocomplete: "off" } });

		/* ---------- footer ---------- */

		const footer = c.createDiv({ cls: "fpih-wizard-footer" });
		const left = footer.createDiv({ cls: "fpih-wizard-footer-left" });
		const cancel = left.createEl("button", { cls: "fpih-btn fpih-btn-ghost", text: "Cancel", attr: { type: "button" } });
		cancel.addEventListener("click", () => this.close());

		const right = footer.createDiv({ cls: "fpih-wizard-footer-right" });
		const run = right.createEl("button", { cls: "fpih-btn fpih-btn-danger", attr: { type: "button" } });
		icon(run, "trash-2");
		const runLabel = run.createSpan({ text: "Delete" });

		const syncRunState = () => {
			run.disabled = confirmInput.value.trim().toUpperCase() !== CONFIRM_WORD;
			runLabel.setText(
				this.resetScope === "everything" ? "Delete everything" : this.resetScope === "account" ? "Delete this account's transactions" : "Delete all transactions"
			);
		};
		confirmInput.addEventListener("input", syncRunState);
		scopeSelect.addEventListener("change", () => {
			this.resetScope = scopeSelect.value as ResetScope;
			drawSummary();
			syncRunState();
		});

		run.addEventListener("click", () => void this.run(run));

		drawSummary();
		syncRunState();
		confirmInput.focus();
	}

	private async run(button: HTMLButtonElement): Promise<void> {
		const plugin = this.plugin;
		const store = plugin.store;
		button.disabled = true;

		try {
			let backupPath: string | undefined;
			if (this.backup) backupPath = await store.backupData(timestamp(new Date()));

			let removed = 0;
			if (this.resetScope === "account") {
				removed = await store.clearTransactions(this.accountId);
			} else if (this.resetScope === "transactions") {
				removed = await store.clearTransactions();
			} else {
				removed = store.summarize().transactions;
				await store.resetAll();
				// A fresh install should be greeted by first-run setup, and any pointer into data that
				// no longer exists has to go with it.
				plugin.settings.activeAccountId = undefined;
				plugin.settings.activeView = undefined;
				plugin.settings.onboardingCompleted = false;
				plugin.settings.dismissedInsightIds = [];
				plugin.settings.dismissedSubscriptionKeys = [];
				await plugin.saveSettings();
			}

			plugin.refreshViews();
			new Notice(
				`Deleted ${removed.toLocaleString("en-IE")} transaction${removed === 1 ? "" : "s"}` +
					(backupPath ? ` · backup saved to "${backupPath}"` : "")
			);
			this.close();
		} catch (err) {
			button.disabled = false;
			new Notice(`Couldn't complete: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
}

export function openResetData(plugin: FinancePlugin): void {
	new ResetDataModal(plugin.app, plugin).open();
}
