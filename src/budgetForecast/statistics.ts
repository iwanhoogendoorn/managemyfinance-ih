/**
 * Small, deterministic statistics primitives — the arithmetic every forecast method in this
 * subsystem is built from. Nothing here knows about categories, transactions, or dates; it takes
 * plain number arrays and returns plain numbers, which is what makes it independently testable and
 * cheap to reason about (see budget_spec.md §54).
 *
 * One quantile method is used everywhere in this subsystem — R7 / Excel's PERCENTILE.INC, chosen so
 * a hand cross-check against a spreadsheet built the same way agrees (§17). Nothing downstream is
 * allowed to invent a second interpolation method.
 */

/** The value below which `q` (0–1) of `values` falls, by linear interpolation between the two
 *  nearest ranks — R7 / Excel's PERCENTILE.INC. Undefined for an empty sample; the sample's only
 *  value for a single-element one, since there is nothing to interpolate between. */
export function quantileR7(values: number[], q: number): number | undefined {
	if (values.length === 0) return undefined;
	if (values.length === 1) return values[0];
	const sorted = [...values].sort((a, b) => a - b);
	const idx = q * (sorted.length - 1);
	const lower = Math.floor(idx);
	const upper = Math.ceil(idx);
	if (lower === upper) return sorted[lower];
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

/** The middle value — `quantileR7` at 0.5, named separately since "median" is the vocabulary every
 *  other formula in this module states itself in. */
export function median(values: number[]): number | undefined {
	return quantileR7(values, 0.5);
}

/** Median Absolute Deviation — how far, typically, a value strays from the sample's median. The
 *  robust counterpart to standard deviation: one huge outlier barely moves it, which is exactly the
 *  property outlier detection needs (a metric an outlier can't drag around undermines itself). Zero
 *  for an empty sample or a sample with no spread at all. */
export function mad(values: number[]): number {
	const m = median(values) ?? 0;
	return median(values.map((v) => Math.abs(v - m))) ?? 0;
}

/** How many MADs `value` sits from `med` — Iglewicz & Hoaglin's modified z-score, the standard
 *  MAD-based outlier statistic (the 0.6745 constant scales MAD to be comparable with a normal
 *  distribution's standard deviation). Zero when `madValue` is zero (every value identical, or too
 *  few values to have spread) rather than dividing by zero — callers that need a fallback in that
 *  case (Tukey fences, per §21) apply it themselves; this primitive just reports "no measurable
 *  deviation" honestly. */
export function modifiedZScore(value: number, med: number, madValue: number): number {
	if (madValue === 0) return 0;
	return (0.6745 * (value - med)) / madValue;
}

/** P75 − P25 — the middle 50% of the sample's spread, in the sample's own units (euros). Zero when
 *  there isn't a real P25/P75 to subtract (an empty sample). */
export function iqr(values: number[]): number {
	const p25 = quantileR7(values, 0.25);
	const p75 = quantileR7(values, 0.75);
	if (p25 === undefined || p75 === undefined) return 0;
	return p75 - p25;
}

/** Below this, a P50 close to €0 would make `relativeIqr` blow up toward infinity over an amount
 *  that isn't actually meaningfully volatile — a cent-scale floor keeps the ratio finite without
 *  distorting it at any real spending level. */
const RELATIVE_IQR_EPSILON = 0.01;

/** IQR scaled by the sample's own median, so "how volatile is this category" reads the same way for
 *  a €50/month category and a €5,000/month one — an absolute IQR can't be compared across categories
 *  at different spending levels, but this can. */
export function relativeIqr(values: number[]): number {
	const p50 = quantileR7(values, 0.5) ?? 0;
	return iqr(values) / Math.max(p50, RELATIVE_IQR_EPSILON);
}

/** Bowley's quartile skewness: how lopsided the sample is around its median, using only quantiles
 *  (robust, unlike the mean-based classical skewness formula, to the same outliers a spending
 *  history is full of). Positive means the P75 tail stretches further from the median than the P25
 *  tail does (a "usually moderate, occasionally very expensive" shape); negative is the mirror.
 *  Zero — "effectively stable" — when P75 equals P25, since there is no spread to be lopsided in. */
export function bowleySkewness(values: number[]): number {
	const p25 = quantileR7(values, 0.25) ?? 0;
	const p50 = quantileR7(values, 0.5) ?? 0;
	const p75 = quantileR7(values, 0.75) ?? 0;
	const spread = p75 - p25;
	if (spread === 0) return 0;
	return (p75 + p25 - 2 * p50) / spread;
}

export interface TheilSenFit {
	slope: number;
	intercept: number;
}

/**
 * Theil–Sen estimator: a trend line fitted through the *median* of every pairwise slope between the
 * points, rather than least-squares' minimisation of squared error. The difference matters here
 * specifically because one unusually expensive month in an ordinary least-squares fit gets squared
 * and ends up dominating the whole line; a median of pairwise slopes barely notices it, as long as
 * it's not the majority of the data (§14, and the robustness test in §55 exists precisely to pin
 * this down).
 *
 * `points` are `{ x, y }` — sequential period index and that period's net economic expense.
 * Undefined for no points at all; a flat line through the single point when there's only one.
 */
export function theilSen(points: { x: number; y: number }[]): TheilSenFit | undefined {
	if (points.length === 0) return undefined;
	if (points.length === 1) return { slope: 0, intercept: points[0].y };

	const slopes: number[] = [];
	for (let i = 0; i < points.length; i++) {
		for (let j = i + 1; j < points.length; j++) {
			const dx = points[j].x - points[i].x;
			if (dx === 0) continue;
			slopes.push((points[j].y - points[i].y) / dx);
		}
	}
	const slope = median(slopes) ?? 0;
	const intercept = median(points.map((p) => p.y - slope * p.x)) ?? 0;
	return { slope, intercept };
}

/** The fitted trend's level at `x`, clamped to never go negative — a forecast spending level below
 *  €0 isn't a real answer, whatever the raw line says out at the edges of the fit. */
export function theilSenLevelAt(fit: TheilSenFit, x: number): number {
	return Math.max(0, fit.intercept + fit.slope * x);
}
