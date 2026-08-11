import { App, FuzzySuggestModal, Modal, Notice } from "obsidian";
import { formatMoney } from "../format";
import { applyRules } from "../import/categorize";
import type FinancePlugin from "../main";
import { registerOpenModal, unregisterOpenModal } from "../modalRegistry";
import { buildUserRule, deriveRulePattern, groupByMerchant, rankCategories, ruleReach, sortGroups, type GroupSort, type MerchantGroup } from "../reviewQueue";
import type { Category, CategoryRule, Transaction } from "../types";
import { categoryChip, emptyState, icon } from "../ui/dom";

/** Transactions shown inline before the card collapses into "+ N more". */
const PREVIEW_ROWS = 3;
/** The number keys are 1–9; ten would need two keystrokes and stop being a number key. */
const RANKED_SLOTS = 9;

export interface ReviewQueueOptions {
	/** Restrict the queue to these transaction ids — how the import summary scopes it to one import. */
	transactionIds?: Set<string>;
	/** Restrict to one account. */
	accountId?: string;
	title?: string;
}

/** One completed assignment, kept so `U` can put it back exactly as it was. */
interface UndoEntry {
	groupIndex: number;
	/** Previous categoryId per transaction — `undefined` for a row that had none, which is the norm. */
	previous: Map<string, string | undefined>;
	rule?: CategoryRule;
}

/** Fuzzy category picker — the same idiom the transaction detail modal already uses for vault files. */
class CategorySuggestModal extends FuzzySuggestModal<Category> {
	constructor(app: App, private categories: Category[], private onPick: (category: Category) => void) {
		super(app);
		this.setPlaceholder("Search all categories…");
	}
	getItems(): Category[] {
		return this.categories;
	}
	getItemText(category: Category): string {
		return category.name;
	}
	onChooseItem(category: Category): void {
		this.onPick(category);
	}
}

/**
 * Flow B6 — bulk triage of uncategorized transactions, one merchant at a time.
 *
 * The unit of work is the *merchant*, not the transaction: 312 uncategorized rows are ~23 decisions,
 * and each decision is one batched `store.recategorize()` — one ledger-file rewrite per merchant
 * rather than one per row.
 *
 * Keyboard-first by design, because this is the one screen in the plugin someone spends ten minutes
 * in. Handlers hang off the modal's own `Scope`, so they are live exactly while the modal is open and
 * are torn down with it — no document-level listeners to leak.
 */
export class ReviewQueueModal extends Modal {
	private groups: MerchantGroup[] = [];
	private index = 0;
	private sort: GroupSort = "count";
	private ranked: Category[] = [];
	private makeRule = true;
	private undoStack: UndoEntry[] = [];
	private assignedTxCount = 0;
	/**
	 * Merchant *keys* skipped, not a running count. `undo()` rewinds the index past merchants that were
	 * skipped on the way, so passing them a second time double-counted them; re-sorting rebuilds the
	 * queue from scratch and re-offers them too. A set of keys survives both.
	 */
	private skippedKeys = new Set<string>();
	/**
	 * Rules created in this session, in creation order. Its own state rather than a filter over the
	 * undo stack, because re-sorting mid-queue clears that stack — after which the summary claimed "0
	 * rules created" and hid the apply button, for rules that were already saved to disk.
	 */
	private sessionRules: CategoryRule[] = [];
	private busy = false;
	/** The store's world when this queue was built — its transaction ids and rules belong to it. */
	private openedAtGeneration = 0;
	/** Uncategorized rows in scope, including any the grouper had to drop for having no merchant text
	 *  at all — so the empty state can tell the truth about which of the two it is. */
	private poolSize = 0;
	private bodyEl!: HTMLElement;

	constructor(app: App, private plugin: FinancePlugin, private opts: ReviewQueueOptions = {}) {
		super(app);
	}

	onOpen(): void {
		// Registered so a portfolio switch can close it — see modalRegistry.
		registerOpenModal(this);
		this.modalEl.addClass("fp-wizard-modal");
		this.modalEl.addClass("fp-root");
		this.modalEl.addClass("fp-review-modal");
		this.contentEl.addClass("fp-review-queue");

		this.openedAtGeneration = this.plugin.store.generation;
		this.groups = this.buildQueue();
		this.bodyEl = this.contentEl.createDiv({ cls: "fp-review-body" });
		this.registerKeys();
		this.render();
	}

	onClose(): void {
		unregisterOpenModal(this);
		this.contentEl.empty();
	}

	private buildQueue(): MerchantGroup[] {
		const pool = this.plugin.store.transactions.filter((tx) => {
			if (tx.categoryId) return false;
			if (this.opts.transactionIds && !this.opts.transactionIds.has(tx.id)) return false;
			if (this.opts.accountId && tx.accountId !== this.opts.accountId) return false;
			return true;
		});
		this.poolSize = pool.length;
		return sortGroups(groupByMerchant(pool), this.sort);
	}

	private get current(): MerchantGroup | undefined {
		return this.groups[this.index];
	}

	// ---------- keyboard ----------

	private registerKeys(): void {
		for (let n = 1; n <= RANKED_SLOTS; n++) {
			this.scope.register([], String(n), (ev) => {
				const category = this.ranked[n - 1];
				if (!category) return;
				ev.preventDefault();
				void this.assign(category.id);
			});
		}
		this.scope.register([], "/", (ev) => {
			ev.preventDefault();
			this.openSearch();
		});
		this.scope.register([], "r", (ev) => {
			ev.preventDefault();
			this.makeRule = !this.makeRule;
			this.render();
		});
		this.scope.register([], "s", (ev) => {
			ev.preventDefault();
			this.skip();
		});
		this.scope.register([], "ArrowRight", (ev) => {
			ev.preventDefault();
			this.skip();
		});
		this.scope.register([], "u", (ev) => {
			ev.preventDefault();
			void this.undo();
		});
	}

	private openSearch(): void {
		const categories = this.plugin.store.categories.filter((c) => !c.archived);
		new CategorySuggestModal(this.app, categories, (category) => void this.assign(category.id)).open();
	}

	// ---------- actions ----------

	private rulePattern(group: MerchantGroup): string | undefined {
		return deriveRulePattern(group.transactions);
	}

	private async assign(categoryId: string): Promise<void> {
		const group = this.current;
		if (!group || this.busy) return;
		// Backstop for a portfolio switch (`switchPortfolio` closes open dialogs first): these
		// transaction ids belong to the portfolio that was loaded when the queue was built. Against a
		// different one they match nothing — and the derived rule would still be written to its
		// rules.json.
		if (this.plugin.store.generation !== this.openedAtGeneration) {
			new Notice("Portfolio changed — reopen this dialog");
			this.close();
			return;
		}
		this.busy = true;
		try {
			const store = this.plugin.store;
			const previous = new Map<string, string | undefined>();
			const patches = new Map<string, string | undefined>();
			for (const tx of group.transactions) {
				previous.set(tx.id, tx.categoryId);
				patches.set(tx.id, categoryId);
			}
			await store.recategorize(patches);

			let rule: CategoryRule | undefined;
			const pattern = this.makeRule ? this.rulePattern(group) : undefined;
			if (pattern && !store.rules.some((r) => r.pattern === pattern && r.categoryId === categoryId)) {
				rule = buildUserRule(pattern, categoryId);
				store.rules.push(rule);
				await store.saveRules();
				this.sessionRules.push(rule);
			}

			this.undoStack.push({ groupIndex: this.index, previous, rule });
			// A merchant you skipped and then came back to and categorized is not a skip.
			this.skippedKeys.delete(group.key);
			this.assignedTxCount += group.transactions.length;
			this.plugin.refreshViews();
			this.index++;
			this.render();
		} finally {
			this.busy = false;
		}
	}

	private skip(): void {
		const group = this.current;
		if (!group) return;
		this.skippedKeys.add(group.key);
		this.index++;
		this.render();
	}

	private async undo(): Promise<void> {
		// Same guard as `assign`: putting the old categories back is a write too, and against another
		// portfolio's ledger it would strip categories from rows that were never touched here.
		if (this.plugin.store.generation !== this.openedAtGeneration) {
			new Notice("Portfolio changed — reopen this dialog");
			this.close();
			return;
		}
		const entry = this.undoStack.pop();
		if (!entry || this.busy) return;
		this.busy = true;
		try {
			const store = this.plugin.store;
			await store.recategorize(entry.previous);
			if (entry.rule) {
				// By id, which `buildUserRule` makes unique per rule object — a pre-existing rule with
				// the same pattern is somebody else's and stays.
				store.rules = store.rules.filter((r) => r.id !== entry.rule!.id);
				await store.saveRules();
				this.sessionRules = this.sessionRules.filter((r) => r.id !== entry.rule!.id);
			}
			this.assignedTxCount -= entry.previous.size;
			this.index = entry.groupIndex;
			this.plugin.refreshViews();
			this.render();
		} finally {
			this.busy = false;
		}
	}

	// ---------- render ----------

	private render(): void {
		this.bodyEl.empty();
		const group = this.current;

		if (this.groups.length === 0) {
			emptyState(this.bodyEl, {
				iconName: "check-check",
				title: this.poolSize === 0 ? "Nothing to review" : "Nothing groupable to review",
				description:
					this.poolSize === 0
						? "Every transaction in scope already has a category."
						: `${this.poolSize} uncategorized transaction${this.poolSize === 1 ? "" : "s"} carry no merchant or description text, so they can't be grouped. Categorize them from the ledger.`,
				actionLabel: "Close",
				onAction: () => this.close(),
			});
			return;
		}

		if (!group) {
			this.renderDone();
			return;
		}

		this.ranked = rankCategories({
			merchantKey: group.key,
			accountId: group.dominantAccountId,
			transactions: this.plugin.store.transactions,
			categories: this.plugin.store.categories,
			limit: RANKED_SLOTS,
		});

		this.renderHeader();
		this.renderCard(group);
		this.renderFooter();
	}

	private renderHeader(): void {
		const head = this.bodyEl.createDiv({ cls: "fp-review-head" });
		const titleCol = head.createDiv();
		titleCol.createDiv({ cls: "fp-review-title", text: this.opts.title ?? "Review uncategorized" });
		titleCol.createDiv({
			cls: "fp-review-progress-label",
			text: `${this.index + 1} of ${this.groups.length} merchants`,
		});

		const sortBtn = head.createEl("button", {
			cls: "fp-btn fp-btn--chip fp-btn-chip",
			text: this.sort === "count" ? "Most transactions" : "Largest amount",
			attr: { type: "button", title: "Order the queue by transaction count or by total amount" },
		});
		sortBtn.addEventListener("click", () => {
			this.sort = this.sort === "count" ? "amount" : "count";
			// Rebuilt from the *remaining* uncategorized rows, so re-sorting mid-queue never re-offers
			// a merchant that was already handled. The undo stack goes with it — its `groupIndex`es
			// point into the old order — but the session totals (`sessionRules`, `skippedKeys`,
			// `assignedTxCount`) are about work already done and survive.
			this.groups = this.buildQueue();
			this.index = 0;
			this.undoStack = [];
			this.render();
		});

		const track = this.bodyEl.createDiv({ cls: "fp-review-track" });
		const fill = track.createDiv({ cls: "fp-review-track-fill" });
		fill.style.width = `${Math.round((this.index / this.groups.length) * 100)}%`;
	}

	private renderCard(group: MerchantGroup): void {
		const card = this.bodyEl.createDiv({ cls: "fp-review-card fp-card" });

		const top = card.createDiv({ cls: "fp-review-merchant" });
		top.createDiv({ cls: "fp-review-merchant-name fp-sensitive", text: group.displayName });
		const meta = top.createDiv({ cls: "fp-review-merchant-meta" });
		meta.createSpan({ text: `${group.transactions.length} transaction${group.transactions.length === 1 ? "" : "s"} · ` });
		meta.createSpan({ cls: "fp-money", text: formatMoney(group.total) });
		if (group.firstSeen) meta.createSpan({ text: ` · ${group.firstSeen} – ${group.lastSeen}` });

		const list = card.createDiv({ cls: "fp-review-tx-list" });
		const shown = [...group.transactions].reverse().slice(0, PREVIEW_ROWS);
		shown.forEach((tx: Transaction) => {
			const row = list.createDiv({ cls: "fp-review-tx" });
			row.createSpan({ cls: "fp-review-tx-date", text: tx.date });
			row.createSpan({ cls: "fp-review-tx-desc fp-sensitive", text: tx.description });
			row.createSpan({
				cls: "fp-review-tx-amount fp-money " + (tx.amount < 0 ? "is-negative" : "is-positive"),
				text: formatMoney(tx.amount, tx.currency || "EUR"),
			});
		});
		if (group.transactions.length > shown.length) {
			list.createDiv({ cls: "fp-review-tx-more", text: `+ ${group.transactions.length - shown.length} more` });
		}

		const keys = card.createDiv({ cls: "fp-review-keys" });
		this.ranked.forEach((category, i) => {
			const btn = keys.createEl("button", { cls: "fp-review-key", attr: { type: "button" } });
			btn.createSpan({ cls: "fp-review-key-num", text: String(i + 1) });
			categoryChip(btn, category.name, category.color, category.icon);
			btn.addEventListener("click", () => void this.assign(category.id));
		});
		const searchBtn = keys.createEl("button", { cls: "fp-review-key fp-review-key--search", attr: { type: "button" } });
		searchBtn.createSpan({ cls: "fp-review-key-num", text: "/" });
		searchBtn.createSpan({ text: "Search all categories" });
		searchBtn.addEventListener("click", () => this.openSearch());

		const pattern = this.rulePattern(group);
		const ruleRow = card.createEl("label", { cls: "fp-review-rule" });
		const check = ruleRow.createEl("input", { type: "checkbox" });
		check.checked = this.makeRule && !!pattern;
		check.disabled = !pattern;
		check.addEventListener("change", () => (this.makeRule = check.checked));
		ruleRow.createSpan({ cls: "fp-review-rule-key", text: "R" });
		if (pattern) {
			const reach = ruleReach(pattern, this.plugin.store.transactions);
			ruleRow.createSpan({
				text: `Create a rule for "${pattern}" so this is automatic next time${reach > group.transactions.length ? ` (also matches ${reach - group.transactions.length} other transaction${reach - group.transactions.length === 1 ? "" : "s"})` : ""}`,
			});
		} else {
			ruleRow.createSpan({ text: "These rows don't share enough text to build a rule that would reliably fire" });
		}
	}

	private renderFooter(): void {
		const footer = this.bodyEl.createDiv({ cls: "fp-wizard-footer fp-review-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });

		const undoBtn = left.createEl("button", { cls: "fp-btn fp-btn--ghost fp-btn-ghost", attr: { type: "button" } });
		undoBtn.createSpan({ cls: "fp-review-kbd", text: "U" });
		undoBtn.createSpan({ text: "Undo" });
		undoBtn.disabled = this.undoStack.length === 0;
		undoBtn.addEventListener("click", () => void this.undo());

		const skipBtn = right.createEl("button", { cls: "fp-btn fp-btn--secondary fp-btn-secondary", attr: { type: "button" } });
		skipBtn.createSpan({ cls: "fp-review-kbd", text: "S" });
		skipBtn.createSpan({ text: "Skip" });
		skipBtn.addEventListener("click", () => this.skip());

		const closeBtn = right.createEl("button", { cls: "fp-btn fp-btn--ghost fp-btn-ghost", attr: { type: "button" } });
		closeBtn.createSpan({ cls: "fp-review-kbd", text: "Esc" });
		closeBtn.createSpan({ text: "Close" });
		closeBtn.addEventListener("click", () => this.close());

		this.bodyEl.createDiv({
			cls: "fp-review-hint",
			text: "1–9 assign · / search · R toggle rule · S skip · U undo · Esc close — everything applied stays applied",
		});
	}

	/** Every still-uncategorized transaction one of *this session's* rules would claim, and the category
	 *  it would get. Pure — computing it is also what lets the button state the size of what it does. */
	private sessionRulePatches(): Map<string, string | undefined> {
		const patches = new Map<string, string | undefined>();
		if (this.sessionRules.length === 0) return patches;
		for (const tx of this.plugin.store.transactions) {
			if (tx.categoryId) continue;
			const categoryId = applyRules(tx, this.sessionRules);
			if (categoryId) patches.set(tx.id, categoryId);
		}
		return patches;
	}

	private renderDone(): void {
		const rulesCreated = this.sessionRules.length;
		const skipped = this.skippedKeys.size;
		const wrap = this.bodyEl.createDiv({ cls: "fp-review-done" });
		const head = wrap.createDiv({ cls: "fp-review-done-head" });
		icon(head, "check-check", "fp-review-done-icon");
		head.createDiv({ cls: "fp-review-title", text: "All caught up" });
		wrap.createDiv({
			cls: "fp-step-desc",
			text: `${this.assignedTxCount} transaction${this.assignedTxCount === 1 ? "" : "s"} categorized · ${rulesCreated} rule${rulesCreated === 1 ? "" : "s"} created · ${skipped} skipped`,
		});

		const footer = wrap.createDiv({ cls: "fp-wizard-footer" });
		const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
		const right = footer.createDiv({ cls: "fp-wizard-footer-right" });

		if (rulesCreated > 0) {
			wrap.createDiv({
				cls: "fp-step-desc",
				text: `Your ${rulesCreated} new rule${rulesCreated === 1 ? "" : "s"} will apply automatically to future imports.`,
			});
			// "Them" is this session's rules — it used to run the *entire* rule set, including the ~200
			// seeded merchant rules, so one click could recategorize hundreds of rows nobody asked about
			// and nothing here can undo. The reach is counted first so the button can name it.
			const patches = this.sessionRulePatches();
			const applyBtn = left.createEl("button", { cls: "fp-btn fp-btn--secondary fp-btn-secondary", attr: { type: "button" } });
			icon(applyBtn, "wand-sparkles");
			applyBtn.createSpan({
				text:
					patches.size === 0
						? "Nothing else matches these rules"
						: `Apply them to ${patches.size} existing transaction${patches.size === 1 ? "" : "s"} too`,
			});
			applyBtn.disabled = patches.size === 0;
			applyBtn.addEventListener("click", async () => {
				const store = this.plugin.store;
				await store.recategorize(patches);
				this.plugin.refreshViews();
				new Notice(`Categorized ${patches.size} more transaction${patches.size === 1 ? "" : "s"}`);
				applyBtn.disabled = true;
			});
		}

		const done = right.createEl("button", { cls: "fp-btn fp-btn--primary fp-btn-primary", text: "Done", attr: { type: "button" } });
		done.addEventListener("click", () => this.close());
	}
}

export function openReviewQueue(plugin: FinancePlugin, opts: ReviewQueueOptions = {}): void {
	new ReviewQueueModal(plugin.app, plugin, opts).open();
}
