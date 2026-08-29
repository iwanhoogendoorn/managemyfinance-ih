import { mad, median, modifiedZScore, quantileR7 } from "./statistics";
import type { BudgetForecastMethod, BudgetForecastOutlier, ForecastObservation } from "./types";

/**
 * Step 9 (budget_spec.md §21–24) — unusual historical periods, surfaced rather than silently kept or
 * silently dropped. Detected on each observation's own `normalizedValue` (never the raw `amount`), so
 * ordinary multi-year growth in a category's spending is never mistaken for an anomaly.
 *
 * Modified Z-score off the sample's Median Absolute Deviation is the primary test (§22) — falls back
 * to Tukey fences only when every observation shares the same normalized value (MAD is 0, which would
 * otherwise divide by zero rather than correctly report "nothing stands out here").
 *
 * Fewer than four observations isn't a peer group an "outlier" can meaningfully stand out from — a
 * single expensive month with only one or two comparable prior periods gets its due weight from
 * confidence's own sample-size scoring instead, not from being flagged unusual on this thin a sample.
 */
const MIN_OBSERVATIONS = 4;
const MODIFIED_Z_THRESHOLD = 3.5;
const TUKEY_FENCE_MULTIPLIER = 1.5;

export function detectOutliers(observations: ForecastObservation[], method: BudgetForecastMethod): BudgetForecastOutlier[] {
	if (observations.length < MIN_OBSERVATIONS) return [];

	const values = observations.map((o) => o.normalizedValue);
	const med = median(values) ?? 0;
	const madValue = mad(values);

	let isFlagged: (value: number) => boolean;
	if (madValue > 0) {
		isFlagged = (value) => Math.abs(modifiedZScore(value, med, madValue)) > MODIFIED_Z_THRESHOLD;
	} else {
		// Every value identical (or near enough that MAD rounds to 0) — modified Z-score can't say
		// anything here, so fall back to Tukey fences on the sample's own quantiles (§22).
		const q25 = quantileR7(values, 0.25) ?? med;
		const q75 = quantileR7(values, 0.75) ?? med;
		const spread = q75 - q25;
		const lower = q25 - TUKEY_FENCE_MULTIPLIER * spread;
		const upper = q75 + TUKEY_FENCE_MULTIPLIER * spread;
		isFlagged = (value) => value < lower || value > upper;
	}

	// Sinking-fund categories must never auto-exclude a genuinely large one-off (§23) — that's exactly
	// the risk the fund exists to absorb. Every other method defaults to excluding a flagged period
	// from its own statistical forecast, the same way seasonal-quantile and recurring-variable do.
	const includedByDefault = method === "sinking-fund";

	return observations
		.filter((o) => isFlagged(o.normalizedValue))
		.map((o) => ({
			id: o.id,
			period: o.period,
			amount: o.amount,
			normalizedValue: o.normalizedValue,
			reason:
				o.normalizedValue > med
					? "Much higher than other comparable periods after adjusting for your normal spending level."
					: "Much lower than other comparable periods after adjusting for your normal spending level.",
			includedByDefault,
		}));
}
