import { descendantIds } from "../../categories";
import { formatMoneyRounded } from "../../money";
import { baseConfidence, confidenceLabel, type ConfidenceInputs } from "../confidence";
import { detectForecastCommitments, recurringAttributedMonthlySpend } from "../commitments";
import { distributionShape, volatilityLabel } from "../diagnostics";
import { buildCategorySpendHistory } from "../history";
import { notForecastable } from "../quantileEngine";
import { relativeIqr } from "../statistics";
import type { BudgetForecastDiagnostics, BudgetForecastRequest, BudgetForecastResult, BudgetForecastScenario, BudgetScenarioKey, ForecastStore } from "../types";

/**
 * The guardrail method (budget_spec.md §37) — Fees & Charges, where the ideal budget for an
 * *avoidable* fee is often €0, so treating "what you usually pay in fees" as the target would just
 * budget in the waste. The suggestion is the known mandatory cost only; everything else historically
 * paid in fees is surfaced as diagnostic context, never folded into the number itself.
 *
 * All three scenarios carry the same amount, same as fixed-commitment — a guardrail is a ceiling you
 * shouldn't need to exceed, not a distribution with a lean/typical/buffered spread.
 */
export function forecastGuardrail(store: ForecastStore, request: BudgetForecastRequest): BudgetForecastResult {
	const { categoryId, target, scope } = request;
	if (!target.from || !target.to) {
		return notForecastable(request, "guardrail", "This forecast needs a concrete date range.");
	}

	const commitmentCategoryIds = scope === "rollup" ? descendantIds(store.categories, categoryId) : [categoryId];
	const commitments = commitmentCategoryIds.flatMap((id) => detectForecastCommitments(store, id, target));
	const knownMandatory = commitments.reduce((sum, c) => sum + c.amount, 0);

	const history = buildCategorySpendHistory(store, categoryId, scope);
	if (history.length === 0 && commitments.length === 0) {
		return notForecastable(request, "guardrail", "No spending history for this category yet.");
	}

	const attributedByMonth = new Map<string, number>();
	for (const id of commitmentCategoryIds) {
		for (const [month, amount] of recurringAttributedMonthlySpend(store, id)) {
			attributedByMonth.set(month, (attributedByMonth.get(month) ?? 0) + amount);
		}
	}
	// "Avoidable" reads as whatever wasn't already accounted for by a known mandatory charge — the
	// same residual concept recurring-plus-variable uses, just reported instead of forecast.
	const avoidableAmounts = history.map((h) => Math.max(0, h.economicExpense - (attributedByMonth.get(h.key) ?? 0)));
	const avoidableAverage = avoidableAmounts.length > 0 ? avoidableAmounts.reduce((sum, v) => sum + v, 0) / avoidableAmounts.length : 0;

	const relIqr = relativeIqr(avoidableAmounts);
	const sparseMonthRatio = history.length > 0 ? history.filter((h) => h.economicExpense === 0).length / history.length : 0;
	const confidenceInputs: ConfidenceInputs = {
		comparableObservations: commitments.length > 0 ? Math.max(history.length, 1) : history.length,
		recentCompleteMonths: Math.min(history.length, 24),
		coverageRatio: Math.min(history.length / 24, 1),
		relativeIqr: relIqr,
		outlierRatio: 0,
		sparseMonthRatio,
	};
	const score = Math.max(0, Math.min(100, baseConfidence(confidenceInputs)));
	const label = confidenceLabel(score);

	function scenario(key: BudgetScenarioKey, labelText: "Lean" | "Typical" | "Buffered"): BudgetForecastScenario {
		return { key, label: labelText, amount: Math.max(0, knownMandatory), confidenceScore: score, confidenceLabel: label };
	}
	const p25 = scenario("p25", "Lean");
	const p50 = scenario("p50", "Typical");
	const p75 = scenario("p75", "Buffered");

	const categoryLabel = store.categories.find((c) => c.id === categoryId)?.name ?? categoryId;
	const explanation: string[] = [
		knownMandatory > 0
			? `${formatMoneyRounded(knownMandatory)} known mandatory ${categoryLabel.toLowerCase()}.`
			: `No known mandatory ${categoryLabel.toLowerCase()} cost — the suggested budget is €0.`,
	];
	if (avoidableAverage > 0) {
		explanation.push(`Historical extra charges averaged ${formatMoneyRounded(avoidableAverage)}/month, but these aren't included in the suggested budget because they appear avoidable.`);
	}

	const diagnostics: BudgetForecastDiagnostics = {
		method: "guardrail",
		targetPeriod: { from: target.from, to: target.to, label: target.label },
		comparableObservations: confidenceInputs.comparableObservations,
		recentMonthsUsed: Math.min(history.length, 24),
		// The avoidable average, not the mandatory cost — `knownCommitments` already carries the
		// mandatory figure, so `baseline` here is whatever context the diagnostics has left to add.
		baseline: avoidableAverage,
		knownCommitments: knownMandatory,
		relativeIqr: relIqr,
		volatility: volatilityLabel(relIqr),
		distribution: distributionShape(avoidableAmounts, sparseMonthRatio),
		seasonality: "none",
		outlierCount: 0,
		sparseMonthRatio,
		explanation,
	};

	return { categoryId, method: "guardrail", forecastable: true, p25, p50, p75, recommendedDefault: "p50", outliers: [], diagnostics };
}
