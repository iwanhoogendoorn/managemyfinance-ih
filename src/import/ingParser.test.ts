import { describe, expect, it } from "vitest";
import { parseIngRows } from "./ingParser";

const HEADERS = ["Date", "Name / Description", "Debit/Credit", "Amount (EUR)"];

describe("parseIngRows — date order", () => {
	it("reads a plain ING export as day-first, same as always", () => {
		const rows = [["27/07/2026", "Albert Heijn", "Debit", "12.50"]];
		const [tx] = parseIngRows(HEADERS, rows, { defaultAccountId: "acc-1", source: "generic" });
		expect(tx.date).toBe("2026-07-27");
	});

	it("self-corrects a US-format (month-first) generic CSV, like a real AMEX export", () => {
		// The exact shape of the bug: every date here is 08/DD/2026 (August), but two rows (17, 18)
		// can only be days, which must settle every row in the file the same way — not just those two.
		const rows = [
			["08/12/2026", "Grab Rides", "Debit", "3.57"],
			["08/09/2026", "Burger King", "Debit", "19.29"],
			["08/08/2026", "2C2P*Demerge", "Debit", "3.29"],
			["08/07/2026", "2C2P*Demerge", "Debit", "4.55"],
			["08/05/2026", "Bruna Lounge", "Debit", "24.99"],
			["08/18/2026", "Grab*", "Debit", "10.28"],
			["08/17/2026", "Spotify", "Debit", "17.99"],
		];
		const parsed = parseIngRows(HEADERS, rows, { defaultAccountId: "acc-1", source: "generic" });
		expect(parsed.map((tx) => tx.date)).toEqual(["2026-08-12", "2026-08-09", "2026-08-08", "2026-08-07", "2026-08-05", "2026-08-18", "2026-08-17"]);
	});

	it("stays day-first when a generic CSV's dates are genuinely ambiguous", () => {
		const rows = [
			["01/08/2026", "Shop A", "Debit", "1.00"],
			["02/08/2026", "Shop B", "Debit", "2.00"],
		];
		const parsed = parseIngRows(HEADERS, rows, { defaultAccountId: "acc-1", source: "generic" });
		expect(parsed.map((tx) => tx.date)).toEqual(["2026-08-01", "2026-08-02"]);
	});
});
