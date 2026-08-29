import { bowleySkewness } from "./statistics";
import type { DistributionShape, SeasonalityStrength, VolatilityLabel } from "./types";

/**
 * Turning already-computed statistics into the plain labels a forecast's diagnostics carry (§18–20).
 * Shared across every forecast method — the thresholds live here once so a category's volatility
 * reads the same way regardless of which method (seasonal-quantile, sinking-fund, ...) produced it.
 */

export const VOLATILITY_THRESHOLDS = { moderate: 0.2, high: 0.5 } as const;

export function volatilityLabel(relativeIqr: number): VolatilityLabel {
	if (relativeIqr >= VOLATILITY_THRESHOLDS.high) return "high";
	if (relativeIqr >= VOLATILITY_THRESHOLDS.moderate) return "moderate";
	return "low";
}

/** Bowley skewness magnitude below which a distribution reads as symmetric rather than lopsided. */
export const SKEW_THRESHOLD = 0.2;

/**
 * Whether a sample of comparable values reads as balanced or lopsided — sparse overrides skew
 * entirely, since "half the months are exactly €0" isn't a shape a skewness figure describes well
 * (§19: "more than 50% of complete observed periods are zero" always reads as sparse).
 */
export function distributionShape(values: number[], sparseMonthRatio: number): DistributionShape {
	if (sparseMonthRatio > 0.5) return "sparse";
	if (values.length < 2) return "unknown";
	const skew = bowleySkewness(values);
	if (skew >= SKEW_THRESHOLD) return "right-skewed";
	if (skew <= -SKEW_THRESHOLD) return "left-skewed";
	return "symmetric";
}

export const SEASONALITY_STRENGTH_THRESHOLDS = { moderate: 0.1, strong: 0.25 } as const;

/** `spread` is the max-minus-min of each month-of-year's own median seasonal ratio (§20) — undefined
 *  when there wasn't enough history across enough distinct months to compare at all. */
export function seasonalityStrengthLabel(spread: number | undefined): SeasonalityStrength {
	if (spread === undefined) return "unknown";
	if (spread === 0) return "none";
	if (spread < SEASONALITY_STRENGTH_THRESHOLDS.moderate) return "weak";
	if (spread < SEASONALITY_STRENGTH_THRESHOLDS.strong) return "moderate";
	return "strong";
}
