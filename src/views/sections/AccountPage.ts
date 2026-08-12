import { ACCOUNT_TYPE_META } from "../../constants";
import type FinancePlugin from "../../main";
import { CreateAccountModal } from "../../modals/CreateAccountModal";
import type { Account } from "../../types";
import { emptyState, icon } from "../../ui/dom";
import { openImportWizard } from "../../wizards/ImportWizard";
import { renderCashDashboard } from "./dashboards/CashDashboard";
import { renderCheckingDashboard } from "./dashboards/CheckingDashboard";
import { renderCreditDashboard } from "./dashboards/CreditDashboard";
import { renderInvestingDashboard } from "./dashboards/InvestingDashboard";
import { renderSavingsDashboard } from "./dashboards/SavingsDashboard";
import { renderAllAccountsDashboard } from "./DashboardSection";
import { goToLedger, renderLedger, UNCATEGORIZED } from "./LedgerSection";
import { dataCoverage, formatCoverage, hasCommand, runCommand } from "./shared";

function renderAccountDashboard(container: HTMLElement, plugin: FinancePlugin, account: Account): void {
	switch (account.type) {
		case "debit":
			renderCheckingDashboard(container, plugin, account);
			break;
		case "credit":
			// A liability is not a checking account: it needs utilization, a statement cycle and the
			// interest it charges you, and it has no meaningful savings rate.
			renderCreditDashboard(container, plugin, account);
			break;
		case "saving":
			renderSavingsDashboard(container, plugin, account);
			break;
		case "investing":
		case "crypto":
			renderInvestingDashboard(container, plugin, account);
			break;
		case "cash":
			renderCashDashboard(container, plugin, account);
			break;
	}
}

/** IBAN as the last four, which is all anyone recognises and all we should print on screen. */
function maskedIban(iban: string): string {
	const trimmed = iban.replace(/\s+/g, "");
	return trimmed.length <= 4 ? trimmed : `•••• ${trimmed.slice(-4)}`;
}

function renderMeta(parent: HTMLElement, plugin: FinancePlugin, account: Account): void {
	const coverage = dataCoverage(plugin.store, account.id);
	const bits = [ACCOUNT_TYPE_META[account.type].label];
	if (account.institution) bits.push(account.institution);
	if (account.iban) bits.push(maskedIban(account.iban));
	bits.push(`${coverage.count.toLocaleString("en-IE")} transaction${coverage.count === 1 ? "" : "s"}`);
	// The window this account's own figures rest on. Per account rather than portfolio-wide, because
	// accounts are imported at different times and one that stopped a year ago is the single most
	// misleading thing a dashboard can quietly average into a total.
	if (coverage.from) bits.push(formatCoverage(coverage));
	parent.createDiv({ cls: "fp-section-subtitle", text: bits.join(" · ") });
}

/**
 * The action row every page needs and no page had: importing was gated behind having an account
 * selected, so the default landing page for every user had no import button at all.
 *
 * The review and month-in-review buttons run the plugin's own commands by id rather than importing
 * their modules — that keeps this file independent of the workflow layer, and a command that isn't
 * registered yet is a no-op instead of a build error.
 */
function renderActions(parent: HTMLElement, plugin: FinancePlugin, account?: Account): void {
	const row = parent.createDiv({ cls: "fp-action-row" });

	const importBtn = row.createEl("button", { cls: "fp-btn fp-btn--secondary", attr: { type: "button" } });
	icon(importBtn, "upload");
	importBtn.createSpan({ text: "Import" });
	importBtn.addEventListener("click", () => openImportWizard(plugin));

	const scope = account ? plugin.store.transactions.filter((t) => t.accountId === account.id) : plugin.store.transactions;
	const uncategorized = scope.filter((t) => !t.categoryId).length;
	if (uncategorized > 0) {
		const reviewBtn = row.createEl("button", { cls: "fp-btn fp-btn--secondary fp-action-review", attr: { type: "button" } });
		icon(reviewBtn, "alert-triangle");
		reviewBtn.createSpan({ text: `Review ${uncategorized.toLocaleString("en-IE")} uncategorized` });
		reviewBtn.addEventListener("click", () => {
			// The review queue is the right destination; until that command is registered, the ledger
			// filtered to uncategorized does the same job rather than the button doing nothing.
			if (hasCommand(plugin, "review-uncategorized")) runCommand(plugin, "review-uncategorized");
			else void goToLedger(plugin, { categoryId: UNCATEGORIZED, preset: "all", dateFrom: "", dateTo: "" }, account?.id);
		});
	}

	const monthBtn = row.createEl("button", { cls: "fp-btn fp-btn--secondary", attr: { type: "button" } });
	icon(monthBtn, "calendar-range");
	monthBtn.createSpan({ text: "This month in review" });
	monthBtn.addEventListener("click", () => runCommand(plugin, "month-in-review"));
}

/** One page per account (or "All Accounts"): a type-appropriate dashboard, a divider, then its ledger. */
export function renderAccountPage(container: HTMLElement, plugin: FinancePlugin): void {
	const store = plugin.store;
	container.addClass("fp-section");

	if (store.accounts.length === 0) {
		emptyState(container, {
			iconName: "wallet",
			title: "Let's set up your accounts",
			description: "Add the accounts you want to track — a checking account is the usual place to start.",
			actionLabel: "Add your first account",
			onAction: () => new CreateAccountModal(plugin.app, plugin).open(),
		});
		return;
	}

	const activeAccountId = plugin.settings.activeAccountId;
	const account = activeAccountId ? store.accounts.find((a) => a.id === activeAccountId) : undefined;

	const header = container.createDiv({ cls: "fp-section-header" });
	const headText = header.createDiv();
	if (account) {
		const back = headText.createEl("button", { cls: "fp-back-link", attr: { type: "button" } });
		icon(back, "chevron-left");
		back.createSpan({ text: "All accounts" });
		back.addEventListener("click", async () => {
			plugin.settings.activeAccountId = undefined;
			await plugin.saveSettings();
			plugin.refreshViews();
		});
	}
	headText.createEl("h2", { text: account ? account.name : "All accounts" });
	if (account) renderMeta(headText, plugin, account);
	renderActions(header.createDiv({ cls: "fp-section-header-actions" }), plugin, account);

	if (account) renderAccountDashboard(container, plugin, account);
	else renderAllAccountsDashboard(container, plugin);

	// "All Accounts" is a whole-of-finances overview, not a place to browse every transaction —
	// each account's own page is where its ledger lives.
	if (account) {
		container.createDiv({ cls: "fp-account-page-divider" });
		container.createEl("h3", { cls: "fp-account-page-ledger-title", text: "Transactions" });
		renderLedger(container, plugin);
	}
}
