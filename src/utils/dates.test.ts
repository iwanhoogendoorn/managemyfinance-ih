import { describe, expect, it } from "vitest";
import { detectDateOrder, parseFlexibleDate } from "./dates";

describe("parseFlexibleDate", () => {
	it("reads YYYYMMDD straight through", () => {
		expect(parseFlexibleDate("20260812")).toBe("2026-08-12");
	});

	it("passes an already-ISO date through unchanged", () => {
		expect(parseFlexibleDate("2026-08-12")).toBe("2026-08-12");
	});

	it("defaults slash dates to day-first, matching ING/Trade Republic's own exports", () => {
		expect(parseFlexibleDate("27/07/2026")).toBe("2026-07-27");
	});

	it("reads month-first when explicitly told to", () => {
		expect(parseFlexibleDate("08/12/2026", "mdy")).toBe("2026-08-12");
	});

	it("expands a two-digit year the same way regardless of order", () => {
		expect(parseFlexibleDate("05/06/99", "dmy")).toBe("1999-06-05");
		expect(parseFlexibleDate("05/06/24", "mdy")).toBe("2024-05-06");
	});
});

describe("detectDateOrder", () => {
	it("settles day-first from a single unambiguous date", () => {
		expect(detectDateOrder(["08/08/2026", "27/07/2026", "05/06/2026"])).toBe("dmy");
	});

	it("settles month-first from a single unambiguous date — the AMEX bug this exists to catch", () => {
		// A real AMEX (US-format) export: every date here is "08/DD/2026" (August), but 18 and 17 can
		// only be days, proving the whole batch is month-first even though most rows look D/M-plausible.
		expect(detectDateOrder(["08/12/2026", "08/09/2026", "08/08/2026", "08/07/2026", "08/05/2026", "08/18/2026", "08/17/2026"])).toBe("mdy");
	});

	it("falls back to day-first when every date in the batch is genuinely ambiguous", () => {
		expect(detectDateOrder(["01/05/2026", "02/06/2026"])).toBe("dmy");
	});

	it("ignores non-slash values (8-digit or ISO) when settling the order", () => {
		expect(detectDateOrder(["20260101", "2026-01-01", "08/18/2026"])).toBe("mdy");
	});
});
