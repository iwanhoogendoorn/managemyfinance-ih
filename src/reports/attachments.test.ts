import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import { collectReportAttachments } from "./attachments";
import type { Transaction } from "../types";

function tx(id: string, over: Partial<Transaction> = {}): Transaction {
	return {
		id,
		date: "2025-03-01",
		accountId: "acc1",
		description: "Dinner",
		amount: -12,
		currency: "EUR",
		source: "manual",
		...over,
	} as Transaction;
}

describe("collectReportAttachments", () => {
	it("reads an image attachment into a data URI", async () => {
		const app = new App();
		await app.vault.adapter.writeBinary("attachments/receipt.jpg", new Uint8Array([1, 2, 3]).buffer);
		const result = await collectReportAttachments(app, [tx("t1", { attachmentPath: "attachments/receipt.jpg" })]);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ txId: "t1", path: "attachments/receipt.jpg", filename: "receipt.jpg", isPdf: false });
		expect(result[0].dataUri).toMatch(/^data:image\/jpeg;base64,/);
	});

	it("reads a PDF attachment's raw bytes, not a data URI — the PDF export merges them as real pages", async () => {
		const app = new App();
		await app.vault.adapter.writeBinary("attachments/invoice.pdf", new Uint8Array([1, 2, 3]).buffer);
		const result = await collectReportAttachments(app, [tx("t1", { attachmentPath: "attachments/invoice.pdf" })]);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ txId: "t1", path: "attachments/invoice.pdf", filename: "invoice.pdf", isPdf: true });
		expect(result[0].bytes).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("skips transactions with no attachment", async () => {
		const app = new App();
		const result = await collectReportAttachments(app, [tx("t1")]);
		expect(result).toEqual([]);
	});

	it("skips an attachment that can no longer be read, rather than failing the whole export", async () => {
		const app = new App();
		const result = await collectReportAttachments(app, [tx("t1", { attachmentPath: "attachments/missing.jpg" })]);
		expect(result).toEqual([]);
	});
});
