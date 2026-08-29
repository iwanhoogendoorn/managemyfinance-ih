import { descendantIds } from "../../categories";
import { detectForecastCommitments, recurringAttributedMonthlySpend } from "../commitments";
import { buildCategorySpendHistory } from "../history";
import { quantileForecast } from "../quantileEngine";
import type { BudgetForecastRequest, BudgetForecastResult, CategoryPeriodSpend, ForecastStore } from "../types";

/**
 * The recurring-plus-variable method (budget_spec.md §32) — for a category like Entertainment that's
 * part known subscriptions and part genuinely variable spending, where forecasting the *whole*
 * category as one variable series would double-count: the known subscription would land twice, once
 * as itself and once baked into "normal" history.
 *
 * ```text
 * total economic category spending
 * -
 * historically identified recurring charges
 * =
 * variable residual
 * ```
 *
 * The residual is forecast through the exact same seasonal-or-trend quantile engine
 * `forecastSeasonalQuantile` uses — same math, just fed what's left over each month after subtracting
 * out identified recurring charges (§36) instead of the category's raw total. Known target-period
 * commitments are then added back on top, unprorated (§11), same as every other method that has them.
 */
export function forecastRecurringPlusVariable(store: ForecastStore, request: BudgetForecastRequest): BudgetForecastResult {
	const { categoryId, target, scope } = request;
	const commitmentCategoryIds = scope === "rollup" ? descendantIds(store.categories, categoryId) : [categoryId];

	const commitments = commitmentCategoryIds.flatMap((id) => detectForecastCommitments(store, id, target));
	const knownCommitments = commitments.reduce((sum, c) => sum + c.amount, 0);

	const attributedByMonth = new Map<string, number>();
	for (const id of commitmentCategoryIds) {
		for (const [month, amount] of recurringAttributedMonthlySpend(store, id)) {
			attributedByMonth.set(month, (attributedByMonth.get(month) ?? 0) + amount);
		}
	}

	const rawHistory = buildCategorySpendHistory(store, categoryId, scope);
	// Floored at 0 — "spending beyond what's recurring" can't be meaningfully negative even the month a
	// refund happens to land alongside a full recurring charge.
	const residualSeries: CategoryPeriodSpend[] = rawHistory.map((h) => ({
		...h,
		economicExpense: Math.max(0, h.economicExpense - (attributedByMonth.get(h.key) ?? 0)),
	}));

	const categoryLabel = store.categories.find((c) => c.id === categoryId)?.name ?? categoryId;

	return quantileForecast({ request, series: residualSeries, method: "recurring-plus-variable", knownCommitments, categoryLabel });
}
