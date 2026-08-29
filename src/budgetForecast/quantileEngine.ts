import { MONTH_NAMES, monthRange, shiftMonthKey } from "../period";
import { addDaysIso, daysBetweenIso } from "../recurring";
import { baseConfidence, confidenceLabel, scenarioConfidence, type ConfidenceInputs } from "./confidence";
import { distributionShape, seasonalityStrengthLabel, volatilityLabel } from "./diagnostics";
import { detectOutliers } from "./outliers";
import { median, quantileR7, relativeIqr, theilSen, theilSenLevelAt } from "./statistics";
import { formatMoneyRounded } from "../money";
import type {
	BudgetForecastDiagnostics,
	BudgetForecastMethod,
	BudgetForecastOutlier,
	BudgetForecastRequest,
	BudgetForecastResult,
	BudgetForecastScenario,
	BudgetScenarioKey,
	CategoryPeriodSpend,
	ForecastObservation,
	SeasonalityStrength,
} from "./types";

/**
 * The shared engine behind every "known commitments + seasonal-or-trend quantile of a variable
 * series" forecast (budget_spec.md §14–20, §30, §32): a current spending level (§14), scaled by how
 * the target month typically compares to a normal month in the same year (§15–16), quantiled across
 * as many prior years as the ledger holds (§17) — falling back to quantiling the recent trend-adjusted
 * history directly when seasonality is weak, unknown, or too thin a sample to trust.
 *
 * `forecastSeasonalQuantile` feeds it the category's raw economic-expense history; the
 * recurring-plus-variable method (§32) feeds it the *residual* left after subtracting out identified
 * recurring charges — same formula, same math, a different input series and a `method` label to match.
 *
 * A target spanning more than one calendar month (a pay cycle) is handled per §11: each overlapping
 * calendar month is forecast on its own, the *variable* component of each is prorated by calendar-day
 * overlap and summed, and known commitments for the real target range are added on top *unprorated* —
 * a subscription due inside the cycle counts in full, not by the fraction of its billing month the
 * cycle happens to cover. A single calendar-month target is exactly the one-segment case of this same
 * computation (its one segment's weight is always 1.0), so there is only one code path.
 */

/** Up to this many prior calendar years are considered for a seasonal ratio — deep enough to cover
 *  nearly every vault's whole history, capped so a decade-old lifestyle doesn't quietly outweigh how
 *  someone spends today. */
const MAX_LOOKBACK_YEARS = 10;

/** §16 — a calendar year only gets to say what "a normal month" looked like if most of it was
 *  actually tracked; two or three tracked months can't establish a typical level. */
const MIN_YEAR_COVERAGE_MONTHS = 8;

/** Fewer same-month years than this and a P25/P75 read off their spread would be reading tea leaves —
 *  matches the threshold already established for `budgetScenarios`' own seasonal rung. */
const MIN_SEASONAL_YEARS = 2;

/** At least this many distinct months-of-year need their own seasonal read before "the spread across
 *  months" means anything (§20). */
const MIN_MONTHS_FOR_SEASONALITY_STRENGTH = 2;
/** Each of those months needs its own minimum sample too, or one lucky/unlucky year could look like
 *  "this month is different" on its own. */
const MIN_YEARS_PER_MONTH_FOR_SEASONALITY_STRENGTH = 2;

/** §14 — Theil–Sen wants a real run of points before its slope means anything; fewer than this and a
 *  plain median of what's on hand is the honest answer instead. */
const MIN_MONTHS_FOR_TREND = 6;
/** §14 — use at most this many recent complete months, so a decade of drift doesn't dilute what
 *  "current" means. */
const MAX_TREND_MONTHS = 24;

function byMonthKey(series: CategoryPeriodSpend[]): Map<string, CategoryPeriodSpend> {
	return new Map(series.map((h) => [h.key, h]));
}

function monthYearLabel(monthKey: string): string {
	const [year, mo] = monthKey.split("-");
	return `${MONTH_NAMES[Number(mo) - 1]} ${year}`;
}

/**
 * §15–16: `monthKey`'s ratio to its own calendar year's typical (median) tracked month — undefined
 * when that year doesn't have enough tracked coverage to establish a "normal" level, or the month
 * itself wasn't tracked at all. Never manufactures a zero for an untracked month (§16).
 */
export function seasonalRatioForMonth(series: Map<string, CategoryPeriodSpend>, monthKey: string): number | undefined {
	const entry = series.get(monthKey);
	if (!entry) return undefined;
	const year = monthKey.slice(0, 4);
	const yearMonths = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
	const trackedYearMonths = yearMonths.filter((m) => series.has(m));
	if (trackedYearMonths.length < MIN_YEAR_COVERAGE_MONTHS) return undefined;
	const typicalLevel = median(trackedYearMonths.map((m) => series.get(m)!.economicExpense)) ?? 0;
	if (typicalLevel <= 0) return undefined;
	return entry.economicExpense / typicalLevel;
}

/** Every prior year's seasonal ratio for `targetMonth`'s own month-of-year, most recent first,
 *  skipping any year that didn't have enough coverage to produce one (§16). */
export function seasonalObservations(series: Map<string, CategoryPeriodSpend>, targetMonth: string): ForecastObservation[] {
	const out: ForecastObservation[] = [];
	for (let k = 1; k <= MAX_LOOKBACK_YEARS; k++) {
		const monthKey = shiftMonthKey(targetMonth, -12 * k);
		const ratio = seasonalRatioForMonth(series, monthKey);
		if (ratio === undefined) continue;
		out.push({ id: monthKey, period: monthYearLabel(monthKey), amount: series.get(monthKey)!.economicExpense, normalizedValue: ratio });
	}
	return out;
}

/** §20: the spread between the highest and lowest month-of-year median seasonal ratio, across every
 *  month with enough of its own history to compare — undefined when fewer than two months qualify. */
export function seasonalityStrengthSpread(series: Map<string, CategoryPeriodSpend>, targetMonth: string): number | undefined {
	const targetYear = Number(targetMonth.slice(0, 4));
	const monthMedians: number[] = [];
	for (let mo = 1; mo <= 12; mo++) {
		const ratios: number[] = [];
		for (let k = 1; k <= MAX_LOOKBACK_YEARS; k++) {
			const ratio = seasonalRatioForMonth(series, `${targetYear - k}-${String(mo).padStart(2, "0")}`);
			if (ratio !== undefined) ratios.push(ratio);
		}
		if (ratios.length < MIN_YEARS_PER_MONTH_FOR_SEASONALITY_STRENGTH) continue;
		const m = median(ratios);
		if (m !== undefined) monthMedians.push(m);
	}
	if (monthMedians.length < MIN_MONTHS_FOR_SEASONALITY_STRENGTH) return undefined;
	return Math.max(...monthMedians) - Math.min(...monthMedians);
}

interface Baseline {
	/** The fitted (or, on thin history, plain median) current spending level — always >= 0. */
	value: number;
	/** The complete months strictly before the target that fed it, oldest first. */
	recentMonths: CategoryPeriodSpend[];
}

/** §14 — the current variable-spending level, robust to one unusually expensive month. Reads only
 *  months strictly before the target, so a backtest for a past month never leaks that month's own
 *  (or a later month's) value into its own baseline. */
function currentBaseline(series: CategoryPeriodSpend[], targetMonth: string): Baseline {
	const recentMonths = series.filter((h) => h.key < targetMonth).slice(-MAX_TREND_MONTHS);
	if (recentMonths.length === 0) return { value: 0, recentMonths };
	if (recentMonths.length < MIN_MONTHS_FOR_TREND) {
		return { value: median(recentMonths.map((h) => h.economicExpense)) ?? 0, recentMonths };
	}
	const points = recentMonths.map((h, i) => ({ x: i, y: h.economicExpense }));
	const fit = theilSen(points)!;
	return { value: theilSenLevelAt(fit, recentMonths.length), recentMonths };
}

/** §30's fallback path: each recent month read as a ratio to the current baseline, instead of a ratio
 *  to its own calendar year — the same quantile-of-a-ratio shape as the seasonal path, just without
 *  conditioning on month-of-year. Empty when there's no positive baseline to compare against. */
function fallbackObservations(recentMonths: CategoryPeriodSpend[], baseline: number): ForecastObservation[] {
	if (baseline <= 0) return [];
	return recentMonths.map((h) => ({ id: h.key, period: monthYearLabel(h.key), amount: h.economicExpense, normalizedValue: h.economicExpense / baseline }));
}

/** Whether `obs` counts toward the final quantile calculation — an explicit per-request override
 *  always wins; otherwise a flagged observation follows the method's own default (§21–23). Shared
 *  with `forecastSinkingFund`, which applies the exact same include/exclude/override logic to its own
 *  annual observations. */
export function isIncluded(obs: ForecastObservation, outliersById: Map<string, BudgetForecastOutlier>, overrides?: Record<string, "include" | "exclude">): boolean {
	const override = overrides?.[obs.id];
	if (override === "include") return true;
	if (override === "exclude") return false;
	return outliersById.get(obs.id)?.includedByDefault ?? true;
}

export function notForecastable(request: BudgetForecastRequest, method: BudgetForecastMethod, reason: string): BudgetForecastResult {
	return {
		categoryId: request.categoryId,
		method,
		forecastable: false,
		reason,
		outliers: [],
		diagnostics: {
			method,
			targetPeriod: { from: request.target.from, to: request.target.to, label: request.target.label },
			comparableObservations: 0,
			recentMonthsUsed: 0,
			knownCommitments: 0,
			volatility: "low",
			distribution: "unknown",
			seasonality: "unknown",
			outlierCount: 0,
			explanation: [reason],
		},
	};
}

/** §11 — the calendar months a target range touches, each with the fraction of it that overlaps that
 *  range (`weight`). A plain calendar-month target always produces exactly one segment at weight 1.0,
 *  which is what makes the rest of this engine's math work unchanged for that case. */
interface MonthSegment {
	monthKey: string;
	weight: number;
}

function calendarMonthSegments(from: string, to: string): MonthSegment[] {
	const segments: MonthSegment[] = [];
	let cursor = from;
	while (cursor <= to) {
		const monthKey = cursor.slice(0, 7);
		const range = monthRange(monthKey);
		if (!range) break;
		const segmentEnd = range.to < to ? range.to : to;
		const overlapDays = daysBetweenIso(cursor, segmentEnd) + 1;
		const daysInMonth = daysBetweenIso(range.from, range.to) + 1;
		segments.push({ monthKey, weight: overlapDays / daysInMonth });
		cursor = addDaysIso(segmentEnd, 1);
	}
	return segments;
}

/** Everything the seasonal-or-fallback model produces for one calendar month, before commitments or
 *  cross-month proration enter the picture — the unit `quantileForecast` sums across segments. */
interface MonthComponents {
	monthKey: string;
	baseline: Baseline;
	ratioP25?: number;
	ratioP50?: number;
	ratioP75?: number;
	rawCount: number;
	outliers: BudgetForecastOutlier[];
	includedRatios: number[];
	excluded: ForecastObservation[];
	useSeasonal: boolean;
	seasonality: SeasonalityStrength;
	sparseMonthRatio: number;
	coverageRatio: number;
}

function computeMonthComponents(series: CategoryPeriodSpend[], targetMonth: string, method: BudgetForecastMethod, outlierOverrides?: Record<string, "include" | "exclude">): MonthComponents {
	const byKey = byMonthKey(series);
	const baseline = currentBaseline(series, targetMonth);
	const seasonality = seasonalityStrengthLabel(seasonalityStrengthSpread(byKey, targetMonth));
	const seasonalObs = seasonalObservations(byKey, targetMonth);
	const useSeasonal = seasonalObs.length >= MIN_SEASONAL_YEARS && (seasonality === "moderate" || seasonality === "strong");

	const observations = useSeasonal ? seasonalObs : fallbackObservations(baseline.recentMonths, baseline.value);
	const rawCount = observations.length;

	const outliers = detectOutliers(observations, method);
	const outliersById = new Map(outliers.map((o) => [o.id, o]));
	const included = observations.filter((o) => isIncluded(o, outliersById, outlierOverrides));
	const includedRatios = included.map((o) => o.normalizedValue);
	const excluded = observations.filter((o) => !included.includes(o));

	return {
		monthKey: targetMonth,
		baseline,
		ratioP25: quantileR7(includedRatios, 0.25),
		ratioP50: quantileR7(includedRatios, 0.5),
		ratioP75: quantileR7(includedRatios, 0.75),
		rawCount,
		outliers,
		includedRatios,
		excluded,
		useSeasonal,
		seasonality,
		sparseMonthRatio: rawCount > 0 ? observations.filter((o) => o.amount === 0).length / rawCount : 0,
		coverageRatio: Math.min(rawCount / (useSeasonal ? MAX_LOOKBACK_YEARS : MAX_TREND_MONTHS), 1),
	};
}

function monthExplanation(c: MonthComponents, categoryLabel: string): string[] {
	const monthName = MONTH_NAMES[Number(c.monthKey.slice(5, 7)) - 1];
	const lines: string[] = [];
	if (c.useSeasonal && c.ratioP50 !== undefined) {
		const pct = Math.round((c.ratioP50 - 1) * 100);
		lines.push(
			pct === 0
				? `${monthName} has historically tracked close to a normal ${categoryLabel} month.`
				: `${monthName} has historically been about ${Math.abs(pct)}% ${pct > 0 ? "above" : "below"} a normal ${categoryLabel} month.`
		);
		lines.push(`${c.rawCount} comparable ${monthName}${c.rawCount === 1 ? "" : "s"} ${c.rawCount === 1 ? "was" : "were"} available.`);
	} else {
		lines.push(`Not enough seasonal history for ${monthName} yet — using your recent overall spending pattern instead.`);
	}
	if (c.excluded.length === 1) {
		const ex = c.excluded[0];
		const direction = ex.normalizedValue > (c.ratioP50 ?? ex.normalizedValue) ? "high" : "low";
		lines.push(`One unusually ${direction} period (${ex.period}: ${formatMoneyRounded(ex.amount)}) was excluded from the normal forecast.`);
	} else if (c.excluded.length > 1) {
		lines.push(`${c.excluded.length} unusually high or low periods were excluded from the normal forecast.`);
	}
	return lines;
}

export interface QuantileForecastInput {
	request: BudgetForecastRequest;
	/** The series to forecast from — raw economic-expense history for seasonal-quantile, or the
	 *  recurring-subtracted residual for recurring-plus-variable. Whatever this method considers its
	 *  own "variable" component. */
	series: CategoryPeriodSpend[];
	method: BudgetForecastMethod;
	/** Already-computed known future commitments for the target period (§13), added on top of the
	 *  variable forecast unprorated (§11) — every method that has one computes this identically via
	 *  `detectForecastCommitments`. */
	knownCommitments: number;
	categoryLabel: string;
}

export function quantileForecast(input: QuantileForecastInput): BudgetForecastResult {
	const { request, series, method, knownCommitments, categoryLabel } = input;
	const { categoryId, target } = request;
	if (!target.from || !target.to) {
		return notForecastable(request, method, "This forecast needs a concrete date range.");
	}
	if (series.length === 0) {
		return notForecastable(request, method, "No spending history for this category yet.");
	}

	const segments = calendarMonthSegments(target.from, target.to);
	if (segments.length === 0) {
		return notForecastable(request, method, "This forecast needs a concrete date range.");
	}
	const parts = segments.map((segment) => ({ segment, c: computeMonthComponents(series, segment.monthKey, method, request.outlierOverrides) }));

	// The variable component only — commitments are added once below, against the real target range,
	// unprorated (§11: "a €50 subscription due inside the pay-cycle... include the full €50").
	function weightedVariable(pick: (c: MonthComponents) => number | undefined): number {
		return parts.reduce((sum, { segment, c }) => {
			const ratio = pick(c);
			return sum + (ratio === undefined ? 0 : c.baseline.value * ratio) * segment.weight;
		}, 0);
	}
	const p25Amount = Math.max(0, knownCommitments + weightedVariable((c) => c.ratioP25));
	const p50Amount = Math.max(0, knownCommitments + weightedVariable((c) => c.ratioP50));
	const p75Amount = Math.max(0, knownCommitments + weightedVariable((c) => c.ratioP75));

	const rawCount = parts.reduce((sum, { c }) => sum + c.rawCount, 0);
	const outliers = parts.flatMap(({ c }) => c.outliers);
	const includedRatios = parts.flatMap(({ c }) => c.includedRatios);
	const recentMonthsUsed = parts.reduce((sum, { c }) => sum + c.baseline.recentMonths.length, 0);
	const weightedBaseline = parts.reduce((sum, { segment, c }) => sum + c.baseline.value * segment.weight, 0);
	const weightedSparse = parts.reduce((sum, { segment, c }) => sum + c.sparseMonthRatio * segment.weight, 0);
	const weightedCoverage = parts.reduce((sum, { segment, c }) => sum + c.coverageRatio * segment.weight, 0);
	const relIqr = relativeIqr(includedRatios);

	const confidenceInputs: ConfidenceInputs = {
		comparableObservations: rawCount,
		recentCompleteMonths: recentMonthsUsed,
		coverageRatio: weightedCoverage,
		relativeIqr: relIqr,
		outlierRatio: rawCount > 0 ? outliers.length / rawCount : 0,
		sparseMonthRatio: weightedSparse,
	};
	const base = baseConfidence(confidenceInputs);

	function scenario(key: BudgetScenarioKey, label: "Lean" | "Typical" | "Buffered", amount: number): BudgetForecastScenario {
		const score = scenarioConfidence(base, key, rawCount);
		return { key, label, amount, confidenceScore: score, confidenceLabel: confidenceLabel(score) };
	}
	const p25 = scenario("p25", "Lean", p25Amount);
	const p50 = scenario("p50", "Typical", p50Amount);
	const p75 = scenario("p75", "Buffered", p75Amount);

	// The largest-weight month stands in for a single "seasonality" label — a blended period doesn't
	// have one seasonality of its own, but the dominant month is the closest honest single answer.
	const dominant = parts.reduce((best, cur) => (cur.segment.weight > best.segment.weight ? cur : best), parts[0]);

	const explanation: string[] = [`Your recent ${categoryLabel} spending level is about ${formatMoneyRounded(weightedBaseline)}/month.`];
	if (parts.length === 1) {
		explanation.push(...monthExplanation(parts[0].c, categoryLabel));
	} else {
		const spanNames = parts.map(({ segment }) => MONTH_NAMES[Number(segment.monthKey.slice(5, 7)) - 1]);
		explanation.push(`${target.label || "This period"} spans ${spanNames.join(" and ")} — prorated by calendar-day overlap between them, not read as one statistical month.`);
		for (const { c } of parts) explanation.push(...monthExplanation(c, categoryLabel));
	}
	explanation.push(`Historical variability is ${volatilityLabel(relIqr)}.`);

	const diagnostics: BudgetForecastDiagnostics = {
		method,
		targetPeriod: { from: target.from, to: target.to, label: target.label },
		comparableObservations: rawCount,
		recentMonthsUsed,
		baseline: weightedBaseline,
		knownCommitments,
		seasonalFactorP25: parts.length === 1 && parts[0].c.useSeasonal ? parts[0].c.ratioP25 : undefined,
		seasonalFactorP50: parts.length === 1 && parts[0].c.useSeasonal ? parts[0].c.ratioP50 : undefined,
		seasonalFactorP75: parts.length === 1 && parts[0].c.useSeasonal ? parts[0].c.ratioP75 : undefined,
		relativeIqr: relIqr,
		volatility: volatilityLabel(relIqr),
		distribution: distributionShape(includedRatios, weightedSparse),
		seasonality: dominant.c.seasonality,
		outlierCount: outliers.length,
		sparseMonthRatio: weightedSparse,
		explanation,
	};

	return {
		categoryId,
		method,
		forecastable: true,
		p25,
		p50,
		p75,
		recommendedDefault: "p50",
		outliers,
		diagnostics,
	};
}
