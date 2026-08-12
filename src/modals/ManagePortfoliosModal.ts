import { App, Modal, Notice } from "obsidian";
import type FinancePlugin from "../main";
import { icon } from "../ui/dom";
import { openCreatePortfolioWizard } from "../wizards/PortfolioWizard";
import { ConfirmDeletePortfolioModal } from "./ConfirmDeletePortfolioModal";

/** Full portfolio roster: rename in place, add via the wizard, remove from the list (files on disk are left untouched). */
export class ManagePortfoliosModal extends Modal {
	constructor(app: App, private plugin: FinancePlugin, private onChange?: () => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("fpih-wizard-modal");
		this.render();
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();
		c.addClass("fpih-account-modal");

		const head = c.createDiv({ cls: "fpih-detail-header" });
		head.createDiv({ cls: "fpih-detail-desc", text: "Manage portfolios" });
		const addBtn = head.createEl("button", { cls: "fpih-btn fpih-btn-primary" });
		icon(addBtn, "plus");
		addBtn.createSpan({ text: "New portfolio" });
		addBtn.addEventListener("click", () => {
			this.close();
			openCreatePortfolioWizard(this.plugin, () => this.onChange?.());
		});

		const portfolios = this.plugin.settings.portfolios ?? [];
		const list = c.createDiv({ cls: "fpih-account-list" });
		portfolios.forEach((p) => {
			const row = list.createDiv({ cls: "fpih-account-row" });
			icon(row, "briefcase", "fpih-account-row-icon");
			const nameInput = row.createEl("input", { type: "text" });
			nameInput.value = p.name;
			nameInput.addEventListener("change", () => void this.rename(p.id, nameInput.value));

			if (p.id === this.plugin.settings.activePortfolioId) {
				row.createDiv({ cls: "fpih-account-row-meta", text: "Active" });
			}

			const removeBtn = row.createEl("button", { cls: "fpih-btn fpih-btn-ghost fpih-btn-icon" });
			icon(removeBtn, "x");
			removeBtn.addEventListener("click", () => this.remove(p.id, p.name, p.folder));
		});

		c.createEl("p", {
			cls: "fpih-step-desc",
			text: "Removing a portfolio asks whether to keep or delete its folder — nothing happens without confirming.",
		});

		const footer = c.createDiv({ cls: "fpih-wizard-footer" });
		const right = footer.createDiv({ cls: "fpih-wizard-footer-right" });
		const closeBtn = right.createEl("button", { cls: "fpih-btn fpih-btn-primary" });
		icon(closeBtn, "check");
		closeBtn.createSpan({ text: "Done" });
		closeBtn.addEventListener("click", () => this.close());
	}

	private async rename(id: string, name: string): Promise<void> {
		if (!name.trim()) return;
		await this.plugin.renamePortfolio(id, name);
		this.onChange?.();
	}

	private remove(id: string, name: string, folder: string): void {
		const portfolios = this.plugin.settings.portfolios ?? [];
		if (portfolios.length <= 1) {
			new Notice("You need at least one portfolio.");
			return;
		}
		new ConfirmDeletePortfolioModal(this.app, name, folder, (deleteData) => {
			void (async () => {
				await this.plugin.deletePortfolio(id, { deleteData });
				new Notice(deleteData ? `Removed "${name}" and moved its folder to trash` : `Removed "${name}" from your portfolio list`);
				this.render();
				this.onChange?.();
			})();
		}).open();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
