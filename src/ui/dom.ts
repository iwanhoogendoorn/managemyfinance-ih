import { setIcon } from "obsidian";
import { sparkline } from "./charts";

export type Tone = "good" | "warn" | "bad" | "neutral";

export function icon(parent: HTMLElement, name: string, cls?: string): HTMLElement {
	const span = parent.createSpan({ cls: ["fp-icon", cls].filter(Boolean).join(" ") });
	setIcon(span, name);
	return span;
}

/* ==========================================================================
   Stat — the single figure component
   ========================================================================== */

export interface StatOpts {
	label: string;
	value: string;
	/** `hero` is 38px and there is at most ONE per view; `compact` is the two-up narrow fallback. */
	size?: "hero" | "default" | "compact";
	iconName?: string;
	/** Kept for the legacy `statTile` contract. `bad` now tints only the border — no accent stripe. */
	tone?: Tone;
	delta?: { value: number; goodIfUp?: boolean };
	sparklineValues?: number[];
	sparklineColor?: string;
	sub?: string;
	/** `false` opts the value out of privacy redaction (counts, ratios — not money). */
	money?: boolean;
}

/** ▲ / ▼ / — as inline SVG, so the delta chip never relies on color alone to carry direction. */
function deltaGlyph(parent: HTMLElement, dir: 1 | -1 | 0): void {
	const NS = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("viewBox", "0 0 12 12");
	svg.setAttribute("aria-hidden", "true");
	const path = document.createElementNS(NS, "path");
	path.setAttribute("d", dir === 1 ? "M6 2.5 10 8H2z" : dir === -1 ? "M6 9.5 2 4h8z" : "M2.5 6h7");
	path.setAttribute("fill", dir === 0 ? "none" : "currentColor");
	if (dir === 0) {
		path.setAttribute("stroke", "currentColor");
		path.setAttribute("stroke-width", "1.6");
		path.setAttribute("stroke-linecap", "round");
	}
	svg.appendChild(path);
	parent.appendChild(svg);
}

/**
 * The one stat component: eyebrow · value · delta chip · sparkline · footnote.
 *
 * Replaces the old `statTile()`/`renderKpiCard()` split, which rendered the same concept — "Current
 * balance" — as two visually different objects depending on which page you were on. Both remain
 * exported as thin wrappers so sections can migrate at their own pace.
 */
export function renderStat(parent: HTMLElement, opts: StatOpts): HTMLElement {
	const size = opts.size ?? "default";
	const tone = opts.tone ?? "neutral";
	const card = parent.createDiv({
		cls: [
			"fp-stat",
			"fp-card",
			"fp-card--tight",
			size === "hero" ? "fp-stat--hero" : "",
			size === "compact" ? "fp-stat--compact" : "",
			tone === "bad" ? "fp-stat--danger" : "",
			// Legacy tone hook — sections still read `.fp-tone-*` for their own rules.
			`fp-tone-${tone}`,
		]
			.filter(Boolean)
			.join(" "),
	});

	const eyebrow = card.createDiv({ cls: "fp-stat-eyebrow fp-overline" });
	if (opts.iconName) icon(eyebrow, opts.iconName, "fp-stat-icon");
	eyebrow.createSpan({ cls: "fp-stat-label", text: opts.label });

	if (opts.delta) {
		const raw = opts.delta.value;
		const good = opts.delta.goodIfUp === false ? raw <= 0 : raw >= 0;
		const dir: 1 | -1 | 0 = raw > 0 ? 1 : raw < 0 ? -1 : 0;
		const chip = eyebrow.createSpan({
			cls: "fp-delta " + (dir === 0 ? "fp-delta--flat" : good ? "fp-delta--good" : "fp-delta--bad"),
		});
		deltaGlyph(chip, dir);
		chip.createSpan({ text: `${raw >= 0 ? "+" : ""}${(raw * 100).toFixed(1)}%` });
	}

	const body = card.createDiv({ cls: "fp-stat-body" });
	body.createDiv({
		cls: "fp-stat-value" + (opts.money === false ? "" : " fp-money"),
		text: opts.value,
	});
	if (opts.sparklineValues && opts.sparklineValues.length > 1) {
		const sparkWrap = body.createDiv({ cls: "fp-stat-spark" });
		sparkline(sparkWrap, opts.sparklineValues, opts.sparklineColor ?? "var(--fp-accent-ink)");
	}

	if (opts.sub) card.createDiv({ cls: "fp-stat-foot", text: opts.sub });
	return card;
}

/**
 * @deprecated Use {@link renderStat}. Kept as a delegating wrapper so the sections that have not
 * migrated yet keep compiling and rendering.
 */
export function statTile(
	parent: HTMLElement,
	opts: { label: string; value: string; sub?: string; iconName: string; tone?: Tone; money?: boolean }
): HTMLElement {
	return renderStat(parent, {
		label: opts.label,
		value: opts.value,
		sub: opts.sub,
		iconName: opts.iconName,
		tone: opts.tone,
		money: opts.money,
	});
}

export function badge(parent: HTMLElement, text: string, tone: Tone = "neutral"): HTMLElement {
	return parent.createSpan({ cls: `fp-badge fp-tone-${tone}`, text });
}

/** A colored square with the label's first letter — a logo stand-in that needs no network fetch. */
export function initialsAvatar(parent: HTMLElement, label: string, color: string, cls?: string): HTMLElement {
	const el = parent.createDiv({ cls: ["fp-avatar", cls].filter(Boolean).join(" ") });
	el.style.setProperty("--fp-avatar-color", color);
	el.setText((label.trim().charAt(0) || "?").toUpperCase());
	return el;
}

export function categoryChip(parent: HTMLElement, name: string, color: string, iconName?: string): HTMLElement {
	const chip = parent.createSpan({ cls: "fp-chip" });
	chip.style.setProperty("--fp-chip-color", color);
	if (iconName) icon(chip, iconName, "fp-chip-icon");
	chip.createSpan({ text: name });
	return chip;
}

/**
 * A small tab strip switching between panels rendered into the same container — first tab active by
 * default. Tabs are real `<button role="tab">`s with a roving tabindex, so they are focusable,
 * announced, and keyboard-operable (the old `<div>` implementation was none of those).
 */
export function tabSwitcher(container: HTMLElement, tabs: { label: string; render: (panel: HTMLElement) => void }[]): void {
	const header = container.createDiv({ cls: "fp-tabs", attr: { role: "tablist" } });
	const panels = container.createDiv({ cls: "fp-tab-panels" });
	const buttons: HTMLElement[] = [];
	const panelEls: HTMLElement[] = [];

	const select = (i: number) => {
		buttons.forEach((b, j) => {
			b.toggleClass("is-active", i === j);
			b.setAttribute("aria-selected", String(i === j));
			b.setAttribute("tabindex", i === j ? "0" : "-1");
		});
		panelEls.forEach((p, j) => p.toggleClass("is-hidden", i !== j));
	};

	tabs.forEach((tab, i) => {
		const btn = header.createEl("button", {
			cls: "fp-tab" + (i === 0 ? " is-active" : ""),
			text: tab.label,
			attr: { type: "button", role: "tab", "aria-selected": String(i === 0), tabindex: i === 0 ? "0" : "-1" },
		});
		const panel = panels.createDiv({ cls: "fp-tab-panel" + (i === 0 ? "" : " is-hidden"), attr: { role: "tabpanel" } });
		tab.render(panel);
		btn.addEventListener("click", () => select(i));
		btn.addEventListener("keydown", (ev: KeyboardEvent) => {
			const next = ev.key === "ArrowRight" ? i + 1 : ev.key === "ArrowLeft" ? i - 1 : -1;
			if (next < 0 || next >= tabs.length) return;
			ev.preventDefault();
			select(next);
			buttons[next].focus();
		});
		buttons.push(btn);
		panelEls.push(panel);
	});
}

export interface EmptyStateOpts {
	iconName: string;
	title: string;
	description: string;
	actionLabel?: string;
	onAction?: () => void;
	/** `inline` sits inside a card, `row` inside a table body. */
	variant?: "page" | "inline" | "row";
}

export function emptyState(parent: HTMLElement, opts: EmptyStateOpts): HTMLElement {
	const variant = opts.variant ?? "page";
	const wrap = parent.createDiv({
		cls: "fp-empty" + (variant === "inline" ? " fp-empty--inline" : variant === "row" ? " fp-empty--row" : ""),
	});
	// A neutral icon plate, not an accent circle: an accent disc on an empty screen implies a
	// primary action that is not there.
	const plate = wrap.createDiv({ cls: "fp-empty-icon" });
	icon(plate, opts.iconName);
	const text = wrap.createDiv({ cls: "fp-empty-text" });
	text.createDiv({ cls: "fp-empty-title", text: opts.title });
	text.createDiv({ cls: "fp-empty-desc", text: opts.description });
	if (opts.actionLabel && opts.onAction) {
		const btn = wrap.createEl("button", {
			cls: "fp-btn fp-btn--primary fp-btn-primary",
			text: opts.actionLabel,
			attr: { type: "button" },
		});
		btn.addEventListener("click", opts.onAction);
	}
	return wrap;
}
