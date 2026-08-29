import type { DateRange } from "../period";
import type { KpiStore } from "../kpi";
import type { Subscription } from "../types";

/**
 * Smart Budget Forecasting — shared types.
 *
 * See `budget_spec.md` (repo root) for the full domain specification this subsystem implements.
 * This file only declares shapes; every module under `src/budgetForecast/` reads from here rather
 * than redeclaring its own version of a type another module also needs.
 */

/** Whatever a forecast needs to read from the store — `KpiStore` (accounts, categories, transactions,
 *  optional fx) plus `subscriptions`, which `KpiStore` itself has no reason to carry since nothing
 *  else under kpi.ts touches them. Kept as its own alias so the forecast subsystem never has to
 *  import `KpiStore` by name at every call site, and so it can grow independently of kpi.ts's own
 *  shape as further forecast-specific needs arise. A real `FinanceStore` already satisfies this. */
export type ForecastStore = KpiStore & { subscriptions?: Subscription[] };

/**
 * Which statistical/domain shape a category's spending follows — chosen per category (via a default
 * profile keyed by the plugin's default category names, or an explicit per-portfolio override; see
 * `BudgetForecastOverride` below) rather than assumed to be the same for every category.
 *
 * `"none"` means "not a spending forecast at all" — a transfer, a cash withdrawal, anything the
 * classifier already treats as economically neutral or that isn't meaningfully budgetable this way.
 */
export type BudgetForecastMethod =
	| "seasonal-quantile"
	| "fixed-commitment"
	| "recurring-plus-variable"
	| "sinking-fund"
	| "adaptive-hybrid"
	| "debt-schedule"
	| "policy-target"
	| "income-target"
	| "guardrail"
	| "none";

/** A per-category forecasting override, for a user-created category the default name-based profile
 *  can't recognise, or to correct a default profile's guess for a specific category. Keyed by
 *  category id in `PortfolioBudgetingSettings.forecastOverrides` (wired up once a phase actually
 *  consumes it — declared here now since it's part of this subsystem's own vocabulary). */
export interface BudgetForecastOverride {
	method?: BudgetForecastMethod;
	includeOutlierIds?: string[];
	excludeOutlierIds?: string[];
}

/** "Lean" reads P25, "Typical" reads P50, "Buffered" reads P75 — the user's chosen risk posture,
 *  independent of which forecast method actually produced the three scenario amounts. */
export type BudgetDecisionPosture = "lean" | "typical" | "buffered";

export type BudgetScenarioKey = "p25" | "p50" | "p75";
export type ConfidenceLabel = "low" | "moderate" | "high";

/** One of the three amounts offered for a category — see `BudgetForecastResult`. */
export interface BudgetForecastScenario {
	key: BudgetScenarioKey;
	label: "Lean" | "Typical" | "Buffered";
	amount: number;
	/** 0–100. A data/model quality score, not a probability — see budget_spec.md §28. */
	confidenceScore: number;
	confidenceLabel: ConfidenceLabel;
}

/** One historical period flagged as unusual relative to its peers — reported, never silently
 *  dropped. `includedByDefault` reflects the method's own default (seasonal/variable methods default
 *  to excluding; sinking-fund methods default to including — see budget_spec.md §21–24). */
export interface BudgetForecastOutlier {
	id: string;
	period: string;
	amount: number;
	/** The value actually compared against peers when detecting this outlier — a raw euro amount
	 *  for a sinking-fund's annual totals, or a value normalized against that year's typical level
	 *  for a seasonal comparison (so ordinary multi-year growth isn't mistaken for an anomaly). */
	normalizedValue?: number;
	reason: string;
	includedByDefault: boolean;
}

export type VolatilityLabel = "low" | "moderate" | "high";
export type DistributionShape = "symmetric" | "right-skewed" | "left-skewed" | "sparse" | "unknown";
export type SeasonalityStrength = "none" | "weak" | "moderate" | "strong" | "unknown";

/** Everything behind a forecast's headline numbers, for the UI to explain itself and for tests to
 *  pin down exact behaviour — never required reading to use the three scenario amounts, but never
 *  hidden either. */
export interface BudgetForecastDiagnostics {
	method: BudgetForecastMethod;
	targetPeriod: {
		from: string;
		to: string;
		label: string;
	};
	/** How many comparable historical observations fed the scenarios — same-period years for a
	 *  seasonal forecast, historical years for a sinking fund, and so on; method-dependent. */
	comparableObservations: number;
	recentMonthsUsed: number;
	/** The current-level baseline a seasonal/variable forecast scales by (e.g. the Theil–Sen trend
	 *  level), before any seasonal ratio or known commitment is applied. */
	baseline?: number;
	knownCommitments: number;
	seasonalFactorP25?: number;
	seasonalFactorP50?: number;
	seasonalFactorP75?: number;
	relativeIqr?: number;
	volatility: VolatilityLabel;
	distribution: DistributionShape;
	seasonality: SeasonalityStrength;
	outlierCount: number;
	sparseMonthRatio?: number;
	/** Plain-language bullet points — see budget_spec.md §52. Never statistical jargon on its own. */
	explanation: string[];
}

/** The full answer for one category: three scenarios (when forecastable), the outliers considered,
 *  and the diagnostics behind them. Nothing here is ever written to `budgetHistory` automatically —
 *  the user always chooses a scenario (or types their own number) before anything is saved. */
export interface BudgetForecastResult {
	categoryId: string;
	method: BudgetForecastMethod;
	forecastable: boolean;
	/** Why not, when `forecastable` is false — e.g. "No spending history", or a policy/non-budgetable
	 *  category's explanation for why it has no statistical suggestion at all. */
	reason?: string;

	p25?: BudgetForecastScenario;
	p50?: BudgetForecastScenario;
	p75?: BudgetForecastScenario;

	/** Which scenario the UI should land on by default — P50 for ordinary categories; undefined for
	 *  a policy-target category, where history is context, never a recommendation (§38). */
	recommendedDefault?: BudgetScenarioKey;

	outliers: BudgetForecastOutlier[];
	diagnostics: BudgetForecastDiagnostics;
}

/** One category's net economic spend for one historical period — the canonical building block every
 *  forecast method reads from, built once per category and reused across methods rather than each
 *  method re-deriving its own version of "what did this category spend that period" (§66). */
export interface CategoryPeriodSpend {
	/** The period's own key — a calendar "YYYY-MM" or a pay-cycle key, matching whichever mode the
	 *  history was built against. */
	key: string;
	from: string;
	to: string;
	/** Net economic expense: expenses minus refunds, transfers/trades/debt-principal excluded — the
	 *  same classification `categoryTotals`/`primaryCategoryTotals` already apply (§12). Never a raw
	 *  sum of negative transaction amounts. */
	economicExpense: number;
	transactionCount: number;
}

/** One historical value being weighed for outlier-ness — the input `detectOutliers` runs on (§21–22).
 *  `normalizedValue` is what's actually compared against its peers (a seasonal ratio for a
 *  month-of-year comparison, a plain euro amount for a sinking-fund's annual totals) — never
 *  `amount` itself, so ordinary multi-year growth in the raw euros isn't mistaken for an anomaly. */
export interface ForecastObservation {
	id: string;
	period: string;
	amount: number;
	normalizedValue: number;
}

/** A known future cost for a category — outranks statistical guessing wherever one exists (§13, §15). */
export interface ForecastCommitment {
	id: string;
	categoryId: string;
	expectedDate: string;
	amount: number;
	source: "subscription" | "recurring-series" | "debt" | "manual";
	confidence: "high" | "moderate";
}

/** What's being forecast, and for which slice of the ledger. `target` is always a concrete date
 *  range — never a bare "YYYY-MM" — so the same request shape covers a calendar month and a pay
 *  cycle identically (§10, §11). */
export interface BudgetForecastRequest {
	categoryId: string;
	target: DateRange & { label: string };
	scope: "leaf" | "rollup";
	/** Per-observation include/exclude decisions for this one request only — never persisted globally
	 *  unless the user explicitly asks (§40). Keyed by the outlier's own `id`. */
	outlierOverrides?: Record<string, "include" | "exclude">;
}
