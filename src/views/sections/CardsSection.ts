import { CardDetailModal } from "../../modals/CardDetailModal";
import type FinancePlugin from "../../main";
import type { Card } from "../../types";
import { renderCardVisual } from "../../ui/cardVisual";
import { emptyState, icon } from "../../ui/dom";
import { openCardWizard } from "../../wizards/CardWizard";

/** One card, per your bank/card issuer: always linked to an account, counted and shown completely separately from it. */
export function renderCardsSection(container: HTMLElement, plugin: FinancePlugin): void {
	// A root of our own, not the shared view body: `render()` is reachable from wizard and modal
	// callbacks that resolve after an await, by which time the user may have navigated. `container` is
	// the view body and stays connected regardless; a root we created dies with the body's `.empty()`.
	const root = container.createDiv({ cls: "fpih-section" });

	function render(): void {
		if (!root.isConnected) return;
		root.empty();
		const store = plugin.store;
		const cards = store.cards;

		const header = root.createDiv({ cls: "fpih-section-header" });
		const headText = header.createDiv();
		headText.createEl("h2", { text: "Cards" });
		headText.createDiv({
			cls: "fpih-section-subtitle",
			text: "Every payment card you carry, linked to the account it actually draws money from or borrows against.",
		});
		const addBtn = header.createEl("button", { cls: "fpih-btn fpih-btn--primary", attr: { type: "button" } });
		icon(addBtn, "plus");
		addBtn.createSpan({ text: "Add card" });
		addBtn.addEventListener("click", () => openCardWizard(plugin, { onSaved: () => render() }));

		// No KPI tiles here on purpose. `Transaction` carries no `cardId`, so card-level spend is not
		// computable — "Cards: 4" and "Accounts covered: 3/5" were counting the page's own contents
		// back at the reader. This page is a visual inventory, and that is a fine thing to be.

		if (store.accounts.length === 0) {
			emptyState(root, {
				iconName: "credit-card",
				title: "Add an account first",
				description: "Cards always link to an account — set one up, then come back to add its cards.",
			});
			return;
		}

		if (cards.length === 0) {
			emptyState(root, {
				iconName: "credit-card",
				title: "No cards tracked yet",
				description: "Add your first card and link it to one of your accounts.",
				actionLabel: "Add card",
				onAction: () => openCardWizard(plugin, { onSaved: () => render() }),
			});
			return;
		}

		const accountById = new Map(store.accounts.map((a) => [a.id, a]));
		const sorted = [...cards].sort((a, b) => {
			const an = accountById.get(a.accountId)?.name ?? "";
			const bn = accountById.get(b.accountId)?.name ?? "";
			return an.localeCompare(bn) || a.name.localeCompare(b.name);
		});

		const grid = root.createDiv({ cls: "fpih-card-grid" });
		sorted.forEach((card) => renderCardTile(grid, card, accountById.get(card.accountId)?.name ?? "Unknown account"));
	}

	function renderCardTile(parent: HTMLElement, card: Card, accountName: string): void {
		// A real <button>: the tile was a click-handler <div>, so it was neither focusable nor announced.
		const tile = parent.createEl("button", {
			cls: "fpih-card-tile fpih-card-tile-clickable",
			attr: { type: "button", "aria-label": `${card.name} on ${accountName}` },
		});
		tile.createDiv({ cls: "fpih-card-tile-account", text: accountName });
		renderCardVisual(tile, card);
		tile.addEventListener("click", () => new CardDetailModal(plugin.app, plugin, card, accountName, () => render()).open());
	}

	render();
}
