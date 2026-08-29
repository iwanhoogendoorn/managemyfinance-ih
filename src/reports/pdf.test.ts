import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { mergeAttachmentPdfs } from "./pdf";

async function pdfWithPages(count: number): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	for (let i = 0; i < count; i++) doc.addPage([200, 200]);
	return doc.save();
}

describe("mergeAttachmentPdfs", () => {
	it("returns the report unchanged when there are no attachments", async () => {
		const report = await pdfWithPages(2);
		const merged = await mergeAttachmentPdfs(report, []);
		expect(merged).toBe(report);
	});

	it("appends each attachment's own pages after the report's own pages, in order", async () => {
		const report = await pdfWithPages(2);
		const receiptA = await pdfWithPages(1);
		const receiptB = await pdfWithPages(3);

		const merged = await mergeAttachmentPdfs(report, [receiptA, receiptB]);
		const doc = await PDFDocument.load(merged);
		expect(doc.getPageCount()).toBe(2 + 1 + 3);
	});

	it("skips a corrupt attachment rather than failing the whole export", async () => {
		const report = await pdfWithPages(2);
		const goodReceipt = await pdfWithPages(1);
		const corrupt = new Uint8Array([1, 2, 3, 4]);

		const merged = await mergeAttachmentPdfs(report, [corrupt, goodReceipt]);
		const doc = await PDFDocument.load(merged);
		expect(doc.getPageCount()).toBe(2 + 1);
	});
});
