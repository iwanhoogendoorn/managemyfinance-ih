import { adaptiveSignalsFor, chooseAdaptiveMethod } from "./methods/adaptiveHybrid";
import { forecastFixedCommitment } from "./methods/fixedCommitment";
import { forecastGuardrail } from "./methods/guardrail";
import { forecastPolicyTarget } from "./methods/policyTarget";
import { forecastRecurringPlusVariable } from "./methods/recurringPlusVariable";
import { forecastSeasonalQuantile } from "./methods/seasonalQuantile";
import { forecastSinkingFund } from "./methods/sinkingFund";
import { notForecastable } from "./quantileEngine";
import { defaultNonBudgetableReason, resolveDefaultMethod } from "./profiles";
import type { BudgetForecastMethod, BudgetForecastOverride, BudgetForecastRequest, BudgetForecastResult, ForecastStore } from "./types";

/**
 * The single entry point the UI calls (budget_spec.md §7, §69's Phase F): resolves which method a
 * category should use — an explicit per-category override first, then its default profile
 * (`profiles.ts`), then the adaptive classifier for anything that matches no default name at all —
 * and dispatches to whichever method function actually produces the result.
 *
 * `override` is deliberately a plain parameter rather than something this module reads off a plugin
 * settings object itself: the engine stays pure and testable with a plain `ForecastStore`, and the
 * caller (wherever `PortfolioBudgetingSettings.forecastOverrides` actually lives) decides which
 * override applies.
 */
export function runBudgetForecast(store: ForecastStore, request: BudgetForecastRequest, override?: BudgetForecastOverride): BudgetForecastResult {
	const explicitMethod = override?.method;
	const defaultMethod = explicitMethod ?? resolveDefaultMethod(store.categories, request.categoryId) ?? "adaptive-hybrid";

	const method = defaultMethod === "adaptive-hybrid" ? chooseAdaptiveMethod(adaptiveSignalsFor(store, request.categoryId, request.scope)) : defaultMethod;

	const effectiveRequest: BudgetForecastRequest = { ...request, outlierOverrides: mergedOutlierOverrides(request, override) };

	switch (method) {
		case "seasonal-quantile":
			return forecastSeasonalQuantile(store, effectiveRequest);
		case "fixed-commitment":
			return forecastFixedCommitment(store, effectiveRequest);
		case "recurring-plus-variable":
			return forecastRecurringPlusVariable(store, effectiveRequest);
		case "sinking-fund":
			return forecastSinkingFund(store, effectiveRequest);
		case "guardrail":
			return forecastGuardrail(store, effectiveRequest);
		case "policy-target":
			return forecastPolicyTarget(store, effectiveRequest);
		case "none":
			return notForecastable(effectiveRequest, "none", defaultNonBudgetableReason(store.categories, request.categoryId) ?? "This category isn't budgeted as ordinary spending.");
		case "income-target":
		case "debt-schedule":
		case "adaptive-hybrid": {
			// income-target and debt-schedule have no implementation yet (§6.13, §6.17, §6.19 — a later
			// phase's own work, not silently approximated here); "adaptive-hybrid" landing here at all
			// would mean chooseAdaptiveMethod itself returned it, which its own type signature disallows,
			// so this arm exists only for TypeScript's exhaustiveness check, not a real runtime path.
			const label = methodLabel(method);
			return notForecastable(effectiveRequest, method, `Smart Budget Forecasting doesn't support ${label} categories yet.`);
		}
	}
}

function methodLabel(method: BudgetForecastMethod): string {
	switch (method) {
		case "income-target":
			return "income";
		case "debt-schedule":
			return "debt-schedule";
		default:
			return method;
	}
}

/** Folds a persisted per-category override's `includeOutlierIds`/`excludeOutlierIds` (§7) into the
 *  same `Record<id, "include" | "exclude">` shape every method function already accepts via
 *  `request.outlierOverrides` — a request-level decision (the user's immediate, unsaved choice) wins
 *  over the persisted one on conflict, since it's the more recent, more specific intent. */
function mergedOutlierOverrides(request: BudgetForecastRequest, override?: BudgetForecastOverride): Record<string, "include" | "exclude"> | undefined {
	if (!override?.includeOutlierIds?.length && !override?.excludeOutlierIds?.length) return request.outlierOverrides;
	const merged: Record<string, "include" | "exclude"> = {};
	for (const id of override?.includeOutlierIds ?? []) merged[id] = "include";
	for (const id of override?.excludeOutlierIds ?? []) merged[id] = "exclude";
	return { ...merged, ...request.outlierOverrides };
}
