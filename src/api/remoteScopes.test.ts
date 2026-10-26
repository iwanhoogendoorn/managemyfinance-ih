import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import FinancePlugin from "../main";
import type { Account, Category, Transaction } from "../types";
import { AUDIT_NOTE, diffLedger, snapshotLedger } from "./audit";
import { outOfScopeFields, scopedRoute } from "./scopes";
import { makeTestPlugin, send, type TestPlugin, type TestRequest } from "./testPlugin";
import { snapshot } from "./transactionsFixture";

/**
 * Remote write scopes and the audit log, end to end through the real pipeline over a real store on the
 * in-memory vault. The remote client is a tailnet peer (100.x) with the token, as a bot reaching the
 * API over Tailscale would be. Every file and row here is synthetic.
 */

const REVOLUT_ID = "acc-1786533611324-h6hww";
const PEER = "100.101.2.3";
const AUDIT_PATH = `TestFinance/${AUDIT_NOTE}`;

/** Revolut's own export header and row shape. */
const REVOLUT_CSV = `Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD_PAYMENT,Current,2026-10-01 10:00:00,2026-10-01 10:01:00,Pizzeria Roma,-24.50,0.00,EUR,COMPLETED,975.50
CARD_PAYMENT,Current,2026-10-03 18:20:00,2026-10-03 18:21:00,Albert Heijn,-42.10,0.00,EUR,COMPLETED,933.40
TOPUP,Current,2026-10-05 09:00:00,2026-10-05 09:00:00,Top-up by card,500.00,0.00,EUR,COMPLETED,1433.40
CARD_PAYMENT,Current,2026-10-07 12:00:00,2026-10-07 12:01:00,Unknown Kiosk 77,-3.20,0.00,EUR,COMPLETED,1430.20`;

/** The first two rows of the same export — what was already imported last week. */
const REVOLUT_EARLIER = REVOLUT_CSV.split("\n").slice(0, 3).join("\n");

const DINING: Category = { id: "cat-dining", name: "Dining out", color: "#f97316", icon: "utensils", aliases: [] };

function b64(text: string): string {
	return Buffer.from(text, "utf8").toString("base64");
}

async function setup(settings: Parameters<typeof makeTestPlugin>[0] = {}): Promise<TestPlugin> {
	const t = makeTestPlugin({ apiBind: "tailscale", apiRemoteWriteScopes: true, ...settings });
	await t.store.load();
	t.store.accounts = [{ id: REVOLUT_ID, name: "Revolut Prive", type: "debit", currency: "EUR" } as Account];
	t.store.categories = [...t.store.categories, { ...DINING }];
	// One of your own rules, so the test can tell rule categorisation from the shipped keyword set.
	t.store.rules = [{ id: "rule-roma", pattern: "Pizzeria Roma", categoryId: DINING.id }];
	const proto = FinancePlugin.prototype;
	Object.assign(t.plugin, {
		assignCategory: proto.assignCategory,
		rememberMerchantsFor: proto.rememberMerchantsFor,
		confirmFullyApprovedMerchants: proto.confirmFullyApprovedMerchants,
	});
	return t;
}

function remote(req: TestRequest): TestRequest {
	return { remoteAddress: PEER, ...req };
}

function importRevolut(text: string, extra: Record<string, unknown> = {}): TestRequest {
	return remote({ method: "POST", path: "/import", body: { fileName: "revolut.csv", contentBase64: b64(text), accountId: REVOLUT_ID, ...extra } });
}

async function auditNote(t: TestPlugin): Promise<string> {
	const adapter = t.plugin.app.vault.adapter;
	return (await adapter.exists(AUDIT_PATH)) ? adapter.read(AUDIT_PATH) : "";
}

/** The JSON blocks of the audit note, oldest first. */
async function auditEntries(t: TestPlugin): Promise<Record<string, any>[]> {
	const note = await auditNote(t);
	return Array.from(note.matchAll(/```json\n([\s\S]*?)\n```/g), (m) => JSON.parse(m[1]));
}

describe("scopes", () => {
	it.each([
		["POST", "/mmf/v1/import", "import"],
		["PATCH", "/mmf/v1/transactions/tx-1", "patch-transaction"],
		["POST", "/mmf/v1/imports/batch-1/undo", "undo-import"],
		["POST", "/mmf/v1/import/batch-1/undo", "undo-import"],
	])("lets %s %s through as %s", (method, path, route) => {
		expect(scopedRoute(method, path)).toBe(route);
	});

	it.each([
		["DELETE", "/mmf/v1/transactions/tx-1"],
		["POST", "/mmf/v1/transactions/tx-1"],
		["POST", "/mmf/v1/accounts"],
		["PATCH", "/mmf/v1/accounts/acc-1"],
		["POST", "/mmf/v1/review/approve"],
		["POST", "/mmf/v1/rules"],
		["POST", "/mmf/v1/import/"],
		["POST", "/mmf/v1/imports/a/b/undo"],
		["POST", "/elsewhere/import"],
	])("keeps %s %s out", (method, path) => {
		expect(scopedRoute(method, path)).toBeUndefined();
	});

	it("allows only categoryId and review in a scoped PATCH", () => {
		expect(outOfScopeFields({ categoryId: "c", review: "approved" })).toEqual([]);
		expect(outOfScopeFields({ categoryId: "c", notes: "x", amount: 1 })).toEqual(["notes", "amount"]);
	});
});

describe("remote write scopes — POST /import", () => {
	it("dry run returns the parsed rows, the duplicates it would skip and the suggested categories, and writes nothing", async () => {
		const t = await setup();
		await send(t, crypto, { ...importRevolut(REVOLUT_EARLIER), remoteAddress: "127.0.0.1" });
		const ledgerBefore = snapshot(t.store.transactions);
		const revisionBefore = t.store.revision;
		const batchesBefore = t.store.batches.length;

		const res = await send(t, crypto, importRevolut(REVOLUT_CSV, { dryRun: true }));
		expect(res.status).toBe(200);
		const body = res.json as Record<string, any>;
		expect(body).toMatchObject({ dryRun: true, batchId: null, parsed: 4, imported: 2, duplicates: 2, written: [] });
		expect(body.duplicateRows.map((r: Transaction) => r.description)).toEqual(["Pizzeria Roma", "Albert Heijn"]);
		expect(body.preview.map((r: Transaction) => r.description)).toEqual(["Top-up by card", "Unknown Kiosk 77"]);
		expect(body.preview.every((r: Transaction) => r.accountId === REVOLUT_ID)).toBe(true);
		expect(body.preview[0]).toHaveProperty("categoryName");

		expect(snapshot(t.store.transactions)).toEqual(ledgerBefore);
		expect(t.store.revision).toBe(revisionBefore);
		expect(t.store.batches).toHaveLength(batchesBefore);
	});

	it("imports a Revolut export into Revolut Prive with your rules applied, and importing it again adds nothing", async () => {
		const t = await setup();
		const first = await send(t, crypto, importRevolut(REVOLUT_CSV));
		expect(first.status).toBe(201);
		expect(first.json).toMatchObject({ imported: 4, duplicates: 0 });
		const byDesc = (d: string) => t.store.transactions.find((x) => x.description === d)!;
		expect(t.store.transactions.every((x) => x.accountId === REVOLUT_ID)).toBe(true);
		// cat-dining exists only in this test and only rule-roma points at it, so the category is the rule's.
		expect(byDesc("Pizzeria Roma")).toMatchObject({ amount: -24.5, date: "2026-10-01", categoryId: DINING.id });

		const ledger = snapshot(t.store.transactions);
		const again = await send(t, crypto, importRevolut(REVOLUT_CSV));
		expect(again.status).toBe(200);
		expect(again.json).toMatchObject({ batchId: null, imported: 0, duplicates: 4, written: [] });
		expect(snapshot(t.store.transactions)).toEqual(ledger);
		expect(t.store.batches).toHaveLength(1);
	});

	it("doesn't duplicate rows the ledger already has from an earlier import", async () => {
		const t = await setup();
		await send(t, crypto, importRevolut(REVOLUT_EARLIER));
		const res = await send(t, crypto, importRevolut(REVOLUT_CSV));
		expect(res.json).toMatchObject({ imported: 2, duplicates: 2 });
		expect(t.store.transactions).toHaveLength(4);
	});
});

describe("remote write scopes — what stays out", () => {
	it.each([
		{ method: "POST", path: "/accounts", body: { name: "X", type: "debit" } },
		{ method: "PATCH", path: `/accounts/${REVOLUT_ID}`, body: { name: "Hacked" } },
		{ method: "DELETE", path: `/accounts/${REVOLUT_ID}` },
		{ method: "POST", path: "/rules", body: { pattern: "x", categoryId: DINING.id } },
		{ method: "DELETE", path: "/rules/rule-roma" },
		{ method: "POST", path: "/review/approve", body: { ids: [] } },
		{ method: "POST", path: "/categories", body: { name: "Y" } },
		{ method: "POST", path: "/merchants", body: { key: "k", categoryId: DINING.id } },
	])("refuses $method $path from another device with 403 and changes nothing", async (req) => {
		const t = await setup();
		const before = JSON.stringify([t.store.accounts, t.store.rules, t.store.categories]);
		const res = await send(t, crypto, remote(req));
		expect(res.status).toBe(403);
		expect((res.json as { error: string }).error).toMatch(/outside the remote write scopes/);
		expect(JSON.stringify([t.store.accounts, t.store.rules, t.store.categories])).toBe(before);
	});

	it.each([[{ notes: "hi" }], [{ amount: 5 }], [{ categoryId: DINING.id, date: "2026-01-01" }], [{ principalAmount: 1 }]])(
		"refuses PATCH /transactions/:id with %j from another device with 403 and writes nothing",
		async (body) => {
			const t = await setup();
			await send(t, crypto, importRevolut(REVOLUT_CSV));
			const tx = t.store.transactions[0];
			const ledger = snapshot(t.store.transactions);
			const res = await send(t, crypto, remote({ method: "PATCH", path: `/transactions/${tx.id}`, body }));
			expect(res.status).toBe(403);
			expect((res.json as { error: string }).error).toMatch(/allow only categoryId and review/);
			expect(snapshot(t.store.transactions)).toEqual(ledger);
		}
	);

	it.each([
		"/mmf/v1/import/../accounts",
		"/mmf/v1/import/%2e%2e/accounts",
		"/mmf/v1/transactions/x/../../accounts",
		"/mmf/v1//accounts",
		"/mmf/v1/import?x=/../accounts",
	])("can't reach another write by dressing up the path: POST %s", async (path) => {
		const t = await setup();
		const res = await send(t, crypto, remote({ method: "POST", path, body: { name: "X", type: "debit" } }));
		expect([403, 400]).toContain(res.status);
		expect(t.store.accounts).toHaveLength(1);
	});

	it("refuses every remote write while the scopes are off, as before", async () => {
		const t = await setup({ apiRemoteWriteScopes: false });
		const res = await send(t, crypto, importRevolut(REVOLUT_CSV));
		expect(res.status).toBe(403);
		expect((res.json as { error: string }).error).toMatch(/Writes from other devices are turned off/);
		expect(t.store.transactions).toHaveLength(0);
	});

	it("treats a write relayed by tailscale serve on loopback as remote, and scopes it", async () => {
		const t = await setup();
		const res = await send(t, crypto, {
			method: "POST",
			path: "/accounts",
			body: { name: "X", type: "debit" },
			remoteAddress: "127.0.0.1",
			headers: { "x-forwarded-for": PEER },
		});
		expect(res.status).toBe(403);
	});

	it("leaves same-device requests exactly as they were: every write allowed, nothing audited", async () => {
		const t = await setup();
		const res = await send(t, crypto, { method: "POST", path: "/rules", body: { pattern: "Kiosk", categoryId: DINING.id } });
		expect(res.status).toBe(201);
		await send(t, crypto, { ...importRevolut(REVOLUT_CSV), remoteAddress: "127.0.0.1" });
		const tx = t.store.transactions[0];
		expect((await send(t, crypto, { method: "PATCH", path: `/transactions/${tx.id}`, body: { notes: "local note" } })).status).toBe(200);
		expect(await auditNote(t)).toBe("");
	});
});

describe("remote write scopes — PATCH and undo", () => {
	it("sets a category and approves a row from another device", async () => {
		const t = await setup();
		await send(t, crypto, importRevolut(REVOLUT_CSV));
		const kiosk = t.store.transactions.find((x) => x.description === "Unknown Kiosk 77")!;
		const res = await send(t, crypto, remote({ method: "PATCH", path: `/transactions/${kiosk.id}`, body: { categoryId: DINING.id, review: "approved" } }));
		expect(res.status).toBe(200);
		expect(t.store.transactions.find((x) => x.id === kiosk.id)).toMatchObject({ categoryId: DINING.id, review: "approved" });

		const back = await send(t, crypto, remote({ method: "PATCH", path: `/transactions/${kiosk.id}`, body: { review: "new" } }));
		expect(back.status).toBe(200);
		expect(t.store.transactions.find((x) => x.id === kiosk.id)?.review).toBeUndefined();
	});

	it.each(["/imports", "/import"])("undo through %s/:batchId/undo restores the ledger to before the import", async (prefix) => {
		const t = await setup();
		await send(t, crypto, { ...importRevolut(REVOLUT_EARLIER), remoteAddress: "127.0.0.1" });
		const before = snapshot(t.store.transactions);
		const batchesBefore = t.store.batches.map((b) => b.id);

		const imported = await send(t, crypto, importRevolut(REVOLUT_CSV));
		const { batchId } = imported.json as { batchId: string };
		expect(t.store.transactions).toHaveLength(4);

		const undo = await send(t, crypto, remote({ method: "POST", path: `${prefix}/${batchId}/undo` }));
		expect(undo.status).toBe(200);
		expect(undo.json).toMatchObject({ batchId, removed: 2 });
		expect(snapshot(t.store.transactions)).toEqual(before);
		expect(t.store.batches.map((b) => b.id)).toEqual(batchesBefore);
	});
});

describe("audit log", () => {
	it("records a remote PATCH with its time, endpoint, ids, and the values before and after", async () => {
		const t = await setup();
		await send(t, crypto, { ...importRevolut(REVOLUT_CSV), remoteAddress: "127.0.0.1" });
		const kiosk = t.store.transactions.find((x) => x.description === "Unknown Kiosk 77")!;
		await send(t, crypto, remote({ method: "PATCH", path: `/transactions/${kiosk.id}`, body: { categoryId: DINING.id, review: "approved" } }));

		const [entry] = await auditEntries(t);
		expect(entry).toMatchObject({
			method: "PATCH",
			path: `/mmf/v1/transactions/${kiosk.id}`,
			client: PEER,
			access: "scoped",
			status: 200,
			ids: { id: kiosk.id },
		});
		expect(Date.parse(entry.time)).not.toBeNaN();
		const change = entry.changes.changed.find((c: { id: string }) => c.id === kiosk.id);
		expect(change.before).toMatchObject({ categoryId: null, review: null });
		expect(change.after).toMatchObject({ categoryId: DINING.id, review: "approved" });
	});

	it("records an import's batch and added rows, an undo's removed rows, and a dry run as changing nothing", async () => {
		const t = await setup();
		await send(t, crypto, importRevolut(REVOLUT_CSV, { dryRun: true }));
		const imported = await send(t, crypto, importRevolut(REVOLUT_CSV));
		const { batchId } = imported.json as { batchId: string };
		await send(t, crypto, remote({ method: "POST", path: `/imports/${batchId}/undo` }));

		const [dry, real, undo] = await auditEntries(t);
		expect(dry).toMatchObject({ dryRun: true, status: 200 });
		expect(dry.changes).toBeUndefined();
		expect(real).toMatchObject({ status: 201, ids: { batchId } });
		expect(real.changes.added).toHaveLength(4);
		expect(real.changes.added[0]).toMatchObject({ accountId: REVOLUT_ID, importBatchId: batchId });
		expect(undo).toMatchObject({ status: 200, ids: { batchId } });
		expect(undo.changes.removed).toHaveLength(4);
	});

	it("records refused writes too, but not requests without the token", async () => {
		const t = await setup();
		await send(t, crypto, remote({ method: "DELETE", path: `/accounts/${REVOLUT_ID}` }));
		await send(t, crypto, remote({ method: "POST", path: "/import", body: {}, token: "wrong" }));
		const entries = await auditEntries(t);
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({ method: "DELETE", access: "refused", status: 403 });
		expect(entries[0].error).toMatch(/outside the remote write scopes/);
	});

	it("audits remote writes under the full switch as well", async () => {
		const t = await setup({ apiAllowRemoteWrites: true, apiRemoteWriteScopes: false });
		const res = await send(t, crypto, remote({ method: "POST", path: "/rules", body: { pattern: "Kiosk", categoryId: DINING.id } }));
		expect(res.status).toBe(201);
		expect((await auditEntries(t))[0]).toMatchObject({ access: "full", status: 201 });
	});

	it("never writes the token into the note", async () => {
		const t = await setup();
		await send(t, crypto, importRevolut(REVOLUT_CSV));
		expect(await auditNote(t)).not.toContain(t.settings.apiToken!);
	});

	it("diffs only what moved", () => {
		const a = { id: "x", date: "2026-01-01", accountId: "a", description: "d", amount: -1, currency: "EUR", source: "generic" } as Transaction;
		const before = snapshotLedger([a]);
		const after = snapshotLedger([{ ...a, categoryId: "c" }]);
		expect(diffLedger(before, after)).toEqual({ added: [], removed: [], changed: [{ id: "x", before: { categoryId: null }, after: { categoryId: "c" } }] });
	});
});
