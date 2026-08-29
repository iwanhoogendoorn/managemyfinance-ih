import { resolvePrimaryId } from "../categories";
import type { Category } from "../types";
import type { BudgetForecastMethod } from "./types";

/**
 * The default category → forecast method mapping (budget_spec.md §5–7): what a category should be
 * forecast with before any user override. Keyed by lowercased default name, matched against a
 * category's own `name` (and, for a secondary, its primary's `name`) — never against category ids,
 * since those are per-vault opaque strings, not the same across two vaults' default seed data.
 *
 * A handful of primaries/secondaries the spec describes as conditionally switching method — Gifts
 * ("if extremely sparse, fall back to sinking-fund"), Shipping & Handling ("if sparse..."), Kids →
 * Toys ("if very sparse..."), Education ("if a stable monthly pattern is detected, may upgrade to
 * fixed-commitment") — are mapped straight to `"adaptive-hybrid"` rather than getting their own
 * bespoke switching logic: `chooseAdaptiveMethod`'s own decision tree (§35) already implements
 * exactly "sparse → sinking-fund" and "high recurring share + low volatility → fixed-commitment" as
 * general rules, so routing these categories through it reproduces the spec's intent without a second,
 * parallel special-case mechanism.
 *
 * A secondary absent from a primary's own table (Insurance's three secondaries, Travel & Vacation's
 * Flights/Hotels/Rental Car) is deliberate, not an oversight — the spec lists those names without a
 * method column specifically because they're meant to inherit the primary's own method (§69's "every
 * default secondary has a method or inherits intentionally").
 */
export interface DefaultCategoryProfile {
	method: BudgetForecastMethod;
	/** Only when this primary is genuinely non-budgetable (§6.6, §6.25) — carried through so the
	 *  engine's `"none"` result explains itself instead of a generic fallback message. */
	reason?: string;
	secondaries?: Record<string, BudgetForecastMethod>;
}

export const DEFAULT_CATEGORY_PROFILES: Record<string, DefaultCategoryProfile> = {
	"auto & transport": {
		method: "adaptive-hybrid",
		secondaries: {
			fuel: "seasonal-quantile",
			parking: "seasonal-quantile",
			"maintenance & repairs": "sinking-fund",
			"car wash": "seasonal-quantile",
			"public transport": "seasonal-quantile",
			"auto insurance": "fixed-commitment",
		},
	},
	"health & fitness": {
		method: "recurring-plus-variable",
		secondaries: { gym: "fixed-commitment", "hair & nails": "recurring-plus-variable", "spa & massage": "seasonal-quantile" },
	},
	"bills & utilities": {
		method: "recurring-plus-variable",
		secondaries: { "electricity & gas": "seasonal-quantile", water: "seasonal-quantile", "internet & phone": "fixed-commitment", "garbage & recycling": "fixed-commitment" },
	},
	home: {
		method: "adaptive-hybrid",
		secondaries: { "furniture & decor": "sinking-fund", "home improvement": "sinking-fund", "home supplies": "seasonal-quantile", "household services": "recurring-plus-variable" },
	},
	business: { method: "adaptive-hybrid" },
	"cash/atm": { method: "none", reason: "Cash withdrawals are cash movements, not reliably categorized economic spending." },
	charity: { method: "policy-target" },
	education: { method: "adaptive-hybrid" },
	entertainment: {
		method: "recurring-plus-variable",
		secondaries: { "movies & streaming": "recurring-plus-variable", "concerts & events": "sinking-fund", music: "recurring-plus-variable", subscriptions: "fixed-commitment" },
	},
	"fees & charges": { method: "guardrail" },
	food: {
		method: "seasonal-quantile",
		secondaries: {
			groceries: "seasonal-quantile",
			"restaurants & dining": "seasonal-quantile",
			"coffee & snacks": "seasonal-quantile",
			"fast food": "seasonal-quantile",
			"alcohol & bars": "seasonal-quantile",
		},
	},
	gifts: { method: "adaptive-hybrid" },
	income: { method: "income-target" },
	insurance: { method: "fixed-commitment" },
	kids: {
		method: "adaptive-hybrid",
		secondaries: { "childcare & daycare": "fixed-commitment", "kids clothing": "seasonal-quantile", toys: "adaptive-hybrid" },
	},
	legal: { method: "sinking-fund" },
	loan: { method: "debt-schedule" },
	medical: {
		method: "sinking-fund",
		secondaries: { doctor: "sinking-fund", dentist: "sinking-fund", pharmacy: "recurring-plus-variable" },
	},
	"mortgage & rent": {
		method: "fixed-commitment",
		secondaries: { "mortgage interest": "debt-schedule", "mortgage principal": "debt-schedule" },
	},
	pets: {
		method: "adaptive-hybrid",
		secondaries: { "pet food": "seasonal-quantile", veterinary: "sinking-fund", grooming: "recurring-plus-variable" },
	},
	savings: { method: "policy-target" },
	"shipping & handling": { method: "adaptive-hybrid" },
	shopping: {
		method: "adaptive-hybrid",
		secondaries: { clothing: "seasonal-quantile", electronics: "sinking-fund", books: "seasonal-quantile", "sports & hobbies": "seasonal-quantile", "home & decor": "sinking-fund" },
	},
	taxes: { method: "sinking-fund" },
	transfers: { method: "none", reason: "Transfers are movements between your own accounts, not economic spending." },
	"travel & vacation": { method: "adaptive-hybrid" },
};

function normalize(name: string): string {
	return name.trim().toLowerCase();
}

/**
 * The default method for a category — checked against its own name first (covers both a default
 * primary and a default secondary whose primary doesn't matter for the lookup, since secondary names
 * are unique enough across the whole default taxonomy not to collide), then its primary's name if it
 * has one. Undefined for a category that matches no default name at all — a genuinely user-created
 * category, which §7 sends to the adaptive classifier instead, never to a hardcoded default.
 */
export function resolveDefaultMethod(categories: Category[], categoryId: string): BudgetForecastMethod | undefined {
	const category = categories.find((c) => c.id === categoryId);
	if (!category) return undefined;

	const ownName = normalize(category.name);
	if (DEFAULT_CATEGORY_PROFILES[ownName]) return DEFAULT_CATEGORY_PROFILES[ownName].method;

	if (category.parentId) {
		const primaryId = resolvePrimaryId(categories, categoryId);
		const primary = categories.find((c) => c.id === primaryId);
		if (primary) {
			const profile = DEFAULT_CATEGORY_PROFILES[normalize(primary.name)];
			if (profile) return profile.secondaries?.[ownName] ?? profile.method;
		}
	}

	return undefined;
}

/** The exact spec reason text for a non-budgetable default primary (Cash/ATM, Transfers) — undefined
 *  for anything else, including a category that merely resolved to `"none"` some other way. */
export function defaultNonBudgetableReason(categories: Category[], categoryId: string): string | undefined {
	const category = categories.find((c) => c.id === categoryId);
	if (!category) return undefined;
	const ownName = normalize(category.name);
	if (DEFAULT_CATEGORY_PROFILES[ownName]?.method === "none") return DEFAULT_CATEGORY_PROFILES[ownName].reason;

	if (category.parentId) {
		const primaryId = resolvePrimaryId(categories, categoryId);
		const primary = categories.find((c) => c.id === primaryId);
		const profile = primary ? DEFAULT_CATEGORY_PROFILES[normalize(primary.name)] : undefined;
		if (profile && (profile.secondaries?.[ownName] ?? profile.method) === "none") return profile.reason;
	}
	return undefined;
}
