import { describe, it, expect } from "vitest";
import { baseConfidence, confidenceLabel, scenarioConfidence, type ConfidenceInputs } from "./confidence";

describe("confidenceLabel", () => {
	it("labels the exact boundaries as specified", () => {
		expect(confidenceLabel(49)).toBe("low");
		expect(confidenceLabel(50)).toBe("moderate");
		expect(confidenceLabel(74)).toBe("moderate");
		expect(confidenceLabel(75)).toBe("high");
	});
});

describe("scenarioConfidence", () => {
	it("gives P50 no penalty", () => {
		expect(scenarioConfidence(80, "p50", 12)).toBe(80);
	});

	it("penalizes P25/P75 by 5 points when there's already 8+ comparable observations", () => {
		expect(scenarioConfidence(80, "p25", 8)).toBe(75);
		expect(scenarioConfidence(80, "p75", 10)).toBe(75);
	});

	it("penalizes P25/P75 by a further 5 points when there are fewer than 8 comparable observations", () => {
		expect(scenarioConfidence(80, "p25", 3)).toBe(70);
	});

	it("scores P50 at or above P25/P75 from the same base, when the sample is limited", () => {
		const base = 60;
		const p50 = scenarioConfidence(base, "p50", 4);
		const p25 = scenarioConfidence(base, "p25", 4);
		const p75 = scenarioConfidence(base, "p75", 4);
		expect(p50).toBeGreaterThanOrEqual(p25);
		expect(p50).toBeGreaterThanOrEqual(p75);
	});

	it("clamps to 0–100", () => {
		expect(scenarioConfidence(2, "p25", 1)).toBe(0);
		expect(scenarioConfidence(999, "p50", 20)).toBe(100);
	});
});

describe("baseConfidence", () => {
	it("reaches its maximum when every component is maxed out", () => {
		const inputs: ConfidenceInputs = {
			comparableObservations: 8,
			recentCompleteMonths: 6,
			coverageRatio: 1,
			relativeIqr: 0,
			outlierRatio: 0,
			sparseMonthRatio: 0,
		};
		// 35 + 15 + 15 + 20 + 10 + 5
		expect(baseConfidence(inputs)).toBe(100);
	});

	it("drops to its floor when every component is at its worst", () => {
		const inputs: ConfidenceInputs = {
			comparableObservations: 0,
			recentCompleteMonths: 0,
			coverageRatio: 0,
			relativeIqr: 1,
			outlierRatio: 0.25,
			sparseMonthRatio: 1,
		};
		expect(baseConfidence(inputs)).toBe(0);
	});

	it("does not let one weak component alone collapse the whole score", () => {
		const strong: ConfidenceInputs = {
			comparableObservations: 8,
			recentCompleteMonths: 6,
			coverageRatio: 1,
			relativeIqr: 1, // the one weak signal
			outlierRatio: 0,
			sparseMonthRatio: 0,
		};
		// Everything else is maxed; only stabilityScore's 20 points are lost.
		expect(baseConfidence(strong)).toBe(80);
	});
});
