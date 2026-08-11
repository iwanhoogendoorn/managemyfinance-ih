import { CardDetailModal } from "../../modals/CardDetailModal";
import type FinancePlugin from "../../main";
import type { Card } from "../../types";
import { renderCardVisual } from "../../ui/cardVisual";
import { emptyState, icon } from "../../ui/dom";
import { openCardWizard } from "../../wizards/CardWizard";

/** One card, per your bank/card issuer: always linked to an account, counted and shown completely separately from it. */
export function renderCardsSection(container: HTMLElement, plugin: FinancePlugin): void {
	container.addClass("fp-section");

	function render(): void {
		container.empty();
		const store = plugin.store;
		const cards = store.cards;

		const header = container.createDiv({ cls: "fp-section-header" });
		const headText = header.createDiv();
		headText.createEl("h2", { text: "Cards" });
		headText.createDiv({
			cls: "fp-section-subtitle",
			text: "Every payment card you carry, linked to the account it actually draws money from or borrows against.",
		});
		const addBtn = header.createEl("button", { cls: "fp-btn fp-btn--primary", attr: { type: "button" } });
		icon(addBtn, "plus");
		addBtn.createSpan({ text: "Add card" });
		addBtn.addEventListener("click", () => openCardWizard(plugin, { onSaved: () => render() }));

		// No KPI tiles here on purpose. `Transaction` carries no `cardId`, so card-level spend is not
		// computable — "Cards: 4" and "Accounts covered: 3/5" were counting the page's own contents
		// back at the reader. This page is a visual inventory, and that is a fine thing to be.

		if (store.accounts.length === 0) {
			emptyState(container, {
				iconName: "credit-card",
				title: "Add an account first",
				description: "Cards always link to an account — set one up, then come back to add its cards.",
			});
			return;
		}

		if (cards.length === 0) {
			emptyState(container, {
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

		const grid = container.createDiv({ cls: "fp-card-grid" });
		sorted.forEach((card) => renderCardTile(grid, card, accountById.get(card.accountId)?.name ?? "Unknown account"));
	}

	function renderCardTile(parent: HTMLElement, card: Card, accountName: string): void {
		// A real <button>: the tile was a click-handler <div>, so it was neither focusable nor announced.
		const tile = parent.createEl("button", {
			cls: "fp-card-tile fp-card-tile-clickable",
			attr: { type: "button", "aria-label": `${card.name} on ${accountName}` },
		});
		tile.createDiv({ cls: "fp-card-tile-account", text: accountName });
		renderCardVisual(tile, card);
		tile.addEventListener("click", () => new CardDetailModal(plugin.app, plugin, card, accountName, () => render()).open());
	}

	render();
}
