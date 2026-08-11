import type { Subscription, SubscriptionBillingCycle } from "./types";

export const SUBSCRIPTION_CATEGORIES = [
	"AI",
	"Streaming",
	"Software",
	"Cloud & Storage",
	"Gaming",
	"Music",
	"News & Media",
	"Health & Fitness",
	"Finance",
	"Utilities",
	"Other",
];

export const BILLING_CYCLE_LABEL: Record<SubscriptionBillingCycle, string> = {
	weekly: "Weekly",
	monthly: "Monthly",
	quarterly: "Quarterly",
	yearly: "Yearly",
};

const MONTHLY_FACTOR: Record<SubscriptionBillingCycle, number> = {
	weekly: 52 / 12,
	monthly: 1,
	quarterly: 1 / 3,
	yearly: 1 / 12,
};

export function monthlyCost(sub: Subscription): number {
	return sub.cost * MONTHLY_FACTOR[sub.billingCycle];
}

export function yearlyCost(sub: Subscription): number {
	return monthlyCost(sub) * 12;
}

function pad2(n: number): string {
	return String(n).padStart(2, "0");
}

/**
 * A Date's day in the *local* calendar as "YYYY-MM-DD".
 *
 * Deliberately built from local components rather than `toISOString().slice(0, 10)`: every Date in this
 * file starts life as local midnight (`new Date("2026-09-01T00:00:00")`), and rendering local midnight
 * through UTC reports the *previous* day for everyone east of UTC. That made every subscription date in
 * the app a day early, put `daysUntil` off by one, and pulled a charge due on the 1st of next month into
 * this month's committed outflows. Same reasoning — and same shape — as `kpi.ts`'s `todayIso`.
 */
function isoDate(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addCycle(date: Date, cycle: SubscriptionBillingCycle): Date {
	const d = new Date(date);
	switch (cycle) {
		case "weekly":
			d.setDate(d.getDate() + 7);
			break;
		case "monthly":
			d.setMonth(d.getMonth() + 1);
			break;
		case "quarterly":
			d.setMonth(d.getMonth() + 3);
			break;
		case "yearly":
			d.setFullYear(d.getFullYear() + 1);
			break;
	}
	return d;
}

/**
 * The next payment date on or after `today`, rolling `nextDueDate` forward by whole billing
 * cycles — so a subscription's stored anchor date doesn't need editing after every payment.
 * Returns undefined once that roll-forward would land past `endDate` (the subscription has lapsed).
 */
export function nextOccurrence(sub: Subscription, today: Date = new Date()): string | undefined {
	if (!sub.nextDueDate) return undefined;
	const todayIso = isoDate(today);
	let d = new Date(`${sub.nextDueDate}T00:00:00`);
	if (isNaN(d.getTime())) return undefined;

	let guard = 0;
	while (isoDate(d) < todayIso && guard < 2000) {
		d = addCycle(d, sub.billingCycle);
		guard++;
	}
	const occurrence = isoDate(d);
	if (sub.endDate && occurrence > sub.endDate) return undefined;
	return occurrence;
}

export function isActive(sub: Subscription, today: Date = new Date()): boolean {
	if (sub.archived) return false;
	if (sub.endDate && sub.endDate < isoDate(today)) return false;
	return true;
}

export function daysUntil(dateStr: string, today: Date = new Date()): number {
	const target = new Date(`${dateStr}T00:00:00`);
	const t0 = new Date(`${isoDate(today)}T00:00:00`);
	return Math.round((target.getTime() - t0.getTime()) / 86400000);
}

export interface SubscriptionTotals {
	perMonth: number;
	perYear: number;
	privatePerMonth: number;
	businessPerMonth: number;
	activeCount: number;
	dueSoonCount: number;
}

/** `dueSoonDays` window uses each subscription's rolled-forward next occurrence, not the stored anchor date. */
export function subscriptionTotals(subs: Subscription[], today: Date = new Date(), dueSoonDays = 7): SubscriptionTotals {
	const active = subs.filter((s) => isActive(s, today));
	const perMonth = active.reduce((sum, s) => sum + monthlyCost(s), 0);
	const dueSoonCount = active.filter((s) => {
		const next = nextOccurrence(s, today);
		if (!next) return false;
		const d = daysUntil(next, today);
		return d >= 0 && d <= dueSoonDays;
	}).length;

	return {
		perMonth,
		perYear: perMonth * 12,
		privatePerMonth: active.filter((s) => s.paidVia === "private").reduce((sum, s) => sum + monthlyCost(s), 0),
		businessPerMonth: active.filter((s) => s.paidVia === "business").reduce((sum, s) => sum + monthlyCost(s), 0),
		activeCount: active.length,
		dueSoonCount,
	};
}

export function totalsByCategory(subs: Subscription[], today: Date = new Date()): { label: string; value: number }[] {
	const totals = new Map<string, number>();
	for (const s of subs.filter((s) => isActive(s, today))) {
		totals.set(s.category, (totals.get(s.category) ?? 0) + monthlyCost(s));
	}
	return Array.from(totals.entries())
		.map(([label, value]) => ({ label, value }))
		.sort((a, b) => b.value - a.value);
}

export function totalsByBillingCycle(subs: Subscription[], today: Date = new Date()): { label: string; value: number }[] {
	const totals = new Map<SubscriptionBillingCycle, number>();
	for (const s of subs.filter((s) => isActive(s, today))) {
		totals.set(s.billingCycle, (totals.get(s.billingCycle) ?? 0) + monthlyCost(s));
	}
	return Array.from(totals.entries())
		.map(([cycle, value]) => ({ label: BILLING_CYCLE_LABEL[cycle], value }))
		.sort((a, b) => b.value - a.value);
}

export function totalsByPaidVia(subs: Subscription[], today: Date = new Date()): { label: string; value: number }[] {
	const active = subs.filter((s) => isActive(s, today));
	return [
		{ label: "Private", value: active.filter((s) => s.paidVia === "private").reduce((sum, s) => sum + monthlyCost(s), 0) },
		{ label: "Business", value: active.filter((s) => s.paidVia === "business").reduce((sum, s) => sum + monthlyCost(s), 0) },
	];
}

export interface UpcomingPayment {
	sub: Subscription;
	date: string;
	daysUntil: number;
	/**
	 * What actually hits the account on `date` — `sub.cost`, the real charge, not `monthlyCost`.
	 * A €120/year subscription due next week is €120 leaving your balance that day; calling it €10
	 * (its normalized monthly share) understates an imminent payment by an order of magnitude.
	 */
	amount: number;
}

/** Every active subscription's next payment, soonest first — the feed behind "Upcoming payments". */
export function upcomingPayments(subs: Subscription[], today: Date = new Date()): UpcomingPayment[] {
	return subs
		.filter((s) => isActive(s, today))
		.map((sub) => {
			const date = nextOccurrence(sub, today);
			return date ? { sub, date, daysUntil: daysUntil(date, today), amount: sub.cost } : undefined;
		})
		.filter((x): x is UpcomingPayment => x !== undefined)
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
