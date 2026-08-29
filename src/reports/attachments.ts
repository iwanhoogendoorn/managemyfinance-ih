import type { App } from "obsidian";
import { readAttachmentBytes, readAttachmentDataUri } from "../data/attachments";
import type { Transaction } from "../types";

/**
 * "Where available, append the receipt" — a report that already lists a transaction with an attached
 * receipt or invoice can carry that document along, instead of being just a list of numbers someone
 * has to go trust separately.
 *
 * An image attachment (jpg/png/etc.) is read once here and comes back as a `data:` URI, ready to
 * embed directly in the HTML a PDF export is built from. A PDF attachment is read as raw bytes
 * instead — the PDF export merges its actual pages onto the end of the report (see
 * `src/reports/pdf.ts`'s `mergeAttachmentPdfs`), which is what "append the document" means for a
 * format that already is one. The Markdown export links either kind with Obsidian's own embed
 * syntax, which renders both inline, since that file never leaves the vault.
 */
export interface ReportAttachment {
	txId: string;
	/** Vault-relative. */
	path: string;
	filename: string;
	isPdf: boolean;
	/** Set only when `isPdf` is false and the file was actually read successfully. */
	dataUri?: string;
	/** Set only when `isPdf` is true and the file was actually read successfully. */
	bytes?: Uint8Array;
}

function filenameOf(path: string): string {
	return path.split("/").pop() ?? path;
}

function extensionOf(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

/**
 * Every attachment behind the given transactions, read once up front for an export rather than once
 * per format it's about to feed. A transaction with no attachment, or one that can no longer be read
 * (moved or deleted since it was linked), is simply absent from the result — never a reason to fail
 * the export over one missing receipt.
 */
export async function collectReportAttachments(app: App, transactions: Transaction[]): Promise<ReportAttachment[]> {
	const out: ReportAttachment[] = [];
	for (const tx of transactions) {
		if (!tx.attachmentPath) continue;
		const filename = filenameOf(tx.attachmentPath);
		const isPdf = extensionOf(tx.attachmentPath) === "pdf";
		if (isPdf) {
			const bytes = await readAttachmentBytes(app, tx.attachmentPath);
			if (!bytes) continue;
			out.push({ txId: tx.id, path: tx.attachmentPath, filename, isPdf: true, bytes });
		} else {
			const dataUri = await readAttachmentDataUri(app, tx.attachmentPath);
			if (!dataUri) continue;
			out.push({ txId: tx.id, path: tx.attachmentPath, filename, isPdf: false, dataUri });
		}
	}
	return out;
}
