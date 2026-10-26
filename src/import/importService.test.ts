import { describe, expect, it } from "vitest";
import { App } from "obsidian";
import { DEFAULT_SETTINGS, FinanceStore } from "../store";
import type { Account } from "../types";
import { canonicalColumnMapping } from "./canonical";
import {
	categorizeImport,
	countDuplicates,
	fileIbans,
	ImportError,
	parseImportTables,
	readImportFile,
	readTextImport,
	runImport,
	type ImportRequest,
} from "./importService";

/**
 * The import pipeline the wizard and POST /import share. Synthetic files only — the IBANs are the
 * same made-up ones the parser tests use, and no row here ever came from a real statement.
 */

const IBAN = "NL12INGB0001234567";

const QIF = `!Type:Bank
D15/03/2024
T-42.50
PALBERT HEIJN
MGroceries week 11
^
D25/03/2024
T2500.00
PACME BV
^`;

const MT940 = `:20:STARTUMS
:25:${IBAN}EUR
:28C:00135/001
:60F:C240301EUR1500,00
:61:2403150315D42,50NTRFNONREF//BANKREF1
:86:/TRTP/SEPA OVERBOEKING/IBAN/NL99RABO0000000000/NAME/ALBERT HEIJN/REMI/Groceries week 11
:61:2403250325C2500,00NSALNONREF
:86:/TRTP/SEPA OVERBOEKING/NAME/ACME BV/REMI/Salary March
:62F:C240331EUR3957,50
-`;

/** A CSV no bank profile claims: its columns have to be mapped by hand. */
const ODD_CSV = `Booked,What,Value
2024-03-01,Coffee corner,-3.50
2024-03-01,Coffee corner,-3.50
2024-03-02,Bakery,-2.10`;

function bytes(text: string): ArrayBuffer {
	return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

async function newStore(accounts: Partial<Account>[] = [{ id: "acc-1", name: "Checking", type: "debit" }]): Promise<FinanceStore> {
	const store = new FinanceStore(new App() as never, { ...DEFAULT_SETTINGS, dataFolder: "TestFinance" });
	await store.load();
	store.accounts = accounts.map((a) => ({ currency: "EUR", ...a }) as Account);
	return store;
}

function request(overrides: Partial<ImportRequest> = {}): ImportRequest {
	return { fileName: "export.qif", data: bytes(QIF), accountId: "acc-1", ...overrides };
}

describe("readTextImport / readImportFile", () => {
	it("reads a statement file into one canonical table with the exact mapping", () => {
		const read = readTextImport("export.qif", QIF);
		expect(read.tables).toHaveLength(1);
		expect(read.tables[0].format).toBe("qif");
		expect(read.tables[0].rows).toHaveLength(2);
		expect(read.mapping).toEqual(canonicalColumnMapping());
	});

	it("keeps an unrecognized CSV, with a guessed mapping for the preview to start from", () => {
		const read = readTextImport("odd.csv", ODD_CSV);
		expect(read.tables[0].format).toBe("unknown");
		expect(read.tables[0].headers).toEqual(["Booked", "What", "Value"]);
		expect(read.tables[0].rows).toHaveLength(3);
		expect(read.mapping.amount).toBe("Value");
	});

	it("lets an explicit kind override content sniffing", () => {
		// QIF content read as CSV is a one-column table, not a statement.
		expect(readTextImport("export.qif", QIF, "csv").tables[0].format).toBe("unknown");
	});

	it("decodes bytes as UTF-8 and sniffs the content, extension aside", async () => {
		const read = await readImportFile("statement.txt", bytes(MT940));
		expect(read.tables[0].format).toBe("mt940");
	});

	it("refuses binary content instead of reading noise as columns", async () => {
		await expect(readImportFile("scan.pdf", new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x00, 0x01]).buffer)).rejects.toThrow(/not a text export/);
	});

	it("reads an .xlsx by name as a workbook — and says so when it isn't one", async () => {
		await expect(readImportFile("book.xlsx", bytes("not a zip"))).rejects.toThrow();
	});
});

describe("fileIbans", () => {
	it("lists the file's account identifiers and which of them are already yours", () => {
		const { tables } = readTextImport("s.sta", MT940);
		const accounts = [{ id: "acc-ing", name: "ING", type: "debit", currency: "EUR", iban: IBAN } as Account];
		const { ibans, accountByIban } = fileIbans(tables, accounts);
		expect(ibans).toEqual([IBAN]);
		expect(accountByIban.get(IBAN)).toBe("acc-ing");
		expect(fileIbans(tables, []).accountByIban.size).toBe(0);
	});
});

describe("parseImportTables", () => {
	it("keeps genuinely repeated rows apart with occurrence suffixes and counts them", () => {
		const read = readTextImport("odd.csv", ODD_CSV);
		const { transactions, repeatedRows } = parseImportTables(read.tables, {
			mapping: { ...read.mapping, date: "Booked", description: "What", amount: "Value" },
			ibanAccountId: "acc-1",
			accountByIban: new Map(),
			genericAccountId: "acc-generic",
			tradeRepublicAccountId: "acc-1",
			categories: [],
		});
		expect(transactions).toHaveLength(3);
		expect(repeatedRows).toBe(1);
		expect(transactions[1].id).toBe(`${transactions[0].id}~2`);
		expect(transactions.every((t) => t.accountId === "acc-generic" && t.source === "generic")).toBe(true);
	});
});

describe("categorizeImport", () => {
	it("files a merchant from memory before the rules get a say", async () => {
		const store = await newStore();
		const groceries = store.categories.find((c) => c.name === "Groceries")!;
		const salary = store.categories[0];
		// A past import filed ACME BV, so merchant memory should file the new row the same way.
		await store.importTransactions([
			{ id: "old-1", date: "2024-02-25", accountId: "acc-1", description: "ACME BV", amount: 2500, currency: "EUR", source: "qif", categoryId: salary.id },
		]);
		const { transactions } = parseImportTables(readTextImport("export.qif", QIF).tables, {
			mapping: canonicalColumnMapping(),
			ibanAccountId: "acc-1",
			accountByIban: new Map(),
			genericAccountId: "acc-1",
			tradeRepublicAccountId: "acc-1",
			categories: store.categories,
		});
		const counts = categorizeImport(store, transactions, { applyLowConfidence: true });
		expect(transactions.find((t) => t.description === "ACME BV")?.categoryId).toBe(salary.id);
		expect(counts.memoryHits).toBe(1);
		// Albert Heijn is one of the shipped merchant rules.
		expect(transactions.find((t) => t.description === "ALBERT HEIJN")?.categoryId).toBe(groceries.id);
		expect(counts.ruleHits).toBe(1);
	});

	/** A low-confidence AI answer for ACME BV, given earlier and never applied. */
	async function storeWithPendingSuggestion(): Promise<{ store: FinanceStore; categoryId: string }> {
		const store = await newStore();
		const categoryId = store.categories[0].id;
		store.merchants = {
			"acme bv": { key: "acme bv", source: "ai", at: "2024-03-01", suggestion: { categoryId, confidence: 0.4, model: "test", at: "2024-03-01" } },
		};
		return { store, categoryId };
	}

	function parsedQif(store: FinanceStore) {
		return parseImportTables(readTextImport("export.qif", QIF).tables, {
			mapping: canonicalColumnMapping(),
			ibanAccountId: "acc-1",
			accountByIban: new Map(),
			genericAccountId: "acc-1",
			tradeRepublicAccountId: "acc-1",
			categories: store.categories,
		}).transactions;
	}

	it("applies a pending suggestion and tells the caller merchant memory needs saving", async () => {
		const { store, categoryId } = await storeWithPendingSuggestion();
		const transactions = parsedQif(store);
		const counts = categorizeImport(store, transactions, { applyLowConfidence: true });
		expect(counts.merchantsChanged).toBe(true);
		expect(store.merchants["acme bv"].categoryId).toBe(categoryId);
		expect(transactions.find((t) => t.description === "ACME BV")?.categoryId).toBe(categoryId);
	});

	it("still uses a pending suggestion on a dry run, but leaves merchant memory alone", async () => {
		const { store, categoryId } = await storeWithPendingSuggestion();
		const before = store.merchants;
		const transactions = parsedQif(store);
		const counts = categorizeImport(store, transactions, { applyLowConfidence: true, dryRun: true });
		expect(counts.merchantsChanged).toBe(false);
		expect(store.merchants).toBe(before);
		expect(store.merchants["acme bv"].categoryId).toBeUndefined();
		expect(transactions.find((t) => t.description === "ACME BV")?.categoryId).toBe(categoryId);
	});

	it("ignores pending suggestions when low-confidence answers are switched off", async () => {
		const { store } = await storeWithPendingSuggestion();
		const transactions = parsedQif(store);
		const counts = categorizeImport(store, transactions, { applyLowConfidence: false });
		expect(counts.merchantsChanged).toBe(false);
		expect(transactions.find((t) => t.description === "ACME BV")?.categoryId).toBeUndefined();
	});
});

describe("runImport", () => {
	it("imports a file as one batch and skips every row on a re-import", async () => {
		const store = await newStore();
		const first = await runImport(store, request(), { applyLowConfidence: true });
		expect(first.added).toBe(2);
		expect(first.batchId).toBeDefined();
		expect(store.batches).toHaveLength(1);
		expect(store.batches[0]).toMatchObject({ id: first.batchId, fileName: "export.qif", format: "QIF", count: 2, source: "qif" });
		expect(store.transactionsInBatch(first.batchId!)).toHaveLength(2);

		const again = await runImport(store, request(), { applyLowConfidence: true });
		expect(again.added).toBe(0);
		expect(again.duplicates).toBe(2);
		expect(again.batchId).toBeUndefined();
		expect(countDuplicates(again.parsed, store.existingIds())).toBe(2);
		expect(store.transactions).toHaveLength(2);
	});

	it("writes nothing on a dry run but reports what would land", async () => {
		const store = await newStore();
		const revision = store.revision;
		const outcome = await runImport(store, request({ dryRun: true }), { applyLowConfidence: true });
		expect(outcome.incoming).toHaveLength(2);
		expect(outcome.added).toBe(0);
		expect(store.transactions).toHaveLength(0);
		expect(store.batches).toHaveLength(0);
		expect(store.revision).toBe(revision);
	});

	it("asks for a mapping when the format isn't recognized, and takes one", async () => {
		const store = await newStore();
		const odd = request({ fileName: "odd.csv", data: bytes(ODD_CSV) });
		await expect(runImport(store, { ...odd, mapping: { date: null } }, { applyLowConfidence: true })).rejects.toThrow(/Unrecognized format/);
		await expect(runImport(store, { ...odd, mapping: { date: "Nope" } }, { applyLowConfidence: true })).rejects.toThrow(/no column "Nope"/);
		await expect(runImport(store, { ...odd, mapping: { toString: "x" } as never }, { applyLowConfidence: true })).rejects.toThrow(
			/Unknown mapping field/
		);

		const outcome = await runImport(store, { ...odd, mapping: { date: "Booked", description: "What", amount: "Value" } }, { applyLowConfidence: true });
		expect(outcome.added).toBe(3);
		expect(outcome.repeatedRows).toBe(1);
		expect(store.transactions.every((t) => t.accountId === "acc-1")).toBe(true);
	});

	it("files rows under the account their IBAN belongs to, and refuses a contradiction", async () => {
		const store = await newStore([
			{ id: "acc-1", name: "Savings", type: "saving" },
			{ id: "acc-ing", name: "ING", type: "debit", iban: IBAN },
		]);
		const sta = request({ fileName: "s.sta", data: bytes(MT940) });
		const err = await runImport(store, sta, { applyLowConfidence: true }).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(ImportError);
		expect((err as Error).message).toMatch(/acc-ing/);

		const outcome = await runImport(store, { ...sta, accountId: "acc-ing" }, { applyLowConfidence: true });
		expect(outcome.added).toBe(2);
		expect(store.transactions.every((t) => t.accountId === "acc-ing" && t.source === "mt940")).toBe(true);
	});

	it("lands an IBAN no account claims in the account asked for", async () => {
		const store = await newStore();
		const outcome = await runImport(store, request({ fileName: "s.sta", data: bytes(MT940) }), { applyLowConfidence: true });
		expect(outcome.added).toBe(2);
		expect(store.transactions.every((t) => t.accountId === "acc-1")).toBe(true);
	});

	it("refuses a file it can't read, or one with no rows", async () => {
		const store = await newStore();
		await expect(runImport(store, request({ data: bytes(QIF), format: "camt053" }), { applyLowConfidence: true })).rejects.toBeInstanceOf(ImportError);
		await expect(runImport(store, request({ fileName: "e.csv", data: bytes("Date,Description,Amount\n") }), { applyLowConfidence: true })).rejects.toThrow(
			/No transactions/
		);
	});
});
