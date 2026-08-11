import { ItemView, Menu, Platform, WorkspaceLeaf } from "obsidian";
import { ACCOUNT_TYPE_META, VIEW_TYPE_FINANCE } from "../constants";
import { netWorth } from "../kpi";
import type FinancePlugin from "../main";
import { CreateAccountModal } from "../modals/CreateAccountModal";
import { ManageAccountsModal } from "../modals/ManageAccountsModal";
import { ManagePortfoliosModal } from "../modals/ManagePortfoliosModal";
import type { Account } from "../types";
import { icon } from "../ui/dom";
import { formatEUR } from "../ui/metricsTable";
import { openCreatePortfolioWizard } from "../wizards/PortfolioWizard";
import { leaveSetup, renderSetupView, shouldShowSetup } from "./SetupView";
import { renderAccountPage } from "./sections/AccountPage";
import { renderBudgetsSection } from "./sections/BudgetsSection";
import { renderCardsSection } from "./sections/CardsSection";
import { renderSubscriptionsSection } from "./sections/SubscriptionsSection";

/** Checking-like accounts first, then savings, then investing/crypto, then everything else (e.g. cash). */
const TYPE_ORDER: Account["type"][] = ["debit", "credit", "saving", "investing", "crypto", "cash"];

interface NavTabDef {
	id: string;
	label: string;
	icon: string;
	isActive: boolean;
	onClick: () => void;
}

const DEFAULT_NAV_ORDER = ["all-accounts", "budgets", "subscriptions", "cards"];

/** Classes the section renderers put on the shared body element — stripped before every dispatch so
 *  they never outlive the page that added them. */
const BODY_SECTION_CLASSES = ["fp-section"];

function possessive(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "";
	return trimmed.endsWith("s") ? `${trimmed}'` : `${trimmed}'s`;
}

/**
 * Account-centric workspace: the rail lists "All Accounts" plus every account you have (instead
 * of generic Dashboard/Ledger/... tabs), and picking one shows that account's own dashboard and
 * ledger together on a single page.
 *
 * The rail is deliberately zoned — brand, primary tabs, accounts (with balances), utility footer —
 * so the four different *kinds* of thing in it stop sharing one visual treatment. Its width is
 * driven by container queries on `.fp-shell`, not by `Platform.isMobile`: the same view is
 * full-screen and docked at 340px within one session.
 */
export class FinanceView extends ItemView {
	private railEl!: HTMLElement;
	private tabsEl!: HTMLElement;
	private accountsEl!: HTMLElement;
	private footerEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private brandEl!: HTMLElement;
	private brandTitleEl!: HTMLElement;

	constructor(leaf: WorkspaceLeaf, private plugin: FinancePlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_FINANCE;
	}
	getDisplayText(): string {
		return "Finance";
	}
	getIcon(): string {
		return "wallet";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		// `.fp-root` is the token root; `.fp-workspace` is kept as an alias while modals and
		// sections migrate onto it.
		root.addClass("fp-workspace");
		root.addClass("fp-root");
		this.applyPrivacyClass();
		this.applyNarrowOverride();

		const shell = root.createDiv({ cls: "fp-shell" });
		this.railEl = shell.createDiv({ cls: "fp-rail fp-nav" });
		const content = shell.createDiv({ cls: "fp-content" });
		this.bodyEl = content.createDiv({ cls: "fp-content-inner" });

		const brandZone = this.railEl.createDiv({ cls: "fp-rail-brand" });
		this.brandEl = brandZone.createEl("button", {
			cls: "fp-nav-brand fp-nav-brand-switcher",
			attr: { type: "button", "aria-haspopup": "menu", "aria-label": "Switch portfolio" },
		});
		icon(this.brandEl, "wallet", "fp-nav-brand-icon");
		const brandText = this.brandEl.createDiv({ cls: "fp-nav-brand-text" });
		this.brandTitleEl = brandText.createDiv({ cls: "fp-nav-brand-title" });
		this.brandEl.addEventListener("click", () => this.openPortfolioMenu());
		this.renderBrandTitle();

		const railBody = this.railEl.createDiv({ cls: "fp-rail-body" });
		this.tabsEl = railBody.createDiv({
			cls: "fp-rail-tabs fp-nav-items",
			attr: { role: "tablist", "aria-orientation": "vertical", "aria-label": "Finance sections" },
		});
		this.accountsEl = railBody.createDiv({ cls: "fp-rail-section" });
		this.footerEl = this.railEl.createDiv({ cls: "fp-rail-footer" });

		this.renderNav();
		this.renderBody();
		// The cards intro used to auto-open here. Nothing should open a *card* wizard before the user
		// has seen their own numbers — cards are cosmetic and, on a fresh install, there are no
		// transactions to put on one. It lives on the Cards tab as a dismissible prompt instead.
	}

	refresh(): void {
		this.applyNarrowOverride();
		// Privacy is global page state that outlives the view, so re-assert it on every refresh
		// rather than only in onOpen().
		this.applyPrivacyClass();
		this.renderBrandTitle();
		this.renderNav();
		this.renderBody();
	}

	/**
	 * Layout is container-driven now (`@container fp-shell`), so this only handles the *manual*
	 * override: "on" forces the narrow branch at any width (useful to preview it on desktop), "off"
	 * never forces it, "auto" keeps the historical behaviour of following `Platform.isMobile` —
	 * a phone's WebView reports a wide container in landscape but still wants the stacked layout.
	 */
	private applyNarrowOverride(): void {
		const mode = this.plugin.settings.mobileLayout ?? "auto";
		const force = mode === "on" || (mode !== "off" && Platform.isMobile);
		this.contentEl.toggleClass("fp-force-narrow", force);
	}

	private renderBrandTitle(): void {
		this.brandTitleEl.empty();
		const name = this.plugin.activePortfolio?.name;
		this.brandTitleEl.createSpan({
			cls: "fp-nav-brand-title-text",
			text: name ? `${possessive(name)} Finance` : "Finance",
		});
		icon(this.brandTitleEl, "chevron-down", "fp-nav-brand-chevron");
	}

	private openPortfolioMenu(): void {
		const menu = new Menu();
		const portfolios = this.plugin.settings.portfolios ?? [];
		portfolios.forEach((p) => {
			menu.addItem((item) =>
				item
					.setTitle(p.name)
					.setIcon(p.id === this.plugin.settings.activePortfolioId ? "check" : "briefcase")
					.onClick(() => void this.plugin.switchPortfolio(p.id))
			);
		});
		menu.addSeparator();
		menu.addItem((item) =>
			item.setTitle("New portfolio…").setIcon("plus").onClick(() => openCreatePortfolioWizard(this.plugin))
		);
		menu.addItem((item) =>
			item
				.setTitle("Manage portfolios…")
				.setIcon("settings")
				.onClick(() => new ManagePortfoliosModal(this.app, this.plugin, () => this.refresh()).open())
		);
		const rect = this.brandEl.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
	}

	private async selectAccount(accountId: string | undefined): Promise<void> {
		// Clicking anything in the rail is a decision to be somewhere else. Without this, setup keeps
		// the body (`inProgress`) while the rail marks the tab active — the nav goes through the
		// motions and nothing moves.
		leaveSetup(this.bodyEl);
		this.plugin.settings.activeAccountId = accountId;
		this.plugin.settings.activeView = undefined;
		await this.plugin.saveSettings();
		this.renderNav();
		this.renderBody();
	}

	private async selectView(view: "budgets" | "subscriptions" | "cards"): Promise<void> {
		leaveSetup(this.bodyEl);
		this.plugin.settings.activeView = view;
		await this.plugin.saveSettings();
		this.renderNav();
		this.renderBody();
	}

	/** Toggled on <body>, not the workspace root — modals (e.g. transaction/month detail) mount outside
	 *  the view's own DOM subtree, so they only pick up privacy mode via a class shared that high up. */
	private applyPrivacyClass(): void {
		document.body.toggleClass("fp-privacy", !!this.plugin.settings.privacyMode);
	}

	private async togglePrivacy(): Promise<void> {
		this.plugin.settings.privacyMode = !this.plugin.settings.privacyMode;
		await this.plugin.saveSettings();
		this.applyPrivacyClass();
		this.renderNav();
	}

	/** Saved order, filtered to known tabs, then any tab missing from it (e.g. newly added) appended in default order. */
	private navTabOrder(): string[] {
		const saved = (this.plugin.settings.navOrder ?? []).filter((id) => DEFAULT_NAV_ORDER.includes(id));
		return [...saved, ...DEFAULT_NAV_ORDER.filter((id) => !saved.includes(id))];
	}

	private async reorderNavTabs(draggedId: string, targetId: string): Promise<void> {
		const order = this.navTabOrder();
		const from = order.indexOf(draggedId);
		const to = order.indexOf(targetId);
		if (from === -1 || to === -1 || from === to) return;
		order.splice(from, 1);
		order.splice(to, 0, draggedId);
		this.plugin.settings.navOrder = order;
		await this.plugin.saveSettings();
		this.renderNav();
	}

	/** Wires up HTML5 drag-and-drop reordering onto an already-built nav item (a drag handle + `draggable` attr must already be on it). */
	private wireDrag(item: HTMLElement, id: string, onDrop: (draggedId: string, targetId: string) => void): void {
		item.addEventListener("dragstart", (ev) => {
			ev.dataTransfer?.setData("text/plain", id);
			setTimeout(() => item.addClass("is-dragging"), 0);
		});
		item.addEventListener("dragend", () => item.removeClass("is-dragging"));
		item.addEventListener("dragover", (ev) => {
			ev.preventDefault();
			item.addClass("is-drag-over");
		});
		item.addEventListener("dragleave", () => item.removeClass("is-drag-over"));
		item.addEventListener("drop", (ev) => {
			ev.preventDefault();
			item.removeClass("is-drag-over");
			const draggedId = ev.dataTransfer?.getData("text/plain");
			if (draggedId) onDrop(draggedId, id);
		});
	}

	/** The tail slot holds the balance and the drag grip in the same place — the grip fades in over
	 *  the balance on hover, so the rail is not permanently cluttered with six grip icons. */
	private navTail(item: HTMLElement, draggable: boolean, balance?: string): void {
		const tail = item.createDiv({ cls: "fp-nav-tail" });
		if (balance !== undefined) tail.createSpan({ cls: "fp-nav-balance fp-money", text: balance });
		if (draggable) icon(tail, "grip-vertical", "fp-nav-drag-handle");
	}

	/** Roving tabindex across the primary tabs: one stop in the tab order, arrows move within it. */
	private wireRovingTabs(buttons: HTMLElement[]): void {
		buttons.forEach((btn, i) => {
			btn.addEventListener("keydown", (ev: KeyboardEvent) => {
				const next = ev.key === "ArrowDown" ? i + 1 : ev.key === "ArrowUp" ? i - 1 : -1;
				if (next < 0 || next >= buttons.length) return;
				ev.preventDefault();
				buttons[next].focus();
			});
		});
	}

	private renderDraggableTab(def: NavTabDef, focusable: boolean): HTMLElement {
		const item = this.tabsEl.createEl("button", {
			cls: "fp-nav-item fp-nav-item-draggable" + (def.isActive ? " is-active" : ""),
			attr: {
				type: "button",
				role: "tab",
				draggable: "true",
				"aria-selected": String(def.isActive),
				tabindex: focusable ? "0" : "-1",
				// The label is hidden in the collapsed (icon) rail, so it has to survive as a tooltip.
				title: def.label,
			},
		});
		icon(item, def.icon, "fp-nav-icon");
		item.createSpan({ cls: "fp-nav-label", text: def.label });
		this.navTail(item, true);
		item.addEventListener("click", () => def.onClick());
		this.wireDrag(item, def.id, (draggedId, targetId) => void this.reorderNavTabs(draggedId, targetId));
		return item;
	}

	/** Saved order, filtered to accounts that still exist in this portfolio, then any new/unordered accounts appended by type. */
	private accountOrder(): string[] {
		const accounts = this.plugin.store.accounts;
		const ids = new Set(accounts.map((a) => a.id));
		const saved = (this.plugin.settings.accountOrder ?? []).filter((id) => ids.has(id));
		const defaultOrder = [...accounts].sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)).map((a) => a.id);
		return [...saved, ...defaultOrder.filter((id) => !saved.includes(id))];
	}

	private async reorderAccounts(draggedId: string, targetId: string): Promise<void> {
		const order = this.accountOrder();
		const from = order.indexOf(draggedId);
		const to = order.indexOf(targetId);
		if (from === -1 || to === -1 || from === to) return;
		order.splice(from, 1);
		order.splice(to, 0, draggedId);
		this.plugin.settings.accountOrder = order;
		await this.plugin.saveSettings();
		this.renderNav();
	}

	private renderNav(): void {
		this.tabsEl.empty();
		this.accountsEl.empty();
		this.footerEl.empty();

		const activeAccountId = this.plugin.settings.activeAccountId;
		const activeView = this.plugin.settings.activeView;

		const tabDefs: Record<string, NavTabDef> = {
			"all-accounts": {
				id: "all-accounts",
				label: "All Accounts",
				icon: "layers",
				isActive: !activeAccountId && !activeView,
				onClick: () => void this.selectAccount(undefined),
			},
			budgets: {
				id: "budgets",
				label: "Budgets",
				icon: "piggy-bank",
				isActive: activeView === "budgets",
				onClick: () => void this.selectView("budgets"),
			},
			subscriptions: {
				id: "subscriptions",
				label: "Subscriptions",
				icon: "repeat",
				isActive: activeView === "subscriptions",
				onClick: () => void this.selectView("subscriptions"),
			},
			cards: {
				id: "cards",
				label: "Cards",
				icon: "credit-card",
				isActive: activeView === "cards",
				onClick: () => void this.selectView("cards"),
			},
		};
		const order = this.navTabOrder();
		const activeIdx = Math.max(0, order.findIndex((id) => tabDefs[id].isActive));
		const tabButtons = order.map((id, i) => this.renderDraggableTab(tabDefs[id], i === activeIdx));
		this.wireRovingTabs(tabButtons);

		this.renderAccountsSection(activeAccountId, activeView);
		this.renderUtilityFooter();
	}

	private renderAccountsSection(activeAccountId: string | undefined, activeView: string | undefined): void {
		const accountById = new Map(this.plugin.store.accounts.map((a) => [a.id, a]));
		const accounts = this.accountOrder()
			.map((id) => accountById.get(id))
			.filter((a): a is Account => !!a);

		if (accounts.length > 0) {
			// Balances in the rail: the single most useful thing a finance sidebar can show, and the
			// group total answers "what am I worth" without leaving whatever page you are on.
			const total = accounts.reduce((sum, a) => sum + netWorth(this.plugin.store, a.id), 0);
			const head = this.accountsEl.createDiv({ cls: "fp-rail-section-head" });
			head.createSpan({ cls: "fp-overline fp-nav-section-label", text: "Accounts" });
			head.createSpan({ cls: "fp-rail-section-total fp-money", text: formatEUR(total) });
		}

		accounts.forEach((acc) => {
			const isActive = !activeView && activeAccountId === acc.id;
			const item = this.accountsEl.createEl("button", {
				cls: "fp-nav-item fp-rail-account fp-nav-item-draggable" + (isActive ? " is-active" : ""),
				attr: {
					type: "button",
					draggable: "true",
					"aria-current": isActive ? "page" : "false",
					// Icons cannot distinguish "Revolut Main" from "Revolut Savings" — both are a
					// landmark — so the collapsed rail leans on the tooltip.
					title: `${acc.name} · ${ACCOUNT_TYPE_META[acc.type].label}`,
				},
			});
			icon(item, ACCOUNT_TYPE_META[acc.type].icon, "fp-nav-icon");
			const textCol = item.createDiv({ cls: "fp-nav-item-text" });
			textCol.createDiv({ cls: "fp-nav-label", text: acc.name });
			textCol.createDiv({ cls: "fp-nav-item-type", text: ACCOUNT_TYPE_META[acc.type].label });
			this.navTail(item, true, formatEUR(netWorth(this.plugin.store, acc.id)));
			item.addEventListener("click", () => void this.selectAccount(acc.id));
			// Right-click → edit: the only other route to "change this account's type" is buried in
			// Manage accounts, and a mis-typed account is the most common thing to want to fix.
			item.addEventListener("contextmenu", (ev) => {
				ev.preventDefault();
				const menu = new Menu();
				menu.addItem((mi) =>
					mi.setTitle(`Edit "${acc.name}"…`).setIcon("pencil").onClick(() => {
						new CreateAccountModal(this.app, this.plugin, () => this.refresh(), acc).open();
					})
				);
				menu.addItem((mi) =>
					mi.setTitle("Manage accounts…").setIcon("settings").onClick(() => {
						new ManageAccountsModal(this.app, this.plugin, () => this.refresh()).open();
					})
				);
				menu.showAtMouseEvent(ev);
			});
			this.wireDrag(item, acc.id, (draggedId, targetId) => void this.reorderAccounts(draggedId, targetId));
		});

		const addItem = this.accountsEl.createEl("button", {
			cls: "fp-nav-item fp-nav-item-ghost",
			attr: { type: "button" },
		});
		icon(addItem, "plus", "fp-nav-icon");
		addItem.createSpan({ cls: "fp-nav-label", text: "Add account" });
		addItem.addEventListener("click", () => {
			new CreateAccountModal(this.app, this.plugin, (account) => void this.selectAccount(account.id)).open();
		});
	}

	/** Utility footer — the two *controls* that were previously rendered as nav items sitting between
	 *  the tabs and the accounts, which made them read as destinations. */
	private renderUtilityFooter(): void {
		const manageItem = this.footerEl.createEl("button", {
			cls: "fp-nav-util",
			attr: { type: "button", title: "Manage accounts…", "aria-label": "Manage accounts" },
		});
		icon(manageItem, "settings", "fp-nav-icon");
		manageItem.createSpan({ cls: "fp-nav-label", text: "Manage" });
		manageItem.addEventListener("click", () => {
			new ManageAccountsModal(this.app, this.plugin, () => {
				this.renderNav();
				this.renderBody();
			}).open();
		});

		const privacyOn = !!this.plugin.settings.privacyMode;
		const privacyItem = this.footerEl.createEl("button", {
			cls: "fp-nav-util" + (privacyOn ? " is-privacy-on" : ""),
			attr: {
				type: "button",
				"aria-pressed": String(privacyOn),
				title: "Redact every amount — hover one to peek. Useful when demoing the plugin.",
			},
		});
		icon(privacyItem, privacyOn ? "eye-off" : "eye", "fp-nav-icon");
		// A constant one-word label: the footer shares its row with "Manage", and the previous
		// "Amounts hidden" / "Hide amounts" truncated to an unreadable "Amounts …". State lives in
		// the icon + aria-pressed + the is-privacy-on tint, not in label churn.
		privacyItem.createSpan({ cls: "fp-nav-label", text: "Privacy" });
		privacyItem.addEventListener("click", () => void this.togglePrivacy());
	}

	private renderBody(): void {
		this.bodyEl.empty();
		// `.empty()` clears children, not the classes the sections put on the body itself. Every section
		// adds `fp-section` and none removes it, so one visit to any of them left `.fp-section` on the
		// shared body for the life of the view — after which `.fp-section .fp-step-desc` started
		// applying to the setup view too, depending only on where you happened to have been.
		for (const cls of BODY_SECTION_CLASSES) this.bodyEl.removeClass(cls);
		// First run owns the whole body: a fresh install with no accounts has nothing to show on any
		// tab, and the old empty state was a dead end that told you to go hunt in the sidebar.
		if (shouldShowSetup(this.plugin, this.bodyEl)) {
			renderSetupView(this.bodyEl, this.plugin, () => this.refresh());
			return;
		}
		if (this.plugin.settings.activeView === "budgets") {
			renderBudgetsSection(this.bodyEl, this.plugin);
		} else if (this.plugin.settings.activeView === "subscriptions") {
			renderSubscriptionsSection(this.bodyEl, this.plugin);
		} else if (this.plugin.settings.activeView === "cards") {
			renderCardsSection(this.bodyEl, this.plugin);
		} else {
			renderAccountPage(this.bodyEl, this.plugin);
		}
	}
}
