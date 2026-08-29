import { describe, expect, it } from "vitest";
import { distributionShape, seasonalityStrengthLabel, volatilityLabel } from "./diagnostics";

describe("volatilityLabel", () => {
	it("reads the spec's own worked examples correctly", () => {
		// P25 480, P50 500, P75 520 → relativeIqr = 40/500 = 0.08 → low (§18)
		expect(volatilityLabel(0.08)).toBe("low");
		// P25 300, P50 500, P75 900 → relativeIqr = 600/500 = 1.2 → high (§18)
		expect(volatilityLabel(1.2)).toBe("high");
	});

	it("labels the moderate band and both boundaries", () => {
		expect(volatilityLabel(0.19)).toBe("low");
		expect(volatilityLabel(0.2)).toBe("moderate");
		expect(volatilityLabel(0.49)).toBe("moderate");
		expect(volatilityLabel(0.5)).toBe("high");
	});
});

describe("distributionShape", () => {
	it("reads symmetric when the median sits centered between P25 and P75", () => {
		expect(distributionShape([400, 500, 600], 0)).toBe("symmetric");
	});

	it("reads right-skewed when the upper tail stretches further than the lower one", () => {
		expect(distributionShape([490, 500, 900], 0)).toBe("right-skewed");
	});

	it("reads left-skewed for the mirror image", () => {
		expect(distributionShape([100, 500, 510], 0)).toBe("left-skewed");
	});

	it("overrides skew entirely once more than half the sample is zero", () => {
		expect(distributionShape([0, 0, 0, 500, 600], 0.6)).toBe("sparse");
	});

	it("is unknown with fewer than two values to compare", () => {
		expect(distributionShape([500], 0)).toBe("unknown");
		expect(distributionShape([], 0)).toBe("unknown");
	});
});

describe("seasonalityStrengthLabel", () => {
	it("is unknown when there isn't enough history to compute a spread at all", () => {
		expect(seasonalityStrengthLabel(undefined)).toBe("unknown");
	});

	it("labels none only for an exactly flat spread", () => {
		expect(seasonalityStrengthLabel(0)).toBe("none");
	});

	it("labels weak, moderate and strong at the spec's own thresholds (§20)", () => {
		expect(seasonalityStrengthLabel(0.05)).toBe("weak");
		expect(seasonalityStrengthLabel(0.1)).toBe("moderate");
		expect(seasonalityStrengthLabel(0.2)).toBe("moderate");
		expect(seasonalityStrengthLabel(0.25)).toBe("strong");
		expect(seasonalityStrengthLabel(0.4)).toBe("strong");
	});
});
