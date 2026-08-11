import { describe, it, expect } from "vitest";
import { daysUntil, nextOccurrence, upcomingPayments, monthlyCost } from "./subscriptions";
import type { Subscription } from "./types";

function sub(partial: Partial<Subscription> & Pick<Subscription, "id" | "cost" | "billingCycle" | "nextDueDate">): Subscription {
	return {
		name: partial.name ?? "Test",
		category: "Software",
		paidVia: "private",
		...partial,
	};
}

describe("upcomingPayments", () => {
	const today = new Date(2024, 5, 1); // 2024-06-01

	it("carries the amount actually charged on that date, not the normalized monthly cost (regression: B4)", () => {
		// A €120/year subscription due next week takes €120 out of the account that day. Reporting its
		// €10 monthly share understates an imminent payment by an order of magnitude.
		const yearly = sub({ id: "s1", cost: 120, billingCycle: "yearly", nextDueDate: "2024-06-08" });
		const [payment] = upcomingPayments([yearly], today);
		expect(payment.amount).toBe(120);
		expect(monthlyCost(yearly)).toBe(10);
	});

	it("still reports the date and days-until for each active subscription, soonest first", () => {
		const payments = upcomingPayments(
			[
				sub({ id: "s1", cost: 30, billingCycle: "quarterly", nextDueDate: "2024-06-20" }),
				sub({ id: "s2", cost: 9.99, billingCycle: "monthly", nextDueDate: "2024-06-05" }),
			],
			today
		);
		expect(payments.map((p) => p.sub.id)).toEqual(["s2", "s1"]);
		expect(payments.map((p) => p.amount)).toEqual([9.99, 30]);
		expect(payments[0].daysUntil).toBe(4);
	});

	it("reports the stored due date itself, not the day before it (regression: TZ, review CRITICAL #2)", () => {
		// `nextDueDate` is parsed as *local* midnight, so rendering it through toISOString() reported the
		// previous day for every timezone east of UTC — every subscription date in the app a day early,
		// and a charge due on the 1st of next month pulled into this month's committed outflows.
		//
		// Every date here is built from local components on both sides, so the assertion holds in any TZ.
		const today = new Date(2026, 7, 11); // 2026-08-11 local
		const monthly = sub({ id: "s1", cost: 12.99, billingCycle: "monthly", nextDueDate: "2026-09-01" });
		expect(nextOccurrence(monthly, today)).toBe("2026-09-01");
		expect(daysUntil("2026-09-01", today)).toBe(21);

		const [payment] = upcomingPayments([monthly], today);
		expect(payment.date).toBe("2026-09-01");
		expect(payment.daysUntil).toBe(21);

		// And an anchor already in the past rolls forward onto the same calendar day, not the day before it.
		const rolled = sub({ id: "s2", cost: 5, billingCycle: "monthly", nextDueDate: "2026-08-01" });
		expect(nextOccurrence(rolled, today)).toBe("2026-09-01");
	});

	it("skips archived and lapsed subscriptions", () => {
		const payments = upcomingPayments(
			[
				sub({ id: "s1", cost: 10, billingCycle: "monthly", nextDueDate: "2024-06-10", archived: true }),
				sub({ id: "s2", cost: 10, billingCycle: "monthly", nextDueDate: "2024-01-10", endDate: "2024-03-01" }),
			],
			today
		);
		expect(payments).toEqual([]);
	});
});
