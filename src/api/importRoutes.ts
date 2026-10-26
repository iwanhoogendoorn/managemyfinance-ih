import { FILE_FORMATS, ImportError, runImport, type ImportRequest } from "../import/importService";
import type { DetectedFileFormat } from "../import/detect";
import type { FinanceStore } from "../store";
import type { ImportBatch } from "../types";
import { HttpError, reply, type RequestContext, type Router } from "./router";

/**
 * Importing a bank export, and the history of imports — the API side of the import wizard and of
 * Settings → Import history.
 *
 * POST /import
 *   Body (JSON — the only body format the API reads, so a file travels base64-encoded in it):
 *     {
 *       "fileName": "ing-2024.csv",          required; its extension is how an .xlsx is recognized
 *       "contentBase64": "RGF0dW0sTmFh...",  required; the file's bytes. Text formats are read as UTF-8
 *       "accountId": "acc-checking",         required; where rows without an account identifier land
 *       "format": "csv",                     optional; camt053 | mt940 | ofx | qif | xlsx | csv. Left
 *                                            out, the content decides, exactly as for a dropped file
 *       "mapping": { "date": "Booked" },     optional; laid over the suggested column mapping, null clears
 *       "dryRun": true                       optional; run every step, write nothing, return a preview
 *     }
 *   → 201 { batchId, imported, duplicates, uncategorised, written, ... } when rows were written;
 *     200 with `batchId: null` when every row was already in the ledger, and for a dry run (where
 *     `imported` is what would be imported, `preview` lists those rows and `written` is []).
 *   400 for anything about the file or the request (unreadable, unsupported format, a mapping that
 *   doesn't fit, an IBAN on a different account), 404 for an unknown account.
 *
 *   Size: the request body limit is the API's usual 1 MB, which base64 makes roughly 750 KB of file — a
 *   few years of a busy current account as CSV, comfortably more as a statement file. It is not raised
 *   for this route: the limit is enforced while the body streams in, before any route is known to the
 *   reader, and a bigger export can be split by date range and sent as two imports. Duplicates make
 *   overlapping ranges harmless. Past the limit the answer is a 413.
 *
 * GET /imports                     every import run, newest first, with how many of its rows remain
 * GET /imports/:batchId            one run, with the rows it brought in that are still in the ledger
 * POST /imports/:batchId/undo      deletes every row the run created and forgets it — Settings →
 *                                  Import history's "Undo import", including rows edited since
 *
 * `written` is the vault-relative paths a call wrote or removed — the ledger files and the import
 * history — so a client can re-read exactly those. Row counts are their own fields: `imported` and
 * `duplicates` on an import, `removed` on an undo.
 */
export function register(router: Router): void {
	router.post("/import", importFile);
	router.get("/imports", (ctx) => {
		const store = ctx.store();
		const batches = [...store.batches].sort((a, b) => b.importedAt.localeCompare(a.importedAt));
		return { imports: batches.map((b) => batchView(store, b)) };
	});
	router.get("/imports/:batchId", (ctx) => {
		const store = ctx.store();
		const batch = findBatch(store, ctx.params.batchId);
		return { ...batchView(store, batch), transactions: store.transactionsInBatch(batch.id) };
	});
	router.post("/imports/:batchId/undo", async (ctx) => {
		const store = ctx.store();
		const batch = findBatch(store, ctx.params.batchId);
		const removed = await store.undoImportBatch(batch.id);
		ctx.refresh();
		return { batchId: batch.id, removed, written: ctx.written() };
	});
}

function batchView(store: FinanceStore, batch: ImportBatch): ImportBatch & { remaining: number } {
	return { ...batch, remaining: store.transactionsInBatch(batch.id).length };
}

function findBatch(store: FinanceStore, batchId: string): ImportBatch {
	const batch = store.batches.find((b) => b.id === batchId);
	if (!batch) throw new HttpError(404, `No import "${batchId}"`);
	return batch;
}

function decodeBase64(value: string): ArrayBuffer {
	const clean = value.replace(/\s+/g, "");
	// atob is lenient about some malformed input and strict about other; checking the alphabet first
	// means a body that isn't base64 at all is told so, rather than imported as whatever it decodes to.
	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) throw new HttpError(400, "contentBase64 is not valid base64");
	let binary: string;
	try {
		binary = atob(clean);
	} catch {
		throw new HttpError(400, "contentBase64 is not valid base64");
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

/** The request body as an ImportRequest, or a 400 naming the first thing wrong with it. */
function readRequest(body: unknown): ImportRequest {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new HttpError(400, "Expected a JSON object: {fileName, contentBase64, accountId}");
	}
	const b = body as Record<string, unknown>;
	if (typeof b.fileName !== "string" || b.fileName.trim() === "") throw new HttpError(400, "fileName is required");
	if (typeof b.contentBase64 !== "string") throw new HttpError(400, "contentBase64 is required");
	if (typeof b.accountId !== "string" || b.accountId === "") throw new HttpError(400, "accountId is required");
	if (b.format !== undefined && b.format !== null && !FILE_FORMATS.includes(b.format as DetectedFileFormat)) {
		throw new HttpError(400, `Unsupported format ${JSON.stringify(b.format)} — expected one of ${FILE_FORMATS.join(", ")}`);
	}
	if (b.mapping !== undefined && b.mapping !== null && (typeof b.mapping !== "object" || Array.isArray(b.mapping))) {
		throw new HttpError(400, "mapping must be an object of field → column name");
	}
	if (b.dryRun !== undefined && typeof b.dryRun !== "boolean") throw new HttpError(400, "dryRun must be true or false");

	const data = decodeBase64(b.contentBase64);
	if (data.byteLength === 0) throw new HttpError(400, "The file is empty");
	return {
		fileName: b.fileName.trim(),
		data,
		accountId: b.accountId,
		format: (b.format ?? undefined) as DetectedFileFormat | undefined,
		mapping: (b.mapping ?? undefined) as ImportRequest["mapping"],
		dryRun: b.dryRun === true,
	};
}

async function importFile(ctx: RequestContext): Promise<unknown> {
	const req = readRequest(ctx.body);
	const store = ctx.store();
	if (!store.accounts.some((a) => a.id === req.accountId)) throw new HttpError(404, `No account "${req.accountId}"`);

	let outcome;
	try {
		outcome = await runImport(store, req, { applyLowConfidence: ctx.plugin.settings.ai?.applyLowConfidence !== false });
	} catch (err) {
		if (err instanceof ImportError) throw new HttpError(400, err.message);
		throw err;
	}

	const summary = {
		dryRun: !!req.dryRun,
		fileName: outcome.fileName,
		format: outcome.format ?? null,
		formats: outcome.formats,
		mapping: outcome.mapping,
		parsed: outcome.parsed.length,
		repeated: outcome.repeatedRows,
		categorised: {
			file: outcome.categorization.fileHits,
			memory: outcome.categorization.memoryHits,
			rules: outcome.categorization.ruleHits,
		},
		uncategorised: outcome.incoming.filter((t) => !t.categoryId).length,
	};
	if (req.dryRun) {
		return {
			...summary,
			batchId: null,
			imported: outcome.incoming.length,
			duplicates: outcome.duplicates,
			written: ctx.written(),
			preview: outcome.incoming,
		};
	}

	const body = { ...summary, batchId: outcome.batchId ?? null, imported: outcome.added, duplicates: outcome.skipped, written: ctx.written() };
	if (!outcome.batchId) return body;
	ctx.refresh();
	return reply(201, body);
}
