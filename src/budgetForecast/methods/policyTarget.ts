import { descendantIds } from "../../categories";
import { formatMoneyRounded } from "../../money";
import { baseConfidence, confidenceLabel, type ConfidenceInputs } from "../confidence";
import { detectForecastCommitments } from "../commitments";
import { distributionShape, volatilityLabel } from "../diagnostics";
import { buildCategorySpendHistory } from "../history";
import { notForecastable } from "../quantileEngine";
import { median, quantileR7, relativeIqr } from "../statistics";
import type { BudgetForecastDiagnostics, BudgetForecastRequest, BudgetForecastResult, BudgetForecastScenario, BudgetScenarioKey, ForecastStore } from "../types";

/**
 * The policy-target method (budget_spec.md §38) — Savings and Charity, where how much you *have*
 * spent is not a claim about how much you *should*. History is returned as context (a known-commitment
 * floor, a historical median, a historical range) so the user can set their own policy informed by it,
 * never as a number the backend hands back framed as "recommended spending".
 *
 * `recommendedDefault` is always left `undefined` here — no scenario is ever pre-selected as *the*
 * answer, which is what actually distinguishes this from every other method (§38's own requirement),
 * not the presence of P25/P50/P75 figures — those are still real historical quantiles, just labeled
 * as context rather than a recommendation.
 */
export function forecastPolicyTarget(store: ForecastStore, request: BudgetForecastRequest): BudgetForecastResult {
	const { categoryId, target, scope } = request;
	if (!target.from || !target.to) {
		return notForecastable(request, "policy-target", "This forecast needs a concrete date range.");
	}

	const commitmentCategoryIds = scope === "rollup" ? descendantIds(store.categories, categoryId) : [categoryId];
	const commitments = commitmentCategoryIds.flatMap((id) => detectForecastCommitments(store, id, target));
	const knownFloor = commitments.reduce((sum, c) => sum + c.amount, 0);

	const history = buildCategorySpendHistory(store, categoryId, scope);
	if (history.length === 0 && commitments.length === 0) {
		return notForecastable(request, "policy-target", "No spending history for this category yet.");
	}

	const amounts = history.map((h) => h.economicExpense);
	const histP25 = quantileR7(amounts, 0.25) ?? 0;
	const histP50 = median(amounts) ?? 0;
	const histP75 = quantileR7(amounts, 0.75) ?? 0;

	// A known recurring commitment is a floor, not just one more data point — never suggest less
	// context than what's already actually committed.
	const p25Amount = Math.max(histP25, knownFloor);
	const p50Amount = Math.max(histP50, knownFloor);
	const p75Amount = Math.max(histP75, knownFloor);

	const relIqr = relativeIqr(amounts);
	const sparseMonthRatio = history.length > 0 ? history.filter((h) => h.economicExpense === 0).length / history.length : 0;
	const confidenceInputs: ConfidenceInputs = {
		comparableObservations: history.length,
		recentCompleteMonths: Math.min(history.length, 24),
		coverageRatio: Math.min(history.length / 24, 1),
		relativeIqr: relIqr,
		outlierRatio: 0,
		sparseMonthRatio,
	};
	const score = Math.max(0, Math.min(100, baseConfidence(confidenceInputs)));
	const label = confidenceLabel(score);

	function scenario(key: BudgetScenarioKey, labelText: "Lean" | "Typical" | "Buffered", amount: number): BudgetForecastScenario {
		return { key, label: labelText, amount, confidenceScore: score, confidenceLabel: label };
	}
	const p25 = scenario("p25", "Lean", p25Amount);
	const p50 = scenario("p50", "Typical", p50Amount);
	const p75 = scenario("p75", "Buffered", p75Amount);

	const categoryLabel = store.categories.find((c) => c.id === categoryId)?.name ?? categoryId;
	const explanation: string[] = [`${categoryLabel} is a policy choice, not a statistical forecast — the figures below are historical context, not a recommendation.`];
	if (knownFloor > 0) {
		explanation.push(`You already have ${formatMoneyRounded(knownFloor)} in known recurring commitments here.`);
	}
	explanation.push(`Historically this has typically run about ${formatMoneyRounded(histP50)}/month, ranging from ${formatMoneyRounded(histP25)} to ${formatMoneyRounded(histP75)}.`);

	const diagnostics: BudgetForecastDiagnostics = {
		method: "policy-target",
		targetPeriod: { from: target.from, to: target.to, label: target.label },
		comparableObservations: history.length,
		recentMonthsUsed: Math.min(history.length, 24),
		baseline: histP50,
		knownCommitments: knownFloor,
		relativeIqr: relIqr,
		volatility: volatilityLabel(relIqr),
		distribution: distributionShape(amounts, sparseMonthRatio),
		seasonality: "none",
		outlierCount: 0,
		sparseMonthRatio,
		explanation,
	};

	// No `recommendedDefault` — see the module doc comment.
	return { categoryId, method: "policy-target", forecastable: true, p25, p50, p75, outliers: [], diagnostics };
}
