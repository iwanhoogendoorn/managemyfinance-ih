import { parseCSV } from "../csv";
import type { FinanceStore } from "../store";
import type { Account, Category, Transaction, TransactionSource } from "../types";
import { autoCategorize, effectiveRules } from "./autoCategorize";
import { matchBankProfile } from "./bankProfiles";
import { parseCamt053 } from "./camt053";
import { buildAliasLookup } from "./categorize";
import { canonicalColumnMapping } from "./canonical";
import { applyColumnMapping, COLUMN_MAPPING_FIELDS, guessColumnMapping, type ColumnMapping } from "./columnMapping";
import { countRepeatedIds, withOccurrenceSuffixes } from "./dedupe";
import { detectFileFormat, detectFormat, IBAN_BEARING_FORMATS, type DetectedFileFormat, type DetectedFormat } from "./detect";
import { ingAccountIbans, parseIngRows } from "./ingParser";
import { applyMemory, applyPendingSuggestions, learnFromHistory } from "./merchantMemory";
import { parseMt940 } from "./mt940";
import { parseOfx } from "./ofx";
import { parseQif } from "./qif";
import { parseTradeRepublicRows } from "./tradeRepublicParser";
import { extractTransactionTables, type DetectedTable } from "./xlsxWorkbook";

/**
 * The import pipeline — read a file, map its columns, parse, de-duplicate, categorize, write one batch —
 * with no DOM, no Notice and no modal in it.
 *
 * It used to live inside the ImportWizard closure, interleaved with the rendering of each step, which
 * meant the only way to import a file was to click through four screens. The local API needs the same
 * pipeline from a request body, and two copies of "how a file becomes ledger rows" would drift the
 * first time a bank changed its export. So the steps live here, each one a plain function over plain
 * values, and both callers use them: the wizard keeps its own state between screens and calls one step
 * per screen; `runImport` at the bottom calls them back to back for a request that names its account
 * up front. Nothing here changes what a step does — the wizard's results are exactly what they were.
 */

export const FORMAT_LABEL: Record<DetectedFormat, string> = {
	ing: "ING bank",
	"trade-republic": "Trade Republic",
	revolut: "Revolut",
	bunq: "bunq",
	n26: "N26",
	knab: "KNAB",
	camt: "CAMT.053 statement",
	mt940: "MT940 statement",
	ofx: "OFX / QFX",
	qif: "QIF",
	unknown: "Unrecognized",
};

/** Every file kind `detectFileFormat` can return — what an explicit `format` may name. */
export const FILE_FORMATS: DetectedFileFormat[] = ["camt053", "mt940", "ofx", "qif", "xlsx", "csv"];

/** A detected format is also the transaction's source, except for the formats that share the flat
 *  generic reader without being a named bank ("unknown" is a file whose columns you mapped by hand). */
export function sourceFor(format: DetectedFormat): TransactionSource {
	return format === "unknown" ? "generic" : (format as TransactionSource);
}

/** A file read as far as tables, plus the column mapping the preview starts from. */
export interface ImportTables {
	tables: DetectedTable[];
	mapping: ColumnMapping;
}

/** The mapping grid is shown (and used) for any table whose columns fit the flat ledger shape —
 *  every format except Trade Republic, whose action/ticker/shares/price/fee/tax columns don't. Guessed
 *  from the first such table so a multi-sheet export shares one mapping, same as the parsing step does. */
export function mappableHeaders(tables: DetectedTable[]): string[] {
	return tables.find((t) => t.format !== "trade-republic")?.headers ?? [];
}

/** Formats with no per-row account identifier: they can only be told which account they belong to. */
export function tablesNeedingGenericAccount(tables: DetectedTable[]): DetectedTable[] {
	return tables.filter((t) => t.format !== "trade-republic" && !IBAN_BEARING_FORMATS.includes(t.format));
}

/**
 * Reads any text file: a statement format (CAMT.053, MT940, OFX, QIF) is converted into the same
 * table shape a CSV produces, so from here on every format shares one preview, one column-mapping
 * step and one parser. That's deliberate — a statement format that bypassed the field selector
 * would be the one kind of file you couldn't correct when a bank changed something.
 *
 * Throws when the file can't be read. `kind` overrides content sniffing, for a caller that knows
 * better than the sniffer; left out, the content decides, exactly as it does for a dropped file.
 */
export function readTextImport(name: string, text: string, kind: DetectedFileFormat = detectFileFormat(text, name)): ImportTables {
	// "xlsx" is binary and read by readXlsxImport — text that claims to be one has already been mangled.
	if (kind === "xlsx") throw new Error("An Excel workbook can't be read as text");
	if (kind !== "csv") {
		const table =
			kind === "camt053" ? parseCamt053(text) : kind === "mt940" ? parseMt940(text) : kind === "ofx" ? parseOfx(text) : parseQif(text);
		const format: DetectedFormat = kind === "camt053" ? "camt" : kind;
		// Set exactly, not guessed: these are our own headers. See canonicalColumnMapping.
		return { tables: [{ sheetName: name, format, headers: table.headers, rows: table.rows }], mapping: canonicalColumnMapping() };
	}

	const rows = parseCSV(text);
	const headers = rows[0] ?? [];
	const dataRows = rows.slice(1);
	const format = detectFormat(headers);
	// Unlike xlsx (which just skips unrecognized sheets — a workbook has plenty of other sheets to
	// fall back on), a single unrecognized CSV is kept so the mapping step has something to map.
	const tables: DetectedTable[] = [{ sheetName: name, format, headers, rows: dataRows }];

	// A recognized bank profile pre-fills the mapping with that bank's real columns instead of
	// the generic name-similarity guess. Still shown, still editable.
	const profile = matchBankProfile(headers);
	return { tables, mapping: profile ? profile.mapping(headers) : guessColumnMapping(mappableHeaders(tables)) };
}

export async function readXlsxImport(data: ArrayBuffer): Promise<ImportTables> {
	const tables = await extractTransactionTables(data);
	// The same profile lookup the CSV path does. Without it a bank's workbook fell back to the
	// generic name-similarity guess, which is close enough to look right and wrong where it
	// matters: KNAB's "Tegenrekening" (the payee's account number) was guessed as the
	// counterparty over "Tegenpartij" (their name), and the Af/Bij column went unmapped
	// entirely, so every amount would have imported as money coming in.
	const headers = mappableHeaders(tables);
	const profile = matchBankProfile(headers);
	return { tables, mapping: profile ? profile.mapping(headers) : guessColumnMapping(headers) };
}

/**
 * Raw bytes to tables, for a caller that has bytes rather than a browser File. An .xlsx (by name, or
 * by `kind`) is read as a workbook; anything else is decoded as UTF-8 — what `File.text()` does for
 * the wizard — and read as text. Throws when the file can't be read.
 */
export async function readImportFile(name: string, data: ArrayBuffer, kind?: DetectedFileFormat): Promise<ImportTables> {
	if ((kind ?? detectFileFormat("", name)) === "xlsx") return readXlsxImport(data);
	const text = new TextDecoder("utf-8").decode(data);
	// A NUL never appears in a text export; one that has them is a PDF, an image, or an encoding the
	// wizard couldn't read either. Saying so beats a "couldn't find any columns" about binary noise.
	if (text.includes("\u0000")) throw new Error("This is not a text export (CSV, CAMT.053, MT940, OFX, QIF) or an .xlsx workbook");
	return readTextImport(name, text, kind);
}

/**
 * The account identifiers a file carries, and which of them already belong to one of your accounts.
 * Any format that carries an identifier per row can be split across your accounts, not just ING — a
 * CAMT or MT940 file covering two accounts is exactly the same problem.
 */
export function fileIbans(tables: DetectedTable[], accounts: Account[]): { ibans: string[]; accountByIban: Map<string, string> } {
	const ibanTables = tables.filter((t) => IBAN_BEARING_FORMATS.includes(t.format));
	const ibans = Array.from(new Set(ibanTables.flatMap((t) => ingAccountIbans(t.headers, t.rows))));
	const accountByIban = new Map(
		ibans.filter((iban) => accounts.some((a) => a.iban === iban)).map((iban) => [iban, accounts.find((a) => a.iban === iban)!.id])
	);
	return { ibans, accountByIban };
}

export interface ParseImportOptions {
	mapping: ColumnMapping;
	/** Where an IBAN-bearing format's rows land when their IBAN isn't in `accountByIban`. */
	ibanAccountId: string;
	accountByIban: Map<string, string>;
	/** Where every format without a per-row account identifier lands. */
	genericAccountId: string;
	tradeRepublicAccountId: string;
	categories: Category[];
}

export interface ParsedImport {
	transactions: Transaction[];
	/** How many parsed rows needed an occurrence suffix to stay distinct — reported before importing. */
	repeatedRows: number;
}

export function parseImportTables(tables: DetectedTable[], opts: ParseImportOptions): ParsedImport {
	const categoryLookup = buildAliasLookup(opts.categories);
	const parsed: Transaction[] = [];
	for (const t of tables) {
		if (t.format === "trade-republic") {
			parsed.push(...parseTradeRepublicRows(t.headers, t.rows, opts.tradeRepublicAccountId));
			continue;
		}
		// Every other format — recognized bank CSV, statement file, or a table you mapped by
		// hand — is a flat ledger table by this point, so they all read through one parser with
		// the mapping applied. The only difference between them is which account the rows land
		// in and what source they're filed under.
		const carriesIban = IBAN_BEARING_FORMATS.includes(t.format);
		const mappedHeaders = applyColumnMapping(t.headers, opts.mapping);
		parsed.push(
			...parseIngRows(mappedHeaders, t.rows, {
				defaultAccountId: carriesIban ? opts.ibanAccountId : opts.genericAccountId,
				accountByIban: carriesIban ? opts.accountByIban : undefined,
				categoryLookup,
				debitValues: opts.mapping.debitCredit && opts.mapping.debitValue ? [opts.mapping.debitValue] : undefined,
				source: sourceFor(t.format),
			})
		);
	}

	// Two genuinely separate payments that agree on account, date, amount and description hash
	// to one id; without this the second one is mistaken for a duplicate of the first and never
	// arrives. See src/import/dedupe.ts for why the suffix is still re-import safe.
	return { repeatedRows: countRepeatedIds(parsed), transactions: withOccurrenceSuffixes(parsed) };
}

export interface ImportCategorization {
	/** Rows the export categorized itself, via its own category columns. */
	fileHits: number;
	memoryHits: number;
	ruleHits: number;
	/**
	 * Answers already given but never written were just applied to `store.merchants` — the caller saves
	 * merchant memory. Left to the caller so the wizard can keep saving in the background while the API
	 * waits for the write before it answers. Always false on a dry run, which never touches the store.
	 */
	merchantsChanged: boolean;
}

/**
 * Fills in categories on freshly parsed rows, in place: the file's own category column (already
 * applied by the parser), then merchant memory, then the rules. `applyLowConfidence` is the AI
 * setting of the same name; `dryRun` reads the store without changing anything in it.
 */
export function categorizeImport(
	store: FinanceStore,
	parsed: Transaction[],
	opts: { applyLowConfidence: boolean; dryRun?: boolean }
): ImportCategorization {
	// Counted before anything else runs, since the parser has already applied them.
	const fileHits = parsed.filter((tx) => tx.categoryId).length;

	// Merchant memory first: a shop you have already filed once is settled, and nothing a rule
	// or a model says should override a decision you made yourself.
	let learned = learnFromHistory(store.transactions, store.merchants);
	let merchantsChanged = false;
	// Apply answers already given but never written — see applyPendingSuggestions().
	if (opts.applyLowConfidence) {
		const pending = applyPendingSuggestions(learned);
		learned = pending.map;
		if (!opts.dryRun) {
			store.merchants = pending.map;
			merchantsChanged = pending.keys.size > 0;
		}
	}
	const fromMemory = applyMemory(parsed, learned, store.categories);
	for (const tx of parsed) {
		const categoryId = fromMemory.patches.get(tx.id);
		if (categoryId) tx.categoryId = categoryId;
	}

	// Then the shipped merchant rules and the user's own, plus the bank's own type column
	// for the unambiguous cases (ATM withdrawals, interest) — see autoCategorize().
	const rules = effectiveRules(store.categories, store.rules);
	const { patches } = autoCategorize(parsed, store.categories, rules);
	for (const tx of parsed) {
		const categoryId = patches.get(tx.id);
		if (categoryId) tx.categoryId = categoryId;
	}
	return { fileHits, memoryHits: fromMemory.patches.size, ruleHits: patches.size, merchantsChanged };
}

/** Parsed rows whose id is already in the ledger — the ones importTransactions will skip. */
export function countDuplicates(parsed: Transaction[], existing: Set<string>): number {
	return parsed.filter((t) => existing.has(t.id)).length;
}

/** The batch's format label: what Settings → Import history shows for a run with no file name. */
export function batchFormatLabel(tables: DetectedTable[]): string | undefined {
	return tables[0] ? FORMAT_LABEL[tables[0].format] : undefined;
}

// ---------------------------------------------------------------------------

/**
 * Something about the request or the file means it can't be imported as asked — a file nobody can
 * read, a mapping naming a column that isn't there, an account identifier that contradicts the
 * account asked for. Always the caller's to fix, never a bug; the API answers it as a 400.
 */
export class ImportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ImportError";
	}
}

export interface ImportRequest {
	fileName: string;
	data: ArrayBuffer;
	/** The account every row without an identifier of its own lands in. Must exist — checked by the caller. */
	accountId: string;
	/** Overrides content sniffing. */
	format?: DetectedFileFormat;
	/** Laid over the suggested mapping: a field set to a column name replaces it, `null` clears it. */
	mapping?: Partial<Record<keyof ColumnMapping, string | null>>;
	/** Run every step, write nothing. */
	dryRun?: boolean;
}

export interface ImportOutcome {
	fileName: string;
	/** What the batch is recorded as — FORMAT_LABEL of the first table. */
	format: string | undefined;
	formats: DetectedFormat[];
	mapping: ColumnMapping;
	parsed: Transaction[];
	repeatedRows: number;
	/** Parsed rows already in the ledger. */
	duplicates: number;
	/** The rows that are (or, on a dry run, would be) new. */
	incoming: Transaction[];
	categorization: ImportCategorization;
	/** Only when something was written: the batch it was recorded as, and what importTransactions reported. */
	batchId?: string;
	added: number;
	skipped: number;
}

/**
 * The whole pipeline in one call, for a caller that knows the account up front and has no screens to
 * step through: the same reading, mapping, parsing, de-duplication and categorization the wizard does,
 * then one importTransactions call that records the batch. The wizard's decisions are made here from
 * the request instead of from dropdowns, and where the wizard would hold the Next button, this throws
 * an ImportError saying why.
 *
 * Account identifiers in the file win, as they do in the wizard: a row whose IBAN is on one of your
 * accounts lands there. The one difference is a file naming a single account you have that isn't the
 * one asked for — the wizard would show you that and let you choose; with nobody to show it to, the
 * contradiction is refused rather than quietly settled either way.
 *
 * No AI here: the wizard's "Ask Claude" is a separate, opt-in network call, and an import request
 * shouldn't send merchant names anywhere as a side effect. Rows nothing recognized land uncategorized,
 * in the Review queue, exactly as a wizard import whose AI step was skipped.
 */
export async function runImport(
	store: FinanceStore,
	req: ImportRequest,
	opts: { applyLowConfidence: boolean }
): Promise<ImportOutcome> {
	let read: ImportTables;
	try {
		read = await readImportFile(req.fileName, req.data, req.format);
	} catch (err) {
		throw new ImportError(`Couldn't read "${req.fileName}": ${err instanceof Error ? err.message : String(err)}`);
	}
	const { tables } = read;
	if (tables.length === 0) throw new ImportError("Couldn't find any data in this file");

	const mapping: ColumnMapping = { ...read.mapping };
	const headers = mappableHeaders(tables);
	for (const [key, value] of Object.entries(req.mapping ?? {})) {
		const field = key as keyof ColumnMapping;
		if (!Object.prototype.hasOwnProperty.call(mapping, field)) throw new ImportError(`Unknown mapping field "${key}"`);
		if (value === null || value === "") {
			mapping[field] = "";
			continue;
		}
		if (typeof value !== "string") throw new ImportError(`mapping.${key} must be a column name or null`);
		// debitValue is a cell value ("Debit", "DR"), not a column name.
		if (field !== "debitValue" && !headers.includes(value)) {
			throw new ImportError(`mapping.${key}: this file has no column "${value}"`);
		}
		mapping[field] = value;
	}
	const missing = COLUMN_MAPPING_FIELDS.filter((f) => f.required && !mapping[f.key]);
	if (headers.length > 0 && missing.length > 0) {
		const fields = missing.map((f) => f.key).join(", ");
		const columns = headers.map((h) => `"${h}"`).join(", ");
		throw new ImportError(
			tables.some((t) => t.format === "unknown")
				? `Unrecognized format — pass a mapping for ${fields} (this file's columns: ${columns})`
				: `Map ${fields} first`
		);
	}

	const { ibans, accountByIban } = fileIbans(tables, store.accounts);
	if (ibans.length > 1) {
		const unknown = ibans.filter((i) => !accountByIban.has(i));
		if (unknown.length > 0) {
			throw new ImportError(
				`This file covers ${ibans.length} accounts, and ${unknown.join(", ")} isn't on any of yours — add the IBAN to an account first`
			);
		}
	} else if (ibans.length === 1) {
		const owner = accountByIban.get(ibans[0]);
		if (owner && owner !== req.accountId) {
			throw new ImportError(`This file is for ${ibans[0]}, which is account "${owner}", not "${req.accountId}"`);
		}
	}

	const { transactions: parsed, repeatedRows } = parseImportTables(tables, {
		mapping,
		ibanAccountId: req.accountId,
		accountByIban,
		genericAccountId: req.accountId,
		tradeRepublicAccountId: req.accountId,
		categories: store.categories,
	});
	if (parsed.length === 0) throw new ImportError("No transactions found in this file");

	const categorization = categorizeImport(store, parsed, { applyLowConfidence: opts.applyLowConfidence, dryRun: req.dryRun });
	const existing = store.existingIds();
	const incoming = parsed.filter((t) => !existing.has(t.id));
	const outcome: ImportOutcome = {
		fileName: req.fileName,
		format: batchFormatLabel(tables),
		formats: Array.from(new Set(tables.map((t) => t.format))),
		mapping,
		parsed,
		repeatedRows,
		duplicates: parsed.length - incoming.length,
		incoming,
		categorization,
		added: 0,
		skipped: 0,
	};
	if (req.dryRun) return outcome;

	if (categorization.merchantsChanged) await store.saveMerchants();
	const result = await store.importTransactions(parsed, { fileName: req.fileName, format: outcome.format });
	return { ...outcome, batchId: result.batchId, added: result.added, skipped: result.skipped };
}
