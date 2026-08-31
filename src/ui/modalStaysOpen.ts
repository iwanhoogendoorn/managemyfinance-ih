import type { Modal } from "obsidian";

/**
 * Let a dialog survive a click on the rest of Obsidian.
 *
 * Obsidian closes a modal when its backdrop is clicked, and that backdrop covers the whole window —
 * so reaching a workspace tab means clicking the backdrop first, and a half-filled form is gone
 * before the tab has switched. Anyone who opens "Add account" to go and copy an IBAN out of a note
 * loses everything they had typed, for having looked something up.
 *
 * Making the backdrop transparent to pointer events fixes both halves at once: no click ever lands on
 * it, so nothing dismisses the dialog, and the click carries through to whatever is behind, so the
 * tab switch actually happens. The dialog itself keeps its own pointer events and stays usable while
 * the app is used around it.
 *
 * Dismissal is unaffected where it was deliberate — Escape still closes, and so does every one of
 * these dialogs' own Cancel button. What goes away is only the accidental kind.
 */
export function keepOpenWhenClickingAway(modal: Modal): void {
	modal.containerEl.addClass("fp-modal-stays-open");
}
