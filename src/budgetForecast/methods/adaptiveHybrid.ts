import { descendantIds } from "../../categories";
import { detectForecastCommitments, knownRecurringShare, recurringAttributedMonthlySpend } from "../commitments";
import { VOLATILITY_THRESHOLDS, seasonalityStrengthLabel } from "../diagnostics";
import { buildCategorySpendHistory } from "../history";
import { seasonalObservations, seasonalityStrengthSpread } from "../quantileEngine";
import { relativeIqr } from "../statistics";
import type { BudgetForecastMethod, CategoryPeriodSpend, ForecastStore, SeasonalityStrength } from "../types";

/**
 * The adaptive-hybrid method (budget_spec.md §35) — for a category like Auto & Transport or Home
 * whose primary total genuinely mixes several different spending behaviors (fuel is frequent and
 * variable, repairs are sparse and irregular, insurance is fixed), so no single method fits the
 * category as a whole. Inspects the category's own history and picks whichever of the other four
 * methods actually matches what it finds.
 *
 * The spec's own decision tree ends in two branches — "usable seasonal years >= 3 and seasonality !=
 * weak → seasonal-quantile" and, failing every prior branch, "recent distribution / seasonal-quantile
 * fallback" — that collapse to the same outcome here: `forecastSeasonalQuantile` already *is* "recent
 * distribution" whenever its own seasonality gate fails (§30's fallback path), so there's no case left
 * where the tree's final answer is anything other than seasonal-quantile. `chooseAdaptiveMethod`
 * therefore only has to decide between the three *more specific* methods and that one shared default.
 */

export interface AdaptiveSignals {
	/** §36 — over the category's own recent history window. */
	knownRecurringShare: number;
	/** Share of tracked months with exactly €0 economic expense. */
	sparseMonthRatio: number;
	seasonality: SeasonalityStrength;
	usableSeasonalYears: number;
	/** Relative IQR of the *residual* (recurring-subtracted) monthly series — the volatility that
	 *  matters for "is this stable enough to call fixed-commitment", since a category that's 90%
	 *  recurring but has a wildly variable 10% residual isn't genuinely fixed. */
	residualVolatility: number;
}

export function chooseAdaptiveMethod(signals: AdaptiveSignals): BudgetForecastMethod {
	if (signals.knownRecurringShare >= 0.8 && signals.residualVolatility < VOLATILITY_THRESHOLDS.moderate) return "fixed-commitment";
	if (signals.sparseMonthRatio >= 0.5) return "sinking-fund";
	if (signals.knownRecurringShare >= 0.25) return "recurring-plus-variable";
	return "seasonal-quantile";
}

/** Everything `chooseAdaptiveMethod` needs, computed once from the category's own history — kept
 *  separate from the decision function itself so the decision stays a plain, easily pinned-down
 *  function of a few numbers, and so `runBudgetForecast` can compute this once per category rather
 *  than every method function re-deriving its own version of "how recurring is this category". */
export function adaptiveSignalsFor(store: ForecastStore, categoryId: string, scope: "leaf" | "rollup"): AdaptiveSignals {
	const history = buildCategorySpendHistory(store, categoryId, scope);
	const categoryIds = scope === "rollup" ? descendantIds(store.categories, categoryId) : [categoryId];

	const attributedByMonth = new Map<string, number>();
	for (const id of categoryIds) {
		for (const [month, amount] of recurringAttributedMonthlySpend(store, id)) {
			attributedByMonth.set(month, (attributedByMonth.get(month) ?? 0) + amount);
		}
	}
	const share = knownRecurringShare(history, attributedByMonth);

	const residualSeries: CategoryPeriodSpend[] = history.map((h) => ({ ...h, economicExpense: Math.max(0, h.economicExpense - (attributedByMonth.get(h.key) ?? 0)) }));
	const residualVolatility = relativeIqr(residualSeries.map((h) => h.economicExpense));

	const sparseMonthRatio = history.length > 0 ? history.filter((h) => h.economicExpense === 0).length / history.length : 0;

	// Reuses the same recent-months window `forecastSeasonalQuantile` itself would use for its own
	// target — "now" here is simply the most recent tracked month, since the adaptive classifier is
	// answering "what does this category generally look like", not forecasting one specific period.
	const latestMonth = history.length > 0 ? history[history.length - 1].key : undefined;
	const byKey = new Map(history.map((h) => [h.key, h]));
	const seasonality = latestMonth ? seasonalityStrengthLabel(seasonalityStrengthSpread(byKey, latestMonth)) : "unknown";
	const usableSeasonalYears = latestMonth ? seasonalObservations(byKey, latestMonth).length : 0;

	return { knownRecurringShare: share, sparseMonthRatio, seasonality, usableSeasonalYears, residualVolatility };
}
