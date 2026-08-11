import { App, Modal, Notice } from "obsidian";
import type FinancePlugin from "../main";
import { registerOpenModal, unregisterOpenModal } from "../modalRegistry";
import type { Category } from "../types";
import { categoryChip, icon } from "../ui/dom";

/** A readable default palette for new categories — cycled by position so two categories created back
 *  to back don't come out the same colour, without asking anyone to pick a hex code they don't care
 *  about. Same hues the seeded set uses. */
const PALETTE = [
	"#3b82f6", "#ef4444", "#f97316", "#a855f7", "#16a34a", "#0ea5e9",
	"#ec4899", "#eab308", "#14b8a6", "#8b5cf6", "#f59e0b", "#64748b",
];

function slugify(name: string): string {
	return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "category";
}

/**
 * Create, rename, recolour, re-icon and retire categories.
 *
 * This did not exist at all: the 26 categories were seeded on first load and the only way to add a
 * 27th was to hand-edit `categories.json` in the vault. Budgets could edit a category's *limit*, and
 * nothing anywhere could edit the category itself.
 *
 * Deleting is deliberately the harder path. A category with transactions on it can only be archived
 * (hidden from every picker, existing rows untouched) unless the user explicitly accepts
 * uncategorizing those rows — silently orphaning a categoryId would leave the ledger pointing at
 * something that no longer exists, which renders as a raw id and looks like data loss.
 */
export class CategoryManagerModal extends Modal {
	constructor(app: App, private plugin: FinancePlugin) {
		super(app);
	}

	onOpen(): void {
		registerOpenModal(this);
		this.modalEl.addClass("fp-wizard-modal");
		this.modalEl.addClass("fp-root");
		this.render();
	}

	onClose(): void {
		unregisterOpenModal(this);
		this.contentEl.empty();
	}

	private usageOf(categoryId: string): number {
		return this.plugin.store.transactions.filter((t) => t.categoryId === categoryId).length;
	}

	/** `refreshViews()` rebuilds every open Finance view from the store, which is exactly what a
	 *  category rename/recolour/delete needs — chips, pickers and per-category figures all read it.
	 *  The modal itself lives outside that DOM, so it survives its own refresh. */
	private async persist(): Promise<void> {
		await this.plugin.store.saveCategories();
		this.plugin.refreshViews();
	}

	private render(): void {
		const c = this.contentEl;
		c.empty();
		c.addClass("fp-account-modal");
		c.addClass("fp-category-manager");

		const head = c.createDiv({ cls: "fp-detail-header" });
		head.createDiv({ cls: "fp-detail-desc", text: "Manage categories" });
		const addBtn = head.createEl("button", { cls: "fp-btn fp-btn-primary", attr: { type: "button" } });
		icon(addBtn, "plus");
		addBtn.createSpan({ text: "New category" });
		addBtn.addEventListener("click", () => this.renderEditor());

		const store = this.plugin.store;
		const active = store.categories.filter((cat) => !cat.archived);
		const archived = store.categories.filter((cat) => cat.archived);

		const list = c.createDiv({ cls: "fp-category-list" });
		if (active.length === 0) {
			list.createDiv({ cls: "fp-step-desc", text: "No categories yet — add one above." });
		}
		active.forEach((cat) => this.renderRow(list, cat));

		if (archived.length > 0) {
			c.createDiv({ cls: "fp-category-archived-head", text: `Archived (${archived.length}) — hidden from pickers, existing transactions keep them` });
			const archivedList = c.createDiv({ cls: "fp-category-list" });
			archived.forEach((cat) => this.renderRow(archivedList, cat, { archived: true }));
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const done = right.createEl("button", { cls: "fp-btn fp-btn-primary", attr: { type: "button" } });
		icon(done, "check");
		done.createSpan({ text: "Done" });
		done.addEventListener("click", () => this.close());
	}

	private renderRow(parent: HTMLElement, cat: Category, opts: { archived?: boolean } = {}): void {
		const used = this.usageOf(cat.id);
		const row = parent.createDiv({ cls: "fp-category-row" });

		const main = row.createDiv({ cls: "fp-category-row-main" });
		categoryChip(main, cat.name, cat.color, cat.icon);
		main.createSpan({
			cls: "fp-category-row-meta",
			text: used === 0 ? "unused" : `${used.toLocaleString("en-IE")} transaction${used === 1 ? "" : "s"}`,
		});

		const actions = row.createDiv({ cls: "fp-category-row-actions" });

		const edit = actions.createEl("button", {
			cls: "fp-btn fp-btn-ghost fp-btn--icon",
			attr: { type: "button", "aria-label": `Edit ${cat.name}`, title: "Edit name, colour and icon" },
		});
		icon(edit, "pencil");
		edit.addEventListener("click", () => this.renderEditor(cat));

		const archiveBtn = actions.createEl("button", {
			cls: "fp-btn fp-btn-ghost fp-btn--icon",
			attr: {
				type: "button",
				"aria-label": opts.archived ? `Restore ${cat.name}` : `Archive ${cat.name}`,
				title: opts.archived ? "Restore to the pickers" : "Hide from pickers, keep on existing transactions",
			},
		});
		icon(archiveBtn, opts.archived ? "archive-restore" : "archive");
		archiveBtn.addEventListener("click", () => {
			void (async () => {
				const target = this.plugin.store.categories.find((x) => x.id === cat.id);
				if (!target) return;
				target.archived = opts.archived ? undefined : true;
				await this.persist();
				this.render();
			})();
		});

		const del = actions.createEl("button", {
			cls: "fp-btn fp-btn-ghost fp-btn--icon",
			attr: { type: "button", "aria-label": `Delete ${cat.name}`, title: used > 0 ? `Used by ${used} transactions` : "Delete" },
		});
		icon(del, "trash-2");
		del.addEventListener("click", () => this.confirmDelete(cat, used));
	}

	/** New-category and edit-category share one form — the only difference is whether it starts blank. */
	private renderEditor(existing?: Category): void {
		const c = this.contentEl;
		c.empty();

		c.createEl("h3", { text: existing ? "Edit category" : "New category" });

		const store = this.plugin.store;
		let name = existing?.name ?? "";
		let color = existing?.color ?? PALETTE[store.categories.length % PALETTE.length];
		let iconName = existing?.icon ?? "tag";

		const form = c.createDiv({ cls: "fp-form" });

		const preview = c.createDiv({ cls: "fp-category-preview" });
		const drawPreview = () => {
			preview.empty();
			preview.createSpan({ cls: "fp-category-preview-label", text: "Preview" });
			categoryChip(preview, name.trim() || "Category name", color, iconName);
		};

		const nameRow = form.createDiv({ cls: "fp-form-row" });
		nameRow.createEl("label", { text: "Name" });
		const nameInput = nameRow.createEl("input", { type: "text", attr: { placeholder: "e.g. Hobbies" } });
		nameInput.value = name;
		nameInput.addEventListener("input", () => {
			name = nameInput.value;
			drawPreview();
		});

		const colorRow = form.createDiv({ cls: "fp-form-row" });
		colorRow.createEl("label", { text: "Colour" });
		const colorInput = colorRow.createEl("input", { type: "color", cls: "fp-category-color" });
		colorInput.value = color;
		colorInput.addEventListener("input", () => {
			color = colorInput.value;
			drawPreview();
		});

		const iconRow = form.createDiv({ cls: "fp-form-row" });
		iconRow.createEl("label", { text: "Icon" });
		const iconInput = iconRow.createEl("input", { type: "text", attr: { placeholder: "tag" } });
		iconInput.value = iconName;
		iconInput.addEventListener("input", () => {
			iconName = iconInput.value.trim() || "tag";
			drawPreview();
		});
		iconRow.createDiv({
			cls: "fp-form-hint",
			// Obsidian ships Lucide, so any Lucide name works — but only the name, and a wrong one
			// silently renders nothing, so say where the list lives.
			text: "Any Lucide icon name (lucide.dev) — e.g. tag, plane, dumbbell, gamepad-2.",
		});

		drawPreview();

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const cancel = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel", attr: { type: "button" } });
		cancel.addEventListener("click", () => this.render());

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		const save = right.createEl("button", { cls: "fp-btn fp-btn-primary", attr: { type: "button" } });
		icon(save, "check");
		save.createSpan({ text: existing ? "Save changes" : "Create category" });
		save.addEventListener("click", () => {
			void (async () => {
				const trimmed = name.trim();
				if (!trimmed) {
					new Notice("Give the category a name first");
					return;
				}
				const clash = store.categories.find(
					(x) => x.id !== existing?.id && x.name.trim().toLowerCase() === trimmed.toLowerCase()
				);
				if (clash) {
					new Notice(`"${clash.name}" already exists`);
					return;
				}

				if (existing) {
					const target = store.categories.find((x) => x.id === existing.id);
					if (!target) return;
					target.name = trimmed;
					target.color = color;
					target.icon = iconName;
				} else {
					store.categories.push({
						id: `cat-user-${slugify(trimmed)}-${Math.random().toString(36).slice(2, 6)}`,
						name: trimmed,
						color,
						icon: iconName,
						aliases: [],
					});
				}
				await this.persist();
				new Notice(existing ? `Updated "${trimmed}"` : `Created "${trimmed}"`);
				this.render();
			})();
		});

		nameInput.focus();
	}

	private confirmDelete(cat: Category, used: number): void {
		const c = this.contentEl;
		c.empty();

		c.createEl("h3", { text: `Delete "${cat.name}"?` });

		if (used === 0) {
			c.createEl("p", { cls: "fp-step-desc", text: "Nothing uses this category, so deleting it changes no transactions." });
		} else {
			c.createEl("p", {
				cls: "fp-step-desc",
				text: `${used.toLocaleString("en-IE")} transaction${used === 1 ? " uses" : "s use"} this category. Deleting it will leave ${
					used === 1 ? "that transaction" : "those transactions"
				} uncategorized — the amounts are untouched, but they'll drop out of every per-category figure until you re-assign them.`,
			});
			c.createEl("p", {
				cls: "fp-step-desc",
				text: "Archiving instead hides it from every picker while leaving those transactions exactly as they are — usually what you actually want.",
			});
		}

		const footer = c.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const cancel = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel", attr: { type: "button" } });
		cancel.addEventListener("click", () => this.render());

		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
		if (used > 0 && !cat.archived) {
			const archive = right.createEl("button", { cls: "fp-btn fp-btn-secondary", attr: { type: "button" } });
			icon(archive, "archive");
			archive.createSpan({ text: "Archive instead" });
			archive.addEventListener("click", () => {
				void (async () => {
					const target = this.plugin.store.categories.find((x) => x.id === cat.id);
					if (!target) return;
					target.archived = true;
					await this.persist();
					new Notice(`Archived "${cat.name}"`);
					this.render();
				})();
			});
		}
		const del = right.createEl("button", { cls: "fp-btn fp-btn-danger", attr: { type: "button" } });
		icon(del, "trash-2");
		del.createSpan({ text: used > 0 ? `Delete and uncategorize ${used}` : "Delete" });
		del.addEventListener("click", () => {
			void (async () => {
				const store = this.plugin.store;
				if (used > 0) {
					// Clear the pointer on every affected row in one batched ledger write, so no
					// transaction is ever left referencing a category that no longer exists.
					const patches = new Map<string, string | undefined>();
					store.transactions.forEach((t) => {
						if (t.categoryId === cat.id) patches.set(t.id, undefined);
					});
					await store.recategorize(patches);
				}
				// Rules pointing at a deleted category would silently re-apply it on the next import.
				const staleRules = store.rules.filter((r) => r.categoryId === cat.id);
				if (staleRules.length > 0) {
					store.rules = store.rules.filter((r) => r.categoryId !== cat.id);
					await store.saveRules();
				}
				store.categories = store.categories.filter((x) => x.id !== cat.id);
				await this.persist();
				new Notice(
					`Deleted "${cat.name}"` +
						(used > 0 ? ` · ${used} transaction${used === 1 ? "" : "s"} uncategorized` : "") +
						(staleRules.length > 0 ? ` · ${staleRules.length} rule${staleRules.length === 1 ? "" : "s"} removed` : "")
				);
				this.render();
			})();
		});
	}
}

export function openCategoryManager(plugin: FinancePlugin): void {
	new CategoryManagerModal(plugin.app, plugin).open();
}
