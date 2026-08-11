import { describe, it, expect } from "vitest";
import { formatMoney, formatPct, formatSignedPct, formatCompact } from "./format";

describe("formatMoney", () => {
	it("renders full precision by default", () => {
		expect(formatMoney(1234.56)).toBe("€1,234.56");
	});

	it("takes a decimal override for dense tables (the old metricsTable behaviour)", () => {
		expect(formatMoney(1234.56, "EUR", { decimals: 0 })).toBe("€1,235");
	});

	it("respects the currency argument instead of hardcoding EUR (B5's honest minimum)", () => {
		expect(formatMoney(1234.5, "USD")).toBe("US$1,234.50");
		expect(formatMoney(1234.5, "GBP")).toBe("£1,234.50");
	});

	it("renders negatives with a minus, and never renders a negative zero", () => {
		expect(formatMoney(-42)).toBe("-€42.00");
		expect(formatMoney(-0)).toBe("€0.00");
	});

	it("adds an explicit + only when asked, for deltas", () => {
		expect(formatMoney(12, "EUR", { signed: true })).toBe("+€12.00");
		expect(formatMoney(12)).toBe("€12.00");
		expect(formatMoney(0, "EUR", { signed: true })).toBe("€0.00");
	});

	it("degrades to a labelled plain number rather than throwing on an unusable currency code", () => {
		// Currency codes arrive from imported CSVs; one malformed row must not break a whole render.
		expect(formatMoney(1234.5, "NOTACODE")).toBe("NOTACODE 1,234.50");
	});

	it("returns an em dash for a non-finite number instead of '€NaN'", () => {
		expect(formatMoney(NaN)).toBe("—");
		expect(formatMoney(Infinity)).toBe("—");
	});
});

describe("formatPct", () => {
	it("takes a raw ratio, matching every ratio kpi.ts produces", () => {
		expect(formatPct(0.42)).toBe("42%");
		expect(formatPct(-1)).toBe("-100%");
	});

	it("carries no sign on positives", () => {
		expect(formatPct(0.42)).not.toContain("+");
	});

	it("honours a digit count", () => {
		expect(formatPct(0.1234, 1)).toBe("12.3%");
	});

	it("returns an em dash for a non-finite ratio (e.g. a division by zero upstream)", () => {
		expect(formatPct(NaN)).toBe("—");
	});
});

describe("formatSignedPct", () => {
	it("always shows direction, which is the whole point of a delta", () => {
		expect(formatSignedPct(0.42)).toBe("+42%");
		expect(formatSignedPct(-0.035, 1)).toBe("-3.5%");
	});

	it("leaves zero unsigned", () => {
		expect(formatSignedPct(0)).toBe("0%");
	});
});

describe("formatCompact", () => {
	it("abbreviates for tight spaces like chart axes", () => {
		expect(formatCompact(1_234_567)).toBe("€1.2M");
		expect(formatCompact(48_000)).toBe("€48K");
	});

	it("leaves small numbers readable", () => {
		expect(formatCompact(950)).toBe("€950");
	});

	it("respects the currency argument", () => {
		expect(formatCompact(48_000, "USD")).toBe("US$48K");
	});

	it("returns an em dash for a non-finite number", () => {
		expect(formatCompact(NaN)).toBe("—");
	});
});

import { parseAmount } from "./format";

describe("parseAmount", () => {
	it("reads both decimal conventions", () => {
		expect(parseAmount("30,27")).toBe(30.27);
		expect(parseAmount("30.27")).toBe(30.27);
		expect(parseAmount("0,5")).toBe(0.5);
		expect(parseAmount("-12,5")).toBe(-12.5);
	});
	it("reads grouped thousands in either convention", () => {
		expect(parseAmount("1.234,56")).toBe(1234.56);
		expect(parseAmount("1,234.56")).toBe(1234.56);
		expect(parseAmount("1.234.567")).toBe(1234567);
		expect(parseAmount("1,234")).toBe(1234);
		expect(parseAmount("1,234,567")).toBe(1234567);
	});
	it("strips currency symbols and spaces", () => {
		expect(parseAmount("€ 1.234,56")).toBe(1234.56);
		expect(parseAmount("$1,234.56")).toBe(1234.56);
		expect(parseAmount(" 30,27 ")).toBe(30.27);
	});
	it("keeps a lone dot decimal as typed (round-trips the app's own rendering)", () => {
		expect(parseAmount("1.234")).toBe(1.234);
		expect(parseAmount("30.2")).toBe(30.2);
	});
	it("rejects garbage", () => {
		expect(parseAmount("")).toBeUndefined();
		expect(parseAmount("abc")).toBeUndefined();
		expect(parseAmount("-")).toBeUndefined();
		expect(parseAmount("1.2.3,4,5")).toBeUndefined();
	});
});
