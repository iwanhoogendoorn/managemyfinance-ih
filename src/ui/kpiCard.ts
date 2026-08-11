import { renderStat } from "./dom";

/**
 * @deprecated Use {@link renderStat} from `ui/dom`. Kept as a delegating wrapper: `hero` maps to the
 * `--hero` size, and everything else is a straight pass-through, so sections migrate at their pace.
 */
export function renderKpiCard(
	container: HTMLElement,
	opts: {
		label: string;
		value: string;
		hero?: boolean;
		delta?: { value: number; goodIfUp?: boolean };
		sparklineValues?: number[];
		sparklineColor?: string;
		sub?: string;
		money?: boolean;
	}
): HTMLElement {
	return renderStat(container, {
		label: opts.label,
		value: opts.value,
		size: opts.hero ? "hero" : "default",
		delta: opts.delta,
		sparklineValues: opts.sparklineValues,
		sparklineColor: opts.sparklineColor,
		sub: opts.sub,
		money: opts.money,
	});
}

export interface MeterOpts {
	label: string;
	/** 0–1. Values above 1 render a hatched overflow tail rather than clamping invisibly. */
	value: number;
	valueLabel: string;
	sub?: string;
	renderSub?: (el: HTMLElement) => void;
	/**
	 * 0–1 position of the pace marker — how far through the period you are. Turns "78% spent" from
	 * a number into a judgement. Omitted means no marker.
	 */
	pace?: number;
	/** Overrides the automatic <80 / 80–100 / >100 thresholds when the caller knows better. */
	tone?: "ok" | "warn" | "over";
}

/**
 * Meter contract: a single ratio against a limit. Fill in the accent below 80%, warn to 100%, and a
 * hatched overflow tail past it — paired with the caller's own wording ("€66 left" / "€22 over"),
 * because status color never carries meaning alone.
 */
export function renderMeter(container: HTMLElement, opts: MeterOpts): HTMLElement {
	const ratio = Number.isFinite(opts.value) ? opts.value : 0;
	const tone = opts.tone ?? (ratio > 1 ? "over" : ratio >= 0.8 ? "warn" : "ok");

	const card = container.createDiv({
		cls: `fp-meter fp-card fp-meter-card fp-meter--${tone}`,
	});
	const head = card.createDiv({ cls: "fp-meter-head" });
	head.createSpan({ cls: "fp-meter-label", text: opts.label });
	head.createSpan({ cls: "fp-meter-value fp-money", text: opts.valueLabel });

	const track = card.createDiv({ cls: "fp-meter-track" });
	const fill = track.createDiv({ cls: "fp-meter-fill" });
	const pct = Math.max(0, Math.min(100, ratio * 100));
	fill.style.width = `${pct}%`;
	// The hatched tail starts where the fill caps, so "110% spent" is visible rather than clamped.
	track.style.setProperty("--fp-meter-cap", `${pct}%`);

	track.setAttribute("role", "progressbar");
	track.setAttribute("aria-valuemin", "0");
	track.setAttribute("aria-valuemax", "100");
	track.setAttribute("aria-valuenow", String(Math.round(pct)));
	track.setAttribute("aria-label", opts.label);

	if (opts.pace !== undefined && opts.pace > 0 && opts.pace < 1) {
		const marker = track.createDiv({ cls: "fp-meter-pace" });
		marker.style.left = `${opts.pace * 100}%`;
		marker.setAttribute("title", `Pace: ${Math.round(opts.pace * 100)}% through the period`);
	}

	if (opts.renderSub) opts.renderSub(card.createDiv({ cls: "fp-meter-sub" }));
	else if (opts.sub) card.createDiv({ cls: "fp-meter-sub", text: opts.sub });
	return card;
}
