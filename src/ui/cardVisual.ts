import { cardStyle } from "../cards";
import type { Card } from "../types";

const NETWORK_TEXT: Partial<Record<Card["network"], string>> = {
	visa: "VISA",
	amex: "AMEX",
	discover: "DISCOVER",
	other: "CARD",
};

/**
 * `network` already drives the mark shown here (Mastercard's two-circle device vs. a wordmark for
 * everyone else) — this only extends that existing branch with a few more polish touches, it doesn't
 * replace the approach.
 */
function renderNetworkMark(parent: HTMLElement, network: Card["network"]): void {
	const mark = parent.createDiv({ cls: `fp-card-visual-network fp-card-network-${network}` });
	if (network === "mastercard") {
		mark.createDiv({ cls: "fp-card-network-circle fp-card-network-circle-a" });
		mark.createDiv({ cls: "fp-card-network-circle fp-card-network-circle-b" });
	} else {
		mark.createSpan({ text: NETWORK_TEXT[network] ?? "" });
	}
}

export type CardVisualData = Pick<
	Card,
	"name" | "product" | "issuer" | "network" | "cardType" | "last4" | "expiry" | "isPrimary"
>;

/**
 * A stylized, tilt-on-hover card face — tier/issuer/network-driven art (see cards.ts), not literal
 * bank artwork. The tilt/shine tracks the cursor for a subtle "physical card" feel on hover.
 */
export function renderCardVisual(parent: HTMLElement, card: CardVisualData, cls?: string): HTMLElement {
	const style = cardStyle(card);
	const face = parent.createDiv({
		cls: ["fp-card-visual", style.isLight ? "fp-card-visual-light" : "", cls].filter(Boolean).join(" "),
	});
	face.style.setProperty("--fp-card-gradient", style.gradient);
	face.style.setProperty("--fp-card-text", style.textColor);

	const shine = face.createDiv({ cls: "fp-card-visual-shine" });

	const top = face.createDiv({ cls: "fp-card-visual-top" });
	top.createDiv({ cls: "fp-card-visual-issuer", text: card.issuer || card.product || "" });
	if (card.isPrimary) top.createDiv({ cls: "fp-card-visual-primary", text: "PRIMARY" });

	const chipRow = face.createDiv({ cls: "fp-card-visual-chip-row" });
	const chip = chipRow.createDiv({ cls: "fp-card-visual-chip" });
	chip.createDiv({ cls: "fp-card-visual-chip-lines" });
	chipRow.createDiv({ cls: "fp-card-visual-contactless" });
	face.createDiv({
		cls: "fp-card-visual-number",
		text: card.last4 ? `•••• •••• •••• ${card.last4}` : "•••• •••• •••• ••••",
	});

	const bottom = face.createDiv({ cls: "fp-card-visual-bottom" });
	const nameCol = bottom.createDiv({ cls: "fp-card-visual-name-col" });
	nameCol.createDiv({ cls: "fp-card-visual-label", text: "CARDHOLDER" });
	nameCol.createDiv({ cls: "fp-card-visual-name", text: card.name });
	if (card.expiry) {
		const expCol = bottom.createDiv({ cls: "fp-card-visual-exp-col" });
		expCol.createDiv({ cls: "fp-card-visual-label", text: "EXP" });
		expCol.createDiv({ cls: "fp-card-visual-exp", text: card.expiry });
	}
	renderNetworkMark(bottom, card.network);

	// The tilt is the one deliberate transform-lift in the app, so it gets the two guards the old
	// implementation lacked: it is skipped entirely when the user asks for reduced motion, and the
	// writes are batched into a frame instead of one style recalc per mousemove event.
	const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
	let raf = 0;
	let pending: { x: number; y: number } | undefined;

	face.addEventListener("mousemove", (ev: MouseEvent) => {
		if (reduceMotion.matches) return;
		const rect = face.getBoundingClientRect();
		pending = { x: (ev.clientX - rect.left) / rect.width, y: (ev.clientY - rect.top) / rect.height };
		if (raf) return;
		raf = requestAnimationFrame(() => {
			raf = 0;
			if (!pending) return;
			const { x, y } = pending;
			const rotateY = (x - 0.5) * 14;
			const rotateX = (0.5 - y) * 10;
			face.style.transform = `perspective(700px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale3d(1.02, 1.02, 1.02)`;
			shine.style.background = `radial-gradient(circle at ${x * 100}% ${y * 100}%, rgba(255,255,255,0.35), transparent 55%)`;
		});
	});
	face.addEventListener("mouseleave", () => {
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
		pending = undefined;
		face.style.transform = "";
		shine.style.background = "";
	});

	return face;
}
