import { describe, it, expect } from "vitest";
import { bowleySkewness, iqr, mad, median, modifiedZScore, quantileR7, relativeIqr, theilSen, theilSenLevelAt } from "./statistics";

describe("quantileR7", () => {
	it("interpolates within an odd sample", () => {
		const values = [1, 2, 3, 4, 5];
		expect(quantileR7(values, 0.25)).toBe(2);
		expect(quantileR7(values, 0.5)).toBe(3);
		expect(quantileR7(values, 0.75)).toBe(4);
	});

	it("interpolates within an even sample", () => {
		const values = [1, 2, 3, 4];
		expect(quantileR7(values, 0.5)).toBe(2.5);
	});

	it("returns the single value for a one-element sample, at any quantile", () => {
		expect(quantileR7([42], 0.1)).toBe(42);
		expect(quantileR7([42], 0.9)).toBe(42);
	});

	it("collapses to that value when every observation is a duplicate", () => {
		expect(quantileR7([5, 5, 5, 5], 0.25)).toBe(5);
		expect(quantileR7([5, 5, 5, 5], 0.75)).toBe(5);
	});

	it("handles an all-zero sample without dividing by it", () => {
		expect(quantileR7([0, 0, 0], 0.5)).toBe(0);
	});

	it("is undefined for an empty sample", () => {
		expect(quantileR7([], 0.5)).toBeUndefined();
	});

	it("is unaffected by input order", () => {
		expect(quantileR7([5, 1, 3, 2, 4], 0.5)).toBe(3);
	});
});

describe("median / iqr / relativeIqr", () => {
	it("median matches quantileR7 at 0.5", () => {
		expect(median([1, 2, 3, 4, 5])).toBe(3);
	});

	it("iqr is P75 minus P25", () => {
		expect(iqr([1, 2, 3, 4, 5])).toBe(2); // P75=4, P25=2
	});

	it("iqr is zero for an empty sample", () => {
		expect(iqr([])).toBe(0);
	});

	it("relativeIqr scales iqr by the sample's own median", () => {
		// [1,2,3,4,5]: P25=2, P50=3, P75=4 -> iqr=2, relative = 2/3
		expect(relativeIqr([1, 2, 3, 4, 5])).toBeCloseTo(2 / 3, 6);
	});

	it("does not divide by zero when the median is zero", () => {
		expect(Number.isFinite(relativeIqr([0, 0, 0, 0]))).toBe(true);
	});
});

describe("bowleySkewness", () => {
	it("is zero when P75 equals P25 (no spread to be lopsided in)", () => {
		expect(bowleySkewness([5, 5, 5, 5])).toBe(0);
	});

	it("is positive when the upper tail stretches further than the lower one", () => {
		// P25=10, P50=20, P75=100 -> the P75 tail (80) dwarfs the P25 tail (10)
		expect(bowleySkewness([1, 10, 20, 100, 1000])).toBeGreaterThan(0);
	});
});

describe("mad / modifiedZScore — flags the spec's own worked example", () => {
	// budget_spec.md §55: nine ordinary values plus one that should be flagged as an outlier.
	const values = [0.96, 1.02, 1.05, 1.07, 1.09, 1.1, 1.12, 1.18, 1.21, 3.2];

	it("computes a MAD close to the values' typical spread", () => {
		expect(mad(values)).toBeCloseTo(0.06, 6);
	});

	it("flags the 3.20 outlier (|modified z| > 3.5)", () => {
		const m = median(values)!;
		const madValue = mad(values);
		expect(Math.abs(modifiedZScore(3.2, m, madValue))).toBeGreaterThan(3.5);
	});

	it("does not flag an ordinary in-band value", () => {
		const m = median(values)!;
		const madValue = mad(values);
		expect(Math.abs(modifiedZScore(1.1, m, madValue))).toBeLessThan(3.5);
	});

	it("returns 0 rather than dividing by zero when MAD is 0", () => {
		expect(modifiedZScore(5, 1, 0)).toBe(0);
	});
});

describe("theilSen", () => {
	it("is undefined for no points, and a flat line through a single point", () => {
		expect(theilSen([])).toBeUndefined();
		expect(theilSen([{ x: 0, y: 100 }])).toEqual({ slope: 0, intercept: 100 });
	});

	it("is not dragged around by one extreme month, unlike an ordinary least-squares fit would be", () => {
		// Five ordinary months around €100, then one €500 spike — an OLS line through this would show
		// a strong upward trend driven almost entirely by the spike; Theil–Sen shouldn't.
		const points = [
			{ x: 0, y: 100 },
			{ x: 1, y: 102 },
			{ x: 2, y: 98 },
			{ x: 3, y: 101 },
			{ x: 4, y: 99 },
			{ x: 5, y: 500 },
		];
		const fit = theilSen(points)!;
		expect(fit.slope).toBeCloseTo(0.5, 6);
		expect(fit.intercept).toBeCloseTo(99.75, 6);
		// The fitted level at the spike's own x is nowhere near the spike — proof it didn't dominate.
		expect(theilSenLevelAt(fit, 5)).toBeLessThan(150);
	});

	it("clamps the fitted level at zero — spending can't forecast negative", () => {
		const fit = { slope: -50, intercept: 100 };
		expect(theilSenLevelAt(fit, 10)).toBe(0); // 100 + (-50*10) = -400, clamped
	});
});
