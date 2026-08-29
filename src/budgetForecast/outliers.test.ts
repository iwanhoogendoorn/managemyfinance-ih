import { describe, expect, it } from "vitest";
import { detectOutliers } from "./outliers";
import type { ForecastObservation } from "./types";

function obs(id: string, normalizedValue: number, amount = normalizedValue * 500): ForecastObservation {
	return { id, period: id, amount, normalizedValue };
}

describe("detectOutliers", () => {
	it("flags nothing with fewer than four observations, regardless of spread", () => {
		const observations = [obs("a", 1), obs("b", 1), obs("c", 10)];
		expect(detectOutliers(observations, "seasonal-quantile")).toEqual([]);
	});

	it("flags a genuinely unusual value via modified Z-score and excludes it by default for a seasonal forecast", () => {
		// Eight ordinary years clustered around a ratio of ~1.0, one wildly higher (a wedding, a
		// one-off trip) — the exact "€1,600 September" shape from budget_spec.md §21.
		const observations = [
			obs("2017", 0.96),
			obs("2018", 1.02),
			obs("2019", 1.1),
			obs("2020", 1.05),
			obs("2021", 1.18),
			obs("2022", 1.07),
			obs("2023", 1.12),
			obs("2024", 3.08, 1600),
		];
		const outliers = detectOutliers(observations, "seasonal-quantile");
		expect(outliers).toHaveLength(1);
		expect(outliers[0]).toMatchObject({ id: "2024", amount: 1600, normalizedValue: 3.08, includedByDefault: false });
		expect(outliers[0].reason).toContain("higher");
	});

	it("includes a flagged outlier by default for a sinking-fund forecast — the risk the fund exists to absorb", () => {
		const observations = [obs("a", 0.9), obs("b", 1.0), obs("c", 1.1), obs("d", 1.05), obs("e", 4.5)];
		const outliers = detectOutliers(observations, "sinking-fund");
		expect(outliers.find((o) => o.id === "e")).toMatchObject({ includedByDefault: true });
	});

	it("says 'lower' for a flagged value below the median", () => {
		const observations = [obs("a", 1.0), obs("b", 1.02), obs("c", 0.98), obs("d", 1.05), obs("e", 0.01)];
		const outliers = detectOutliers(observations, "seasonal-quantile");
		expect(outliers.find((o) => o.id === "e")?.reason).toContain("lower");
	});

	it("falls back to Tukey fences when every value is identical (MAD is zero) and finds nothing to flag", () => {
		const observations = [obs("a", 1), obs("b", 1), obs("c", 1), obs("d", 1), obs("e", 1)];
		expect(detectOutliers(observations, "seasonal-quantile")).toEqual([]);
	});

	it("flags nothing when the sample is merely spread out, not genuinely anomalous", () => {
		const observations = [obs("a", 0.8), obs("b", 0.9), obs("c", 1.0), obs("d", 1.1), obs("e", 1.2)];
		expect(detectOutliers(observations, "seasonal-quantile")).toEqual([]);
	});
});
