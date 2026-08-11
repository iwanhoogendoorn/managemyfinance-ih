import {
	categorySpend,
	daysInMonth,
	monthOf,
	rollUpCategorySpend,
	shiftMonth,
	todayIso,
	windowSummary,
	firstDayOf,
	lastDayOf,
	type KpiStore,
} from "./kpi";

/** "YYYY-MM" for the current calendar month — budgets are simple and monthly, no rollover. */
export function currentMonth(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * A monthly budget suggestion for one category, extracted from its own recent spending pattern —
 * the average of the last `lookbackMonths` months that actually have transaction history (so a
 * category with no spend before the user started tracking isn't dragged toward zero by "months"
 * that never existed). Rounded to the nearest €5 so it reads as a suggestion, not a false-precision
 * calculation. Returns undefined when there's no spending history to extract a pattern from at all.
 */
export function suggestedBudget(store: KpiStore, categoryId: string, referenceMonth: string, lookbackMonths = 3): number | undefined {
	const earliest = store.transactions.reduce<string | undefined>(
		(min, t) => (t.date && (!min || t.date < min) ? t.date : min),
		undefined
	);
	if (!earliest) return undefined;
	const earliestMonth = earliest.slice(0, 7);

	const amounts: number[] = [];
	for (let i = 1; i <= lookbackMonths; i++) {
		const month = shiftMonth(referenceMonth, -i);
		if (month < earliestMonth) continue;
		// Rolled up so a suggestion for a heading reflects everything filed under it, matching what
		// `budgetStatuses` will then measure that budget against.
		amounts.push(rollUpCategorySpend(categorySpend(store, month), store.categories).get(categoryId) ?? 0);
	}
	if (amounts.length === 0) return undefined;

	const avg = amounts.reduce((a, b) => a + b, 0) / amounts.length;
	if (avg <= 0) return undefined;
	return Math.round(avg / 5) * 5;
}

/**
 * How far through `month` we are, as a fraction in (0, 1]. A month in the past is fully elapsed (1); a
 * future month hasn't started (0); the live month is day-of-month / days-in-month.
 *
 * Note the live month is never 0 — on the 1st it is 1/31, not zero — so every pace ratio built on this
 * is large-but-finite on day one rather than a division by zero.
 */
export function elapsedFraction(month: string, today: Date = new Date()): number {
	const now = todayIso(today);
	const thisMonth = monthOf(now);
	if (month < thisMonth) return 1;
	if (month > thisMonth) return 0;
	return Number(now.slice(8, 10)) / daysInMonth(month);
}

export type BudgetTone = "good" | "warn" | "bad";

export interface CategoryBudgetStatus {
	categoryId: string;
	budget: number;
	spent: number;
	remaining: number;
	/** spent / budget — not clamped, so "250% over" is still visible in the raw number if a caller wants it. */
	pct: number;
	/** Fraction of the month elapsed — the pace tick a progress bar should draw. */
	elapsed: number;
	/** spent / (budget × elapsed). Below 1.0 means the spend is tracking under the limit *for the date*. */
	pace: number;
	/** Where this month ends up at the current rate: spent / elapsed. */
	projected: number;
	tone: BudgetTone;
}

/**
 * Budget-vs-actual for every category that has a budget set, for one month. No rollover: each month
 * is scored purely on its own spend against its own limit.
 *
 * The tone is pace-aware. Scoring 20% of a budget spent on the 3rd as "good" is what makes a budget tool
 * a progress bar: at that rate the month finishes at 200%. So a category projected to blow its limit is
 * warned about now, while "bad" stays reserved for actually being over — a projection is a forecast, an
 * overspend is a fact. For any completed month `elapsed` is 1, so pace equals pct and the thresholds
 * collapse to the original absolute ones.
 */
export function budgetStatuses(
	store: KpiStore,
	categories: { id: string; budget?: number }[],
	month: string,
	today: Date = new Date()
): CategoryBudgetStatus[] {
	// A budget on a parent has to count its subcategories' spend too — otherwise setting a €700
	// Food budget and then filing everything under Food › Groceries would read as €0 spent forever.
	const spend = rollUpCategorySpend(categorySpend(store, month), store.categories);
	const elapsed = elapsedFraction(month, today);
	return categories
		.filter((c) => (c.budget ?? 0) > 0)
		.map((c) => {
			const budget = c.budget!;
			const spent = spend.get(c.id) ?? 0;
			const pct = spent / budget;
			const pace = elapsed > 0 ? pct / elapsed : 0;
			return {
				categoryId: c.id,
				budget,
				spent,
				remaining: budget - spent,
				pct,
				elapsed,
				pace,
				projected: elapsed > 0 ? spent / elapsed : 0,
				tone: (pct >= 1 ? "bad" : pace >= 1 || pct >= 0.8 ? "warn" : "good") as BudgetTone,
			};
		});
}

export interface BudgetSummary {
	totalBudget: number;
	totalSpent: number;
	/** Fraction of the month elapsed. */
	elapsed: number;
	/** totalSpent / (totalBudget × elapsed) — the one number the budget strip's tone should follow. */
	pace: number;
	/** Categories already past their limit. */
	overCount: number;
	/** Categories on pace to end the month over, but not over yet. */
	projectedOverCount: number;
	/**
	 * Spend this month in categories with no budget at all. Without it a user can read "everything under
	 * budget" while the majority of their money leaves through categories nobody set a limit on.
	 */
	unbudgetedSpend: number;
}

/** The month's budget health in one object — the aggregate behind the overview's budget strip. */
export function budgetSummary(
	store: KpiStore,
	categories: { id: string; budget?: number }[],
	month: string,
	today: Date = new Date()
): BudgetSummary {
	const statuses = budgetStatuses(store, categories, month, today);
	const elapsed = elapsedFraction(month, today);
	const totalBudget = statuses.reduce((sum, s) => sum + s.budget, 0);
	const totalSpent = statuses.reduce((sum, s) => sum + s.spent, 0);
	const monthExpenses = windowSummary(store, firstDayOf(month), lastDayOf(month)).expenses;
	return {
		totalBudget,
		totalSpent,
		elapsed,
		pace: totalBudget > 0 && elapsed > 0 ? totalSpent / (totalBudget * elapsed) : 0,
		overCount: statuses.filter((s) => s.pct >= 1).length,
		projectedOverCount: statuses.filter((s) => s.pct < 1 && s.pace >= 1).length,
		unbudgetedSpend: Math.max(0, monthExpenses - totalSpent),
	};
}
