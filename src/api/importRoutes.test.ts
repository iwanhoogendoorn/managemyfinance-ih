import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Account, ImportBatch, Transaction } from "../types";
import { makeTestPlugin, send, type TestPlugin } from "./testPlugin";

/**
 * POST /import and the import history, end to end through the real pipeline — auth, body parsing,
 * the refresh after a write — over a real store on the in-memory vault. Every file is synthetic.
 */

const IBAN = "NL12INGB0001234567";

const CAMT = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.02">
 <BkToCstmrStmt>
  <Stmt>
   <Acct><Id><IBAN>${IBAN}</IBAN></Id><Ccy>EUR</Ccy></Acct>
   <Ntry>
    <Amt Ccy="EUR">42.50</Amt>
    <CdtDbtInd>DBIT</CdtDbtInd>
    <BookgDt><Dt>2024-03-15</Dt></BookgDt>
    <NtryDtls><TxDtls>
      <RltdPties><Cdtr><Nm>Albert Heijn</Nm></Cdtr></RltdPties>
      <RmtInf><Ustrd>Groceries week 11</Ustrd></RmtInf>
    </TxDtls></NtryDtls>
   </Ntry>
   <Ntry>
    <Amt Ccy="EUR">2500.00</Amt>
    <CdtDbtInd>CRDT</CdtDbtInd>
    <BookgDt><Dt>2024-03-25</Dt></BookgDt>
    <NtryDtls><TxDtls>
      <RltdPties><Dbtr><Nm>ACME BV</Nm></Dbtr></RltdPties>
      <RmtInf><Ustrd>Salary March</Ustrd></RmtInf>
    </TxDtls></NtryDtls>
   </Ntry>
  </Stmt>
 </BkToCstmrStmt>
</Document>`;

const MT940 = `:20:STARTUMS
:25:${IBAN}EUR
:28C:00135/001
:60F:C240301EUR1500,00
:61:2403150315D42,50NTRFNONREF//BANKREF1
:86:/TRTP/SEPA OVERBOEKING/NAME/ALBERT HEIJN/REMI/Groceries week 11
:61:2403250325C2500,00NSALNONREF
:86:/TRTP/SEPA OVERBOEKING/NAME/ACME BV/REMI/Salary March
:62F:C240331EUR3957,50
-`;

const OFX = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>EUR
<BANKACCTFROM><ACCTID>${IBAN}</ACCTID></BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240315120000[0:GMT]
<TRNAMT>-42.50
<FITID>abc123
<NAME>ALBERT HEIJN
<MEMO>Groceries week 11
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240325
<TRNAMT>2500.00
<NAME>ACME BV
</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

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

/** Revolut's export, recognized by its bank profile. */
const REVOLUT = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2024-03-15 10:00:00,2024-03-15 10:01:00,Albert Heijn,-42.50,0.00,EUR,COMPLETED,957.50
TOPUP,Current,2024-03-25 09:00:00,2024-03-25 09:00:00,Top-up by card,2500.00,0.00,EUR,COMPLETED,3457.50`;

function b64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

async function setup(accounts: Partial<Account>[] = [{ id: "acc-1", name: "Checking", type: "debit" }]): Promise<TestPlugin> {
	const t = makeTestPlugin();
	await t.store.load();
	t.store.accounts = accounts.map((a) => ({ currency: "EUR", ...a }) as Account);
	return t;
}

function importBody(fileName: string, text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return { fileName, contentBase64: b64(text), accountId: "acc-1", ...extra };
}

interface ImportResponse {
	batchId: string | null;
	imported: number;
	duplicates: number;
	uncategorised: number;
	written: number;
	parsed: number;
	dryRun: boolean;
	format: string | null;
	preview?: Transaction[];
}

describe("POST /mmf/v1/import — end to end", () => {
	it("imports, reports duplicates on a re-import, and undoes the batch", async () => {
		const t = await setup();

		const first = await send(t, crypto, { method: "POST", path: "/import", body: importBody("export.qif", QIF) });
		expect(first.status).toBe(201);
		const created = first.json as ImportResponse;
		expect(created).toMatchObject({ imported: 2, duplicates: 0, written: 2, parsed: 2, dryRun: false, format: "QIF" });
		expect(created.batchId).toMatch(/^batch-/);
		// ACME BV matches nothing; Albert Heijn is a shipped rule.
		expect(created.uncategorised).toBe(1);
		expect(t.store.transactions).toHaveLength(2);
		expect(t.refreshes()).toBe(1);

		const again = await send(t, crypto, { method: "POST", path: "/import", body: importBody("export.qif", QIF) });
		expect(again.status).toBe(200);
		expect(again.json).toMatchObject({ batchId: null, imported: 0, duplicates: 2, written: 0 });
		expect(t.store.transactions).toHaveLength(2);
		expect(t.store.batches).toHaveLength(1);

		const list = await send(t, crypto, { path: "/imports" });
		expect(list.status).toBe(200);
		const { imports } = list.json as { imports: (ImportBatch & { remaining: number })[] };
		expect(imports).toHaveLength(1);
		expect(imports[0]).toMatchObject({ id: created.batchId, fileName: "export.qif", format: "QIF", count: 2, remaining: 2 });

		const one = await send(t, crypto, { path: `/imports/${created.batchId}` });
		expect(one.status).toBe(200);
		const detail = one.json as ImportBatch & { remaining: number; transactions: Transaction[] };
		expect(detail.transactions.map((tx) => tx.description).sort()).toEqual(["ACME BV", "ALBERT HEIJN"]);

		const refreshesBefore = t.refreshes();
		const undo = await send(t, crypto, { method: "POST", path: `/imports/${created.batchId}/undo` });
		expect(undo.status).toBe(200);
		expect(undo.json).toEqual({ batchId: created.batchId, removed: 2, written: 2 });
		expect(t.store.transactions).toHaveLength(0);
		expect(t.store.batches).toHaveLength(0);
		expect(t.refreshes()).toBe(refreshesBefore + 1);

		expect((await send(t, crypto, { path: `/imports/${created.batchId}` })).status).toBe(404);
		expect((await send(t, crypto, { method: "POST", path: `/imports/${created.batchId}/undo` })).status).toBe(404);
		expect(((await send(t, crypto, { path: "/imports" })).json as { imports: unknown[] }).imports).toEqual([]);

		// Undone means gone: the same file imports afresh.
		const back = await send(t, crypto, { method: "POST", path: "/import", body: importBody("export.qif", QIF) });
		expect(back.status).toBe(201);
		expect(back.json).toMatchObject({ imported: 2, duplicates: 0 });
	});

	it.each([
		["statement.xml", CAMT, "CAMT.053 statement", "camt"],
		["statement.sta", MT940, "MT940 statement", "mt940"],
		["export.ofx", OFX, "OFX / QFX", "ofx"],
		["export.qif", QIF, "QIF", "qif"],
		["revolut.csv", REVOLUT, "Revolut", "revolut"],
	])("reads %s by its content", async (fileName, text, label, source) => {
		const t = await setup();
		const res = await send(t, crypto, { method: "POST", path: "/import", body: importBody(fileName, text) });
		expect(res.status).toBe(201);
		expect(res.json).toMatchObject({ imported: 2, format: label });
		expect(t.store.transactions.every((tx) => tx.source === source && tx.accountId === "acc-1")).toBe(true);
		expect(t.store.batches[0]).toMatchObject({ fileName, format: label, count: 2 });
	});

	it("previews a dry run without writing anything", async () => {
		const t = await setup();
		const files = (t.store as unknown as { app: { vault: { adapter: { files: Map<string, string> } } } }).app.vault.adapter.files;
		const before = new Map(files);
		const res = await send(t, crypto, { method: "POST", path: "/import", body: importBody("export.qif", QIF, { dryRun: true }) });
		expect(res.status).toBe(200);
		const body = res.json as ImportResponse;
		expect(body).toMatchObject({ dryRun: true, batchId: null, imported: 2, duplicates: 0, written: 0, uncategorised: 1 });
		expect(body.preview?.map((tx) => tx.amount).sort((a, b) => a - b)).toEqual([-42.5, 2500]);
		expect(t.store.transactions).toHaveLength(0);
		expect(t.store.batches).toHaveLength(0);
		// Not one file touched — the pipeline still counts a successful POST as a change, which only
		// costs a polling client one needless re-read.
		expect(new Map(files)).toEqual(before);
	});

	it("takes an explicit mapping for a file no bank profile knows", async () => {
		const t = await setup();
		const odd = "Booked,What,Value\n2024-03-01,Coffee corner,-3.50\n2024-03-02,Bakery,-2.10";
		const unmapped = await send(t, crypto, { method: "POST", path: "/import", body: importBody("odd.csv", odd, { mapping: { date: null } }) });
		expect(unmapped.status).toBe(400);
		expect((unmapped.json as { error: string }).error).toMatch(/Unrecognized format/);

		const mapped = await send(t, crypto, {
			method: "POST",
			path: "/import",
			body: importBody("odd.csv", odd, { mapping: { date: "Booked", description: "What", amount: "Value" } }),
		});
		expect(mapped.status).toBe(201);
		expect(mapped.json).toMatchObject({ imported: 2, format: "Unrecognized" });
		expect(t.store.transactions.every((tx) => tx.source === "generic")).toBe(true);
	});

	it("answers 400 for a format it doesn't support", async () => {
		const t = await setup();
		const named = await send(t, crypto, { method: "POST", path: "/import", body: importBody("scan.pdf", QIF, { format: "pdf" }) });
		expect(named.status).toBe(400);
		expect((named.json as { error: string }).error).toMatch(/Unsupported format "pdf"/);

		const binary = await send(t, crypto, {
			method: "POST",
			path: "/import",
			body: { fileName: "scan.pdf", contentBase64: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]).toString("base64"), accountId: "acc-1" },
		});
		expect(binary.status).toBe(400);
		expect((binary.json as { error: string }).error).toMatch(/not a text export/);

		const workbook = await send(t, crypto, { method: "POST", path: "/import", body: importBody("book.xlsx", "not a workbook") });
		expect(workbook.status).toBe(400);
		expect(t.store.transactions).toHaveLength(0);
	});

	it("answers 404 for an unknown account, and writes nothing", async () => {
		const t = await setup();
		const res = await send(t, crypto, { method: "POST", path: "/import", body: importBody("export.qif", QIF, { accountId: "acc-nope" }) });
		expect(res.status).toBe(404);
		expect(res.json).toEqual({ error: 'No account "acc-nope"' });
		expect(t.store.transactions).toHaveLength(0);
		expect(t.refreshes()).toBe(0);
	});

	it("refuses a file whose IBAN belongs to a different account than the one named", async () => {
		const t = await setup([
			{ id: "acc-1", name: "Savings", type: "saving" },
			{ id: "acc-ing", name: "ING", type: "debit", iban: IBAN },
		]);
		const wrong = await send(t, crypto, { method: "POST", path: "/import", body: importBody("statement.sta", MT940) });
		expect(wrong.status).toBe(400);
		expect((wrong.json as { error: string }).error).toMatch(/acc-ing/);

		const right = await send(t, crypto, { method: "POST", path: "/import", body: importBody("statement.sta", MT940, { accountId: "acc-ing" }) });
		expect(right.status).toBe(201);
		expect(t.store.transactions.every((tx) => tx.accountId === "acc-ing")).toBe(true);
	});

	it.each([
		[undefined, /Expected a JSON object/],
		[{ contentBase64: "", accountId: "acc-1" }, /fileName is required/],
		[{ fileName: "x.qif", accountId: "acc-1" }, /contentBase64 is required/],
		[{ fileName: "x.qif", contentBase64: b64(QIF) }, /accountId is required/],
		[{ fileName: "x.qif", contentBase64: "not base64!", accountId: "acc-1" }, /not valid base64/],
		[{ fileName: "x.qif", contentBase64: "", accountId: "acc-1" }, /empty/],
		[{ fileName: "x.qif", contentBase64: b64(QIF), accountId: "acc-1", dryRun: "yes" }, /dryRun/],
		[{ fileName: "x.qif", contentBase64: b64(QIF), accountId: "acc-1", mapping: ["date"] }, /mapping must be an object/],
	])("answers 400 for a malformed request body (%#)", async (body, message) => {
		const t = await setup();
		const res = await send(t, crypto, { method: "POST", path: "/import", body });
		expect(res.status).toBe(400);
		expect((res.json as { error: string }).error).toMatch(message);
	});

	it("reads the store per request, so a portfolio switch imports into the new one", async () => {
		const t = await setup();
		const other = makeTestPlugin({ dataFolder: "OtherFinance" });
		await other.store.load();
		other.store.accounts = [{ id: "acc-1", name: "Other", type: "debit", currency: "EUR" } as Account];
		(t.plugin as { store: unknown }).store = other.store;

		const res = await send(t, crypto, { method: "POST", path: "/import", body: importBody("export.qif", QIF) });
		expect(res.status).toBe(201);
		expect(other.store.transactions).toHaveLength(2);
		expect(t.store.transactions).toHaveLength(0);
	});
});
