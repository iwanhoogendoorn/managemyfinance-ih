import { findCategorizationInconsistencies } from "../../categorization";
import { computeInsights, type Insight, type InsightDeepLink, type InsightSeverity } from "../../insights";
import type FinancePlugin from "../../main";
import { TransactionDetailModal } from "../../modals/TransactionDetailModal";
import type { RecurringSeries } from "../../recurring";
import { emptyState, icon } from "../../ui/dom";
import { goToLedger, UNCATEGORIZED } from "./LedgerSection";
import { cardHead, goToAccount, goToView, money, portfolioCurrency } from "./shared";

/** How many cards the feed shows before "Show all". The spec's cap is 5 — enough to act on, few
 *  enough that the feed stays a feed rather than a backlog. */
const VISIBLE = 5;

const SEVERITY_ICON: Record<InsightSeverity, string> = {
	high: "alert-triangle",
	medium: "info",
	low: "circle-dot",
};

interface FeedItem {
	id: string;
	severity: InsightSeverity;
	title: string;
	detail: string;
	impactEUR: number;
	actionLabel?: string;
	run?: () => void;
}

function severityRank(s: InsightSeverity): number {
	return s === "high" ? 0 : s === "medium" ? 1 : 2;
}

/** Turns a structured deep link into the app's own navigation. Deliberately structured rather than a
 *  URL string: this app routes on settings plus the ledger's filter state, not on a path. */
function linkAction(plugin: FinancePlugin, link: InsightDeepLink): { label: string; run: () => void } | undefined {
	switch (link.type) {
		case "ledger":
			return {
				label: "Open in ledger",
				run: () =>
					void goToLedger(
						plugin,
						{
							search: link.search ?? "",
							categoryId: link.uncategorizedOnly ? UNCATEGORIZED : link.categoryId ?? "",
							accountId: "",
							dateFrom: link.dateFrom ?? "",
							dateTo: link.dateTo ?? "",
							preset: link.dateFrom || link.dateTo ? "custom" : "all",
						},
						link.accountId
					),
			};
		case "transaction": {
			const tx = plugin.store.transactions.find((t) => t.id === link.transactionId);
			if (!tx) return undefined;
			return { label: "Open transaction", run: () => new TransactionDetailModal(plugin.app, plugin, tx).open() };
		}
		case "subscription":
		case "detected-subscription":
			return { label: "Open subscriptions", run: () => void goToView(plugin, "subscriptions") };
		case "budgets":
			return { label: "Open budgets", run: () => void goToView(plugin, "budgets") };
		case "account":
			return { label: "Open account", run: () => void goToAccount(plugin, link.accountId) };
	}
}

function toFeedItem(plugin: FinancePlugin, insight: Insight): FeedItem {
	const action = linkAction(plugin, insight.deepLink);
	return {
		id: insight.id,
		severity: insight.severity,
		title: insight.title,
		detail: insight.detail,
		impactEUR: insight.impactEUR,
		actionLabel: action?.label,
		run: action?.run,
	};
}

/**
 * The categorization-flag card's old home was slot #2 of the overview — the most valuable pixels in
 * the app, spent on a data-hygiene chore. The logic is unchanged; it just competes for attention on
 * the same terms as everything else here, at the bottom of the ranking where it belongs.
 */
function categorizationItems(plugin: FinancePlugin): FeedItem[] {
	return findCategorizationInconsistencies(plugin.store).map((flag) => {
		const impact = flag.outliers.reduce((sum, o) => sum + Math.abs(o.transaction.amount), 0);
		const first = flag.outliers[0];
		return {
			id: `catflag-${flag.key}`,
			severity: "low" as const,
			title: `${flag.key} is tagged inconsistently`,
			detail: `${flag.majorityCount} of ${flag.totalCount} are "${flag.majorityCategoryName}", but ${flag.outliers.length} ${
				flag.outliers.length === 1 ? "is" : "are"
			} not.`,
			impactEUR: impact,
			actionLabel: first ? "Open transaction" : undefined,
			run: first ? () => new TransactionDetailModal(plugin.app, plugin, first.transaction).open() : undefined,
		};
	});
}

/**
 * The overview's insights feed: every detector in `insights.ts` plus the categorization flags,
 * ranked by the money at stake, each card dismissible for good.
 *
 * Dismissal writes the insight's deterministic id into settings, so it survives a recompute, a
 * re-import and a reload — and because those ids fold in the *state* that made the insight true,
 * dismissing "Netflix went to €12.99" doesn't also silence the next price rise.
 */
export function renderInsightsFeed(container: HTMLElement, plugin: FinancePlugin, series?: RecurringSeries[]): void {
	const host = container.createDiv();
	let expanded = false;

	const render = (): void => {
		host.empty();
		const store = plugin.store;
		const dismissed = new Set(plugin.settings.dismissedInsightIds ?? []);

		const items: FeedItem[] = [
			...computeInsights(store, store.subscriptions, { categories: store.categories }, { dismissed, series }).map((i) =>
				toFeedItem(plugin, i)
			),
			...categorizationItems(plugin).filter((i) => !dismissed.has(i.id)),
		].sort((a, b) => b.impactEUR - a.impactEUR || severityRank(a.severity) - severityRank(b.severity) || (a.id < b.id ? -1 : 1));

		const card = host.createDiv({ cls: "fp-card fp-insights-card" });
		cardHead(card, "Insights", { label: items.length > 0 ? `${items.length}` : undefined });

		if (items.length === 0) {
			emptyState(card, {
				variant: "inline",
				iconName: "sparkles",
				title: "Nothing needs your attention",
				description: "Price rises, duplicate charges, budget overruns and untracked subscriptions all show up here.",
			});
			return;
		}

		const list = card.createDiv({ cls: "fp-insight-list" });
		const shown = expanded ? items : items.slice(0, VISIBLE);
		shown.forEach((item) => renderCard(list, item));

		if (items.length > VISIBLE) {
			const toggle = card.createEl("button", {
				cls: "fp-btn fp-btn--ghost fp-insights-toggle",
				text: expanded ? "Show less" : `Show all ${items.length}`,
				attr: { type: "button" },
			});
			toggle.addEventListener("click", () => {
				expanded = !expanded;
				render();
			});
		}
	};

	const dismiss = async (id: string): Promise<void> => {
		const ids = plugin.settings.dismissedInsightIds ?? [];
		if (!ids.includes(id)) plugin.settings.dismissedInsightIds = [...ids, id];
		await plugin.saveSettings();
		render();
	};

	const renderCard = (parent: HTMLElement, item: FeedItem): void => {
		const currency = portfolioCurrency(plugin.store);
		const row = parent.createDiv({ cls: `fp-insight fp-insight--${item.severity}` });

		const glyph = row.createDiv({ cls: "fp-insight-icon" });
		icon(glyph, SEVERITY_ICON[item.severity]);

		const body = row.createDiv({ cls: "fp-insight-body" });
		body.createDiv({ cls: "fp-insight-title", text: item.title });
		body.createDiv({ cls: "fp-insight-detail", text: item.detail });

		const actions = row.createDiv({ cls: "fp-insight-actions" });
		if (item.impactEUR > 0) {
			actions.createSpan({ cls: "fp-insight-impact fp-money", text: money(item.impactEUR, currency) });
		}
		if (item.run && item.actionLabel) {
			const btn = actions.createEl("button", { cls: "fp-btn fp-btn--secondary", text: item.actionLabel, attr: { type: "button" } });
			btn.addEventListener("click", item.run);
		}
		const close = actions.createEl("button", {
			cls: "fp-btn fp-btn--ghost fp-btn--icon",
			attr: { type: "button", "aria-label": `Dismiss: ${item.title}` },
		});
		icon(close, "x");
		close.addEventListener("click", () => void dismiss(item.id));
	};

	render();
}
