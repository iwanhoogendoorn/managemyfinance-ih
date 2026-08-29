import { descendantIds } from "../../categories";
import { detectForecastCommitments } from "../commitments";
import { buildCategorySpendHistory } from "../history";
import { quantileForecast } from "../quantileEngine";
import type { BudgetForecastRequest, BudgetForecastResult, ForecastStore } from "../types";

export { seasonalObservations, seasonalRatioForMonth, seasonalityStrengthSpread } from "../quantileEngine";

/**
 * The seasonal-quantile method (budget_spec.md §14–20, §30) — Food, Utilities, and every other
 * ordinary variable-spending category's default forecast. A thin wrapper around the shared
 * `quantileForecast` engine: builds this category's raw economic-expense history and known future
 * commitments, then hands both to the engine that also backs `forecastRecurringPlusVariable`.
 */
export function forecastSeasonalQuantile(store: ForecastStore, request: BudgetForecastRequest): BudgetForecastResult {
	const { categoryId, target, scope } = request;
	const series = buildCategorySpendHistory(store, categoryId, scope);

	const commitmentCategoryIds = scope === "rollup" ? descendantIds(store.categories, categoryId) : [categoryId];
	const commitments = commitmentCategoryIds.flatMap((id) => detectForecastCommitments(store, id, target));
	const knownCommitments = commitments.reduce((sum, c) => sum + c.amount, 0);

	const categoryLabel = store.categories.find((c) => c.id === categoryId)?.name ?? categoryId;

	return quantileForecast({ request, series, method: "seasonal-quantile", knownCommitments, categoryLabel });
}
