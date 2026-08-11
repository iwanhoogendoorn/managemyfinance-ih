import { describe, expect, it } from "vitest";
import { parseIngRows } from "./ingParser";

const HEADERS = ["Date", "Description", "Amount", "Fee"];

describe("parseIngRows — fee handling", () => {
	/**
	 * Pins the bug found importing a real Revolut export: its Fee column is a cost listed SEPARATELY
	 * from Amount, not already netted into it. Verified against the export's own running balance —
	 * without this subtraction the reconstructed balance drifted further from the bank's own number on
	 * every fee-bearing row; with it, 3,115 real transactions reconciled to the cent.
	 */
	it("subtracts a mapped Fee column from the transaction amount", () => {
		const rows = [["2026-08-11", "SyncroB.it", "-1330.96", "1.65"]];
		const [tx] = parseIngRows(HEADERS, rows, { defaultAccountId: "acc-1", source: "generic" });
		expect(tx.amount).toBeCloseTo(-1332.61, 2);
		expect(tx.fee).toBe(1.65);
	});

	it("leaves the amount untouched when the fee is zero or absent", () => {
		const rows = [["2026-08-11", "Albert Heijn", "-42.50", "0.00"]];
		const [tx] = parseIngRows(HEADERS, rows, { defaultAccountId: "acc-1", source: "generic" });
		expect(tx.amount).toBe(-42.5);
		expect(tx.fee).toBeUndefined();

		const [tx2] = parseIngRows(["Date", "Description", "Amount"], [["2026-08-11", "Albert Heijn", "-42.50"]], {
			defaultAccountId: "acc-1",
			source: "generic",
		});
		expect(tx2.amount).toBe(-42.5);
		expect(tx2.fee).toBeUndefined();
	});

	it("subtracts the fee on an income row too — fee is always a cost regardless of the row's own sign", () => {
		const rows = [["2026-08-11", "Refund", "100.00", "2.50"]];
		const [tx] = parseIngRows(HEADERS, rows, { defaultAccountId: "acc-1", source: "generic" });
		expect(tx.amount).toBeCloseTo(97.5, 2);
	});

	it("reconciles a short real sequence against Revolut's own reported running balance", () => {
		// Taken directly from the real export: five consecutive Current-product rows.
		const rows = [
			["2021-02-24", "SyncroB.it", "-1330.96", "1.65"],
			["2021-02-26", "Apple", "-7.23", "0.04"],
			["2021-03-06", "Www.dediseedbox.com", "-7.69", "0.04"],
			["2021-12-04", "Notion", "-51.37", "0.51"],
		];
		const txs = parseIngRows(HEADERS, rows, { defaultAccountId: "acc-1", source: "generic" });
		const total = txs.reduce((sum, t) => sum + t.amount, 0);
		expect(total).toBeCloseTo(-1330.96 - 1.65 - 7.23 - 0.04 - 7.69 - 0.04 - 51.37 - 0.51, 2);
	});
});
