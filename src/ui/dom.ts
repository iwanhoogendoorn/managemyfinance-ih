import { setIcon } from "obsidian";
import type { Category } from "../types";
import { sparkline } from "./charts";

export type Tone = "good" | "warn" | "bad" | "neutral";

export function icon(parent: HTMLElement, name: string, cls?: string): HTMLElement {
	const span = parent.createSpan({ cls: ["fpih-icon", cls].filter(Boolean).join(" ") });
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
	/**
	 * `unit` is not decoration. `%` is a *relative* change (net worth grew 5%); `pp` is a difference
	 * of two rates (a savings rate moving 20% → 25% is +5pp, not +5%). Rendering both as "%" in the
	 * same chip made two different quantities look like one.
	 */
	delta?: { value: number; goodIfUp?: boolean; unit?: "%" | "pp" };
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
			"fpih-stat",
			"fpih-card",
			"fpih-card--tight",
			size === "hero" ? "fpih-stat--hero" : "",
			size === "compact" ? "fpih-stat--compact" : "",
			tone === "bad" ? "fpih-stat--danger" : "",
			// Legacy tone hook — sections still read `.fpih-tone-*` for their own rules.
			`fpih-tone-${tone}`,
		]
			.filter(Boolean)
			.join(" "),
	});

	const eyebrow = card.createDiv({ cls: "fpih-stat-eyebrow fpih-overline" });
	if (opts.iconName) icon(eyebrow, opts.iconName, "fpih-stat-icon");
	eyebrow.createSpan({ cls: "fpih-stat-label", text: opts.label });

	if (opts.delta) {
		const raw = opts.delta.value;
		const good = opts.delta.goodIfUp === false ? raw <= 0 : raw >= 0;
		const dir: 1 | -1 | 0 = raw > 0 ? 1 : raw < 0 ? -1 : 0;
		const chip = eyebrow.createSpan({
			cls: "fpih-delta " + (dir === 0 ? "fpih-delta--flat" : good ? "fpih-delta--good" : "fpih-delta--bad"),
		});
		deltaGlyph(chip, dir);
		chip.createSpan({ text: `${raw >= 0 ? "+" : ""}${(raw * 100).toFixed(1)}${opts.delta.unit ?? "%"}` });
	}

	const body = card.createDiv({ cls: "fpih-stat-body" });
	body.createDiv({
		cls: "fpih-stat-value" + (opts.money === false ? "" : " fpih-money"),
		text: opts.value,
	});
	if (opts.sparklineValues && opts.sparklineValues.length > 1) {
		const sparkWrap = body.createDiv({ cls: "fpih-stat-spark" });
		sparkline(sparkWrap, opts.sparklineValues, opts.sparklineColor ?? "var(--fpih-accent-ink)");
	}

	if (opts.sub) card.createDiv({ cls: "fpih-stat-foot", text: opts.sub });
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
	return parent.createSpan({ cls: `fpih-badge fpih-tone-${tone}`, text });
}

/** A colored square with the label's first letter — a logo stand-in that needs no network fetch. */
export function initialsAvatar(parent: HTMLElement, label: string, color: string, cls?: string): HTMLElement {
	const el = parent.createDiv({ cls: ["fpih-avatar", cls].filter(Boolean).join(" ") });
	el.style.setProperty("--fpih-avatar-color", color);
	el.setText((label.trim().charAt(0) || "?").toUpperCase());
	return el;
}

export function categoryChip(parent: HTMLElement, name: string, color: string, iconName?: string): HTMLElement {
	const chip = parent.createSpan({ cls: "fpih-chip" });
	chip.style.setProperty("--fpih-chip-color", color);
	if (iconName) icon(chip, iconName, "fpih-chip-icon");
	chip.createSpan({ text: name });
	return chip;
}

/**
 * A small tab strip switching between panels rendered into the same container — first tab active by
 * default. Tabs are real `<button role="tab">`s with a roving tabindex, so they are focusable,
 * announced, and keyboard-operable (the old `<div>` implementation was none of those).
 *
 * Panels render on *first activation*, not eagerly. Rendering a hidden panel meant every chart in it
 * mounted at 0×0 behind `display: none` — the ResizeObserver never saw a size change, so it never
 * ran its own disposal path and the observer outlived the DOM it watched. It also paid for charts
 * most readers never open. Each panel still renders at most once, so a caller that caches the panel
 * element it was handed (MonthDrilldownModal's Month tab) keeps a valid reference.
 */
export function tabSwitcher(container: HTMLElement, tabs: { label: string; render: (panel: HTMLElement) => void }[]): void {
	const header = container.createDiv({ cls: "fpih-tabs", attr: { role: "tablist" } });
	const panels = container.createDiv({ cls: "fpih-tab-panels" });
	const buttons: HTMLElement[] = [];
	const panelEls: HTMLElement[] = [];
	const rendered: boolean[] = [];

	const select = (i: number) => {
		buttons.forEach((b, j) => {
			b.toggleClass("is-active", i === j);
			b.setAttribute("aria-selected", String(i === j));
			b.setAttribute("tabindex", i === j ? "0" : "-1");
		});
		panelEls.forEach((p, j) => p.toggleClass("is-hidden", i !== j));
		if (!rendered[i]) {
			rendered[i] = true;
			tabs[i].render(panelEls[i]);
		}
	};

	tabs.forEach((tab, i) => {
		const btn = header.createEl("button", {
			cls: "fpih-tab" + (i === 0 ? " is-active" : ""),
			text: tab.label,
			attr: { type: "button", role: "tab", "aria-selected": String(i === 0), tabindex: i === 0 ? "0" : "-1" },
		});
		const panel = panels.createDiv({ cls: "fpih-tab-panel" + (i === 0 ? "" : " is-hidden"), attr: { role: "tabpanel" } });
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
		rendered.push(false);
	});

	// The first tab is active on mount, so it is rendered now — everything else waits for a click.
	if (tabs.length > 0) {
		rendered[0] = true;
		tabs[0].render(panelEls[0]);
	}
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
		cls: "fpih-empty" + (variant === "inline" ? " fpih-empty--inline" : variant === "row" ? " fpih-empty--row" : ""),
	});
	// A neutral icon plate, not an accent circle: an accent disc on an empty screen implies a
	// primary action that is not there.
	const plate = wrap.createDiv({ cls: "fpih-empty-icon" });
	icon(plate, opts.iconName);
	const text = wrap.createDiv({ cls: "fpih-empty-text" });
	text.createDiv({ cls: "fpih-empty-title", text: opts.title });
	text.createDiv({ cls: "fpih-empty-desc", text: opts.description });
	if (opts.actionLabel && opts.onAction) {
		const btn = wrap.createEl("button", {
			cls: "fpih-btn fpih-btn--primary fpih-btn-primary",
			text: opts.actionLabel,
			attr: { type: "button" },
		});
		btn.addEventListener("click", opts.onAction);
	}
	return wrap;
}

/**
 * Fills a `<select>` with every category, subcategories nested under their parent as `<optgroup>`
 * entries. One helper because a dozen surfaces build this same picker, and a hierarchy that renders
 * differently in each of them is worse than no hierarchy at all.
 *
 * A parent that has children is still selectable — filed under the heading without picking a
 * subcategory is a legitimate answer, and forcing a choice would strand every transaction that was
 * categorized before the subcategory existed. `<optgroup>` labels aren't selectable in HTML, so the
 * parent is emitted as the group's own first option, marked to read as the general case.
 */
export function fillCategorySelect(
	select: HTMLSelectElement,
	categories: Category[],
	opts: { includeArchived?: boolean } = {}
): void {
	const visible = opts.includeArchived ? categories : categories.filter((c) => !c.archived);
	const byId = new Set(visible.map((c) => c.id));
	const children = new Map<string, Category[]>();
	for (const cat of visible) {
		if (!cat.parentId || !byId.has(cat.parentId)) continue;
		const bucket = children.get(cat.parentId);
		if (bucket) bucket.push(cat);
		else children.set(cat.parentId, [cat]);
	}

	for (const cat of visible) {
		// Subcategories are emitted under their parent, never again at the top level.
		if (cat.parentId && byId.has(cat.parentId)) continue;
		const kids = children.get(cat.id);
		if (!kids || kids.length === 0) {
			select.createEl("option", { text: cat.name, value: cat.id });
			continue;
		}
		const group = select.createEl("optgroup", { attr: { label: cat.name } });
		group.createEl("option", { text: `${cat.name} (general)`, value: cat.id });
		kids.forEach((kid) => group.createEl("option", { text: kid.name, value: kid.id }));
	}
}

/** "Food › Restaurants" for a subcategory, plain name for a top-level one — for the places that show
 *  a category as text rather than as a picker, where the child's name alone loses its context. */
export function categoryPathLabel(categories: Category[], categoryId: string | undefined): string | undefined {
	const cat = categories.find((c) => c.id === categoryId);
	if (!cat) return undefined;
	const parent = cat.parentId ? categories.find((c) => c.id === cat.parentId) : undefined;
	return parent ? `${parent.name} › ${cat.name}` : cat.name;
}
