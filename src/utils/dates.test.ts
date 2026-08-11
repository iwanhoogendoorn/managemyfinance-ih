import { describe, expect, it } from "vitest";
import { parseFlexibleDate } from "./dates";

describe("parseFlexibleDate", () => {
	it("reads YYYYMMDD", () => {
		expect(parseFlexibleDate("20260811")).toBe("2026-08-11");
	});

	it("reads European D/M/YYYY and D/M/YY", () => {
		expect(parseFlexibleDate("27/07/2026")).toBe("2026-07-27");
		expect(parseFlexibleDate("5/8/26")).toBe("2026-08-05");
		expect(parseFlexibleDate("5/8/69")).toBe("2069-08-05");
		expect(parseFlexibleDate("5/8/71")).toBe("1971-08-05");
	});

	it("reads a bare ISO date", () => {
		expect(parseFlexibleDate("2026-08-11")).toBe("2026-08-11");
	});

	/**
	 * The bug this whole file exists to pin: a Revolut-style "YYYY-MM-DD HH:MM:SS" timestamp used to
	 * fall through to `new Date(s).toISOString()`, which V8 parses as local time and re-renders in
	 * UTC — silently rolling any completion time in the first couple of hours of the day back to the
	 * previous calendar date. Every one of these must return the date the string itself states,
	 * regardless of what timezone the test runner's machine is in.
	 */
	it("reads a 'YYYY-MM-DD HH:MM:SS' timestamp by its own date, never shifted by timezone", () => {
		expect(parseFlexibleDate("2026-08-11 00:15:00")).toBe("2026-08-11");
		expect(parseFlexibleDate("2026-08-11 01:30:00")).toBe("2026-08-11");
		expect(parseFlexibleDate("2020-01-01 00:00:01")).toBe("2020-01-01");
		expect(parseFlexibleDate("2019-12-04 07:52:51")).toBe("2019-12-04");
		expect(parseFlexibleDate("2026-08-11 23:58:00")).toBe("2026-08-11");
	});

	it("reads a 'YYYY-MM-DDTHH:MM:SS' timestamp the same way", () => {
		expect(parseFlexibleDate("2026-08-11T00:15:00")).toBe("2026-08-11");
	});

	it("reads a timestamp with no seconds", () => {
		expect(parseFlexibleDate("2026-08-11 00:15")).toBe("2026-08-11");
	});

	it("passes through whitespace before parsing", () => {
		expect(parseFlexibleDate("  2026-08-11  ")).toBe("2026-08-11");
	});

	it("returns the input verbatim when nothing matches and Date() can't parse it either", () => {
		expect(parseFlexibleDate("not a date")).toBe("not a date");
	});
});
