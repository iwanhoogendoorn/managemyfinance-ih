import type { BudgetScenarioKey, ConfidenceLabel } from "./types";

/**
 * Turning "how much and how good is the history behind this number" into one 0–100 score and a
 * plain Low/Moderate/High label — never a probability (see budget_spec.md §28: this is a data/model
 * quality score, not a claim about how likely the actual spend is to land there).
 *
 * Six components, each capped at its own maximum so no single signal can dominate the others —
 * a category with a huge sample but wildly unstable spending shouldn't read as confidently as one
 * with a smaller, steady sample.
 */

export interface ConfidenceInputs {
	/** Same-period years for a seasonal forecast, historical years for a sinking fund, etc. —
	 *  whatever `comparableObservations` means for the method that's asking. */
	comparableObservations: number;
	recentCompleteMonths: number;
	/** 0–1: how much of the window this history could have covered actually has tracked data. */
	coverageRatio: number;
	relativeIqr: number;
	/** flagged outliers ÷ raw comparable observations before any were excluded. */
	outlierRatio: number;
	/** 0–1: share of complete observed periods with zero economic expense. */
	sparseMonthRatio: number;
}

/** The confidence-score band boundaries — the one place these three numbers are allowed to appear,
 *  so a boundary never drifts out of sync between the scorer and whatever labels it (§27). */
export const CONFIDENCE_LABEL_THRESHOLDS = { high: 75, moderate: 50 } as const;

/** Eight comparable years/months is treated as "as good as it gets" — beyond that, more history
 *  stops adding to this component (though it can still help elsewhere, e.g. via `outlierRatio`). */
export function sampleScore(comparableObservations: number): number {
	return Math.min(comparableObservations / 8, 1) * 35;
}

/** Six complete recent months is enough to trust the current-level baseline this component scores. */
export function recentDataScore(recentCompleteMonths: number): number {
	return Math.min(recentCompleteMonths / 6, 1) * 15;
}

export function coverageScore(coverageRatio: number): number {
	return coverageRatio * 15;
}

/** Rewards a tight P25–P75 spread relative to the median — a volatile category can still have a
 *  perfectly adequate sample size, but the number itself is inherently less trustworthy to commit to. */
export function stabilityScore(relativeIqr: number): number {
	return (1 - Math.min(relativeIqr, 1)) * 20;
}

/** Reaches zero once a quarter or more of the raw comparable observations needed flagging — at that
 *  point the "normal" distribution being modeled is itself in question. */
export function outlierScore(outlierRatio: number): number {
	return (1 - Math.min(outlierRatio / 0.25, 1)) * 10;
}

export function sparsityScore(sparseMonthRatio: number): number {
	return (1 - sparseMonthRatio) * 5;
}

/** The scenario-independent score every P25/P50/P75 confidence starts from, before the tail penalty
 *  below. Not clamped here — `scenarioConfidence` clamps once, after its own adjustment, so an
 *  input combination that sums past 100 doesn't get silently capped twice. */
export function baseConfidence(inputs: ConfidenceInputs): number {
	return (
		sampleScore(inputs.comparableObservations) +
		recentDataScore(inputs.recentCompleteMonths) +
		coverageScore(inputs.coverageRatio) +
		stabilityScore(inputs.relativeIqr) +
		outlierScore(inputs.outlierRatio) +
		sparsityScore(inputs.sparseMonthRatio)
	);
}

/**
 * The tails need more data than the middle to estimate reliably — P25 and P75 are read off the
 * edges of the sample, where a handful of points swings the answer far more than it would swing the
 * median. So every non-median scenario starts 5 points down from the base score, and a further 5
 * down when there are fewer than 8 comparable observations to draw the tail from at all. P50 carries
 * no penalty. The result is clamped to 0–100 only here, once, as the final step.
 */
export function scenarioConfidence(base: number, scenario: BudgetScenarioKey, comparableObservations: number): number {
	let score = base;
	if (scenario !== "p50") {
		score -= 5;
		if (comparableObservations < 8) score -= 5;
	}
	return Math.max(0, Math.min(100, score));
}

export function confidenceLabel(score: number): ConfidenceLabel {
	if (score >= CONFIDENCE_LABEL_THRESHOLDS.high) return "high";
	if (score >= CONFIDENCE_LABEL_THRESHOLDS.moderate) return "moderate";
	return "low";
}
