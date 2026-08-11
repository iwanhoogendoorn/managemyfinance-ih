/**
 * Every plugin dialog that is open right now.
 *
 * Switching portfolio re-points the *same* `FinanceStore` at another folder and reloads it, so any
 * dialog still on screen is holding data — parsed import rows, a review queue's transaction ids, a
 * prefilled subscription — that belongs to the portfolio you just left. Writing it lands in the new
 * portfolio's files. Closing the dialogs is the layer that stops that happening at all; the
 * `store.generation` check inside the write paths is the backstop for anything that slips through
 * (a dialog opened *during* the switch, or a modal that never registered).
 *
 * Deliberately a module singleton rather than a field on the plugin: `WizardModal` is constructed
 * with an `App`, not a plugin, and importing the plugin class into it would close an import cycle
 * (main → wizards → main). Registration is by interface, so nothing here depends on Obsidian either.
 *
 * Everything that touches portfolio-scoped data registers. The two portfolio-management dialogs
 * (`ManagePortfoliosModal`, `ConfirmDeletePortfolioModal`) deliberately do not: they edit the global
 * roster, they are usually the thing *causing* the switch, and closing them mid-action would pull the
 * screen out from under the user who just clicked in it.
 */

export interface ClosableModal {
	close: () => void;
}

const openModals = new Set<ClosableModal>();

/** Call from `onOpen`. */
export function registerOpenModal(modal: ClosableModal): void {
	openModals.add(modal);
}

/** Call from `onClose` — Obsidian fires it for every exit path (Esc, backdrop, `close()`). */
export function unregisterOpenModal(modal: ClosableModal): void {
	openModals.delete(modal);
}

/** Closes everything registered. Iterates a copy because `close()` re-enters `unregisterOpenModal`. */
export function closeAllPluginModals(): void {
	for (const modal of [...openModals]) modal.close();
	openModals.clear();
}
