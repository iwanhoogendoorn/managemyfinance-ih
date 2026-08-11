import { describe, it, expect } from "vitest";
import { upcomingPayments, monthlyCost } from "./subscriptions";
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
