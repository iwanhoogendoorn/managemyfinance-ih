import { Notice } from "obsidian";
import type FinancePlugin from "../../main";
import { recurringSeries } from "../../recurring";
import { detectRecurring, type RecurringCandidate } from "../../subscriptionDetect";
import {
	BILLING_CYCLE_LABEL,
	SUBSCRIPTION_CATEGORIES,
	daysUntil,
	isActive,
	monthlyCost,
	nextOccurrence,
	subscriptionTotals,
	totalsByBillingCycle,
	totalsByCategory,
	totalsByPaidVia,
	upcomingPayments,
	type UpcomingPayment,
} from "../../subscriptions";
import type { Subscription } from "../../types";
import { barChart, stackedShareBar } from "../../ui/charts";
import { badge, emptyState, icon, initialsAvatar, renderStat } from "../../ui/dom";
import { openSubscriptionWizard } from "../../wizards/SubscriptionWizard";
import { cardHead, catColor, formatDay, money, portfolioCurrency, relativeDays, setStatFoot } from "./shared";

const DUE_SOON_DAYS = 7;
/** Detected candidates shown before the panel folds into "show all". */
const DETECTION_PREVIEW = 4;

function categoryColor(category: string): string {
	const idx = SUBSCRIPTION_CATEGORIES.indexOf(category);
	return catColor(idx < 0 ? 0 : idx);
}

/**
 * A standalone recurring-payments tracker, now wired to the ledger: what you've told us you pay for,
 * plus what your transactions say you're paying for and haven't told us about.
 */
export function renderSubscriptionsSection(container: HTMLElement, plugin: FinancePlugin): void {
	// A root of our own, not the shared view body: every re-render below is reachable from an `await`,
	// and `container` is the view's body element, which stays connected no matter where the user
	// navigated in the meantime. A root we created goes away with the body's next `.empty()`, so
	// `isConnected` is an honest answer to "do we still own this page?".
	const root = container.createDiv({ cls: "fpih-section" });

	function render(): void {
		if (!root.isConnected) return;
		root.empty();
		const store = plugin.store;
		const subs = store.subscriptions;
		const today = new Date();
		const currency = portfolioCurrency(store);

		const header = root.createDiv({ cls: "fpih-section-header" });
		const headText = header.createDiv();
		headText.createEl("h2", { text: "Subscriptions" });
		headText.createDiv({
			cls: "fpih-section-subtitle",
			text: "Everything you pay for on repeat — cost per cycle, next payment date and when each one ends. Totals are normalised to a monthly figure.",
		});
		const headerActions = header.createDiv({ cls: "fpih-section-header-actions" });
		const addBtn = headerActions.createEl("button", { cls: "fpih-btn fpih-btn--primary", attr: { type: "button" } });
		icon(addBtn, "plus");
		addBtn.createSpan({ text: "Add subscription" });
		addBtn.addEventListener("click", () => openSubscriptionWizard(plugin, undefined, () => render()));

		const totals = subscriptionTotals(subs, today, DUE_SOON_DAYS);
		const kpis = root.createDiv({ cls: "fpih-stat-grid" });
		const perMonth = renderStat(kpis, { label: "Per month", value: money(totals.perMonth, currency, 2), size: "hero", iconName: "calendar" });
		setStatFoot(perMonth, [{ money: money(totals.perYear, currency) }, " a year at this rate"]);
		renderStat(kpis, { label: "Private", value: money(totals.privatePerMonth, currency, 2), iconName: "user", sub: "per month" });
		renderStat(kpis, { label: "Business", value: money(totals.businessPerMonth, currency, 2), iconName: "briefcase", sub: "per month" });
		renderStat(kpis, {
			label: "Active",
			value: String(totals.activeCount),
			iconName: "check-circle",
			money: false,
			sub: totals.dueSoonCount > 0 ? `${totals.dueSoonCount} due within ${DUE_SOON_DAYS} days` : "none due this week",
			tone: totals.dueSoonCount > 0 ? "warn" : "neutral",
		});

		// Detection sits above the list: what the ledger knows that the tracker doesn't is the most
		// actionable thing on this page.
		renderDetection(root, plugin, today, currency, render);

		if (subs.length === 0) {
			emptyState(root, {
				iconName: "repeat",
				title: "No subscriptions tracked yet",
				description: "Add your first recurring payment to start tracking monthly spend.",
				actionLabel: "Add subscription",
				onAction: () => openSubscriptionWizard(plugin, undefined, () => render()),
			});
			return;
		}

		const breakdown = root.createDiv({ cls: "fpih-sub-breakdown-grid" });
		renderShareCard(breakdown, "By category", totalsByCategory(subs, today), currency, categoryColor);
		renderShareCard(breakdown, "By billing cycle", totalsByBillingCycle(subs, today), currency);
		renderShareCard(breakdown, "Private vs business", totalsByPaidVia(subs, today), currency);

		const topRows = subs
			.filter((s) => isActive(s, today))
			.map((s) => ({ label: s.name, value: monthlyCost(s), color: categoryColor(s.category) }))
			.filter((r) => r.value > 0)
			.sort((a, b) => b.value - a.value)
			.slice(0, 5);
		if (topRows.length > 0) {
			const topCard = root.createDiv({ cls: "fpih-card" });
			cardHead(topCard, "Top subscriptions", { label: "Monthly cost" });
			barChart(topCard, topRows, { formatValue: (n) => money(n, currency, 2) });
		}

		renderUpcoming(root, upcomingPayments(subs, today).slice(0, 6), currency);
		renderList(root, subs, today, currency);
	}

	/* ---------- detection ---------- */

	function renderDetection(parent: HTMLElement, plugin: FinancePlugin, today: Date, currency: string, refresh: () => void): void {
		const store = plugin.store;
		const dismissed = plugin.settings.dismissedSubscriptionKeys ?? [];
		const candidates = detectRecurring(store, store.subscriptions, dismissed, { series: recurringSeries(store) });
		if (candidates.length === 0) return;

		const monthlyTotal = candidates.reduce((sum, c) => sum + c.monthlyCost, 0);
		const card = parent.createDiv({ cls: "fpih-card fpih-detect-card" });
		const head = cardHead(card, "Found in your ledger", {
			sub: "These look like recurring payments you're not tracking yet.",
		});
		const label = head.createDiv({ cls: "fpih-card-head-label" });
		label.createSpan({ text: `${candidates.length} possible · ` });
		label.createSpan({ cls: "fpih-money", text: `${money(monthlyTotal, currency, 2)}/mo` });

		let expanded = false;
		const list = card.createDiv({ cls: "fpih-detect-list" });
		const draw = () => {
			list.empty();
			(expanded ? candidates : candidates.slice(0, DETECTION_PREVIEW)).forEach((c) => renderCandidate(list, c));
			more.setText(expanded ? "Show fewer" : `Review all ${candidates.length}`);
			more.toggleClass("is-hidden", candidates.length <= DETECTION_PREVIEW);
		};
		const more = card.createEl("button", { cls: "fpih-btn fpih-btn--ghost", attr: { type: "button" } });
		more.addEventListener("click", () => {
			expanded = !expanded;
			draw();
		});

		function renderCandidate(host: HTMLElement, c: RecurringCandidate): void {
			const row = host.createDiv({ cls: "fpih-row fpih-detect-row" });
			initialsAvatar(row, c.displayName, catColor(c.displayName.length), "fpih-detect-avatar");

			const main = row.createDiv({ cls: "fpih-row-main" });
			const titleLine = main.createDiv({ cls: "fpih-row-title" });
			// Raw ledger merchant text, exactly like the review queue's and the import preview's.
			titleLine.createSpan({ cls: "fpih-sensitive", text: c.displayName });
			badge(titleLine, c.confidence, c.confidence === "high" ? "good" : c.confidence === "medium" ? "warn" : "neutral");
			const accountName = store.accounts.find((a) => a.id === c.accountId)?.name;
			main.createDiv({
				cls: "fpih-row-meta",
				text: `${c.occurrences} payments since ${formatDay(c.firstSeen, { short: true })} · last ${formatDay(c.lastSeen, {
					short: true,
				})}${accountName ? ` · ${accountName}` : ""}`,
			});

			const value = row.createDiv({ cls: "fpih-row-value" });
			value.createDiv({ cls: "fpih-money", text: money(c.cost, currency, 2) });
			value.createDiv({ cls: "fpih-row-value-unit", text: BILLING_CYCLE_LABEL[c.billingCycle].toLowerCase() });

			// Row actions are always visible here: this panel exists to be answered, not browsed.
			const actions = row.createDiv({ cls: "fpih-row-actions is-persistent" });
			const track = actions.createEl("button", { cls: "fpih-btn fpih-btn--primary", text: "Track", attr: { type: "button" } });
			track.addEventListener("click", () =>
				openSubscriptionWizard(plugin, undefined, () => refresh(), {
					name: c.displayName,
					cost: c.cost,
					billingCycle: c.billingCycle,
					accountId: c.accountId,
					nextDueDate: c.nextDueDate,
					merchantKey: c.merchantKey,
				})
			);
			const reject = actions.createEl("button", { cls: "fpih-btn fpih-btn--ghost", text: "Not a subscription", attr: { type: "button" } });
			reject.addEventListener("click", () => void dismissCandidate(c));
		}

		async function dismissCandidate(c: RecurringCandidate): Promise<void> {
			const keys = plugin.settings.dismissedSubscriptionKeys ?? [];
			if (!keys.includes(c.merchantKey)) plugin.settings.dismissedSubscriptionKeys = [...keys, c.merchantKey];
			await plugin.saveSettings();
			new Notice(`"${c.displayName}" won't be suggested again`);
			// A full refresh, not the local `refresh()`: dismissing also changes the overview's insights
			// feed. Rebuilding the body detaches our root, so the local render is a guarded no-op after
			// this — nothing holds focus on this panel, so there is nothing to preserve.
			plugin.refreshViews();
		}

		draw();
	}

	/* ---------- breakdown ---------- */

	function renderShareCard(
		parent: HTMLElement,
		title: string,
		rows: { label: string; value: number }[],
		currency: string,
		colorFor?: (label: string) => string
	): void {
		const card = parent.createDiv({ cls: "fpih-card fpih-sub-share-card" });
		cardHead(card, title, { label: "Monthly spend" });
		const total = rows.reduce((s, r) => s + r.value, 0);
		if (total <= 0) {
			emptyState(card, { variant: "inline", iconName: "chart-pie", title: "No spend yet", description: "Add a subscription to see the split." });
			return;
		}
		stackedShareBar(
			card,
			rows.map((r, i) => ({ label: r.label, value: r.value, color: colorFor ? colorFor(r.label) : catColor(i) })),
			{ formatValue: (n) => money(n, currency, 2) }
		);
	}

	/* ---------- upcoming ---------- */

	function renderUpcoming(parent: HTMLElement, payments: UpcomingPayment[], currency: string): void {
		const card = parent.createDiv({ cls: "fpih-card" });
		// The charge that actually hits the account, not its normalized monthly share: a €120/year
		// subscription due next week is €120 leaving your balance that day.
		const total = payments.reduce((sum, p) => sum + p.amount, 0);
		const head = cardHead(card, "Upcoming payments");
		if (payments.length > 0) {
			const label = head.createDiv({ cls: "fpih-card-head-label" });
			label.createSpan({ text: `Next ${payments.length} · ` });
			label.createSpan({ cls: "fpih-money", text: money(total, currency, 2) });
		}

		if (payments.length === 0) {
			emptyState(card, {
				variant: "inline",
				iconName: "calendar-check",
				title: "Nothing due",
				description: "Active subscriptions with a next due date show up here, soonest first.",
			});
			return;
		}

		const list = card.createDiv({ cls: "fpih-row-list" });
		payments.forEach((p) => {
			const row = list.createDiv({ cls: "fpih-row" });
			const date = row.createDiv({ cls: "fpih-row-date" });
			date.createDiv({ text: formatDay(p.date, { short: true }) });
			date.createDiv({ cls: "fpih-row-date-rel" + (p.daysUntil <= 0 ? " is-due" : ""), text: relativeDays(p.daysUntil) });

			initialsAvatar(row, p.sub.name, categoryColor(p.sub.category), "fpih-row-avatar");

			const main = row.createDiv({ cls: "fpih-row-main" });
			main.createDiv({ cls: "fpih-row-title fpih-sensitive", text: p.sub.name });
			main.createDiv({
				cls: "fpih-row-meta",
				text: `${p.sub.category} · ${BILLING_CYCLE_LABEL[p.sub.billingCycle]}${p.sub.plan ? ` · ${p.sub.plan}` : ""}`,
			});

			const value = row.createDiv({ cls: "fpih-row-value" });
			value.createDiv({ cls: "fpih-money", text: money(p.amount, currency, 2) });
			value.createDiv({ cls: "fpih-row-value-unit fpih-money", text: `${money(monthlyCost(p.sub), currency, 2)}/mo` });
		});
	}

	/* ---------- the list ---------- */

	function renderList(parent: HTMLElement, subs: Subscription[], today: Date, currency: string): void {
		const card = parent.createDiv({ cls: "fpih-card" });
		cardHead(card, `${subs.length} subscription${subs.length === 1 ? "" : "s"}`);

		const groups = new Map<string, Subscription[]>();
		for (const s of subs) {
			if (!groups.has(s.category)) groups.set(s.category, []);
			groups.get(s.category)!.push(s);
		}
		const sortedGroups = Array.from(groups.entries()).sort(
			(a, b) => b[1].reduce((sum, s) => sum + monthlyCost(s), 0) - a[1].reduce((sum, s) => sum + monthlyCost(s), 0)
		);

		sortedGroups.forEach(([category, items]) => {
			const groupTotal = items.reduce((sum, s) => sum + monthlyCost(s), 0);
			const groupLabel = card.createDiv({ cls: "fpih-row-group-label" });
			groupLabel.createSpan({ text: category });
			groupLabel.createSpan({ cls: "fpih-money", text: `${money(groupTotal, currency, 2)}/mo` });
			const list = card.createDiv({ cls: "fpih-row-list" });
			[...items].sort((a, b) => monthlyCost(b) - monthlyCost(a)).forEach((sub) => renderSubRow(list, sub, today, currency));
		});
	}

	/**
	 * A subscription list is a list. The card grid wasted horizontal space and broke price
	 * scannability — the one thing you actually come to this page to do.
	 */
	function renderSubRow(parent: HTMLElement, sub: Subscription, today: Date, currency: string): void {
		const active = isActive(sub, today);
		const row = parent.createDiv({ cls: "fpih-row" + (active ? "" : " is-inactive") });
		initialsAvatar(row, sub.name, categoryColor(sub.category), "fpih-row-avatar");

		const main = row.createDiv({ cls: "fpih-row-main" });
		const titleLine = main.createDiv({ cls: "fpih-row-title" });
		titleLine.createSpan({ cls: "fpih-sensitive", text: sub.name });
		if (sub.plan) titleLine.createSpan({ cls: "fpih-row-title-plan", text: sub.plan });
		if (sub.paidVia === "business") badge(titleLine, "business", "warn");

		const next = nextOccurrence(sub, today);
		const accountName = sub.accountId ? plugin.store.accounts.find((a) => a.id === sub.accountId)?.name : undefined;
		const meta = [BILLING_CYCLE_LABEL[sub.billingCycle], accountName, next ? `next ${formatDay(next, { short: true })} · ${relativeDays(daysUntil(next, today))}` : sub.endDate ? `ended ${formatDay(sub.endDate, { short: true })}` : "no upcoming payment"]
			.filter(Boolean)
			.join(" · ");
		main.createDiv({ cls: "fpih-row-meta", text: meta });

		const value = row.createDiv({ cls: "fpih-row-value" });
		value.createDiv({ cls: "fpih-money", text: money(sub.cost, currency, 2) });
		value.createDiv({ cls: "fpih-row-value-unit fpih-money", text: `${money(monthlyCost(sub), currency, 2)}/mo` });

		const actions = row.createDiv({ cls: "fpih-row-actions" });
		if (sub.cancelUrl) {
			const linkBtn = actions.createEl("button", { cls: "fpih-btn fpih-btn--ghost fpih-btn--icon", attr: { type: "button", "aria-label": `Open cancel page for ${sub.name}` } });
			icon(linkBtn, "external-link");
			linkBtn.addEventListener("click", () => window.open(sub.cancelUrl, "_blank"));
		}
		const editBtn = actions.createEl("button", { cls: "fpih-btn fpih-btn--ghost fpih-btn--icon", attr: { type: "button", "aria-label": `Edit ${sub.name}` } });
		icon(editBtn, "pencil");
		editBtn.addEventListener("click", () => openSubscriptionWizard(plugin, sub, () => render()));
		const deleteBtn = actions.createEl("button", { cls: "fpih-btn fpih-btn--ghost fpih-btn--icon", attr: { type: "button", "aria-label": `Delete ${sub.name}` } });
		icon(deleteBtn, "trash-2");
		deleteBtn.addEventListener("click", () => void remove(sub));
	}

	async function remove(sub: Subscription): Promise<void> {
		plugin.store.subscriptions = plugin.store.subscriptions.filter((s) => s.id !== sub.id);
		await plugin.store.saveSubscriptions();
		new Notice(`Removed "${sub.name}"`);
		render();
	}

	render();
}
