import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Account } from "../types";
import { makeTestPlugin, send, type TestPlugin, type TestRequest } from "./testPlugin";

/** Two synthetic accounts, one with rows, a snapshot, a card, a subscription and a debt pointing at it. */
async function fixture(): Promise<TestPlugin> {
	const t = makeTestPlugin();
	await t.store.load();
	t.store.accounts = [
		{ id: "acc-main", name: "Checking", type: "debit", currency: "EUR", iban: "NL00TEST0000000001" },
		{ id: "acc-empty", name: "Spare", type: "saving", currency: "EUR" },
	];
	await t.store.saveAccounts();
	await t.store.importTransactions([
		{ id: "tx-1", date: "2024-03-01", accountId: "acc-main", description: "Shop", amount: -5, currency: "EUR", source: "manual" },
		{ id: "tx-2", date: "2024-03-02", accountId: "acc-main", description: "Shop", amount: -6, currency: "EUR", source: "manual" },
	]);
	t.store.snapshots = [{ id: "snap-1", accountId: "acc-main", date: "2024-01-01", balance: 100 } as never];
	t.store.cards = [{ id: "card-1", accountId: "acc-main" } as never];
	t.store.subscriptions = [{ id: "sub-1", accountId: "acc-main" } as never];
	t.store.debts = [{ id: "debt-1", accountId: "acc-main" } as never];
	t.settings.activeAccountId = "acc-main";
	return t;
}

const ACCOUNTS_FILE = "TestFinance/data/accounts.json";

function call(t: TestPlugin, req: TestRequest) {
	return send(t, crypto, req);
}

/** What is actually on disk: a reload reads every file back, so a write that only touched memory fails here. */
async function reloaded(t: TestPlugin): Promise<Account[]> {
	await t.store.load();
	return t.store.accounts;
}

describe("GET /accounts", () => {
	it("lists every account", async () => {
		const t = await fixture();
		const res = await call(t, { path: "/accounts" });
		expect(res.status).toBe(200);
		expect((res.json as { accounts: Account[] }).accounts.map((a) => a.id)).toEqual(["acc-main", "acc-empty"]);
	});

	it("gets one account, and 404s an unknown id", async () => {
		const t = await fixture();
		const res = await call(t, { path: "/accounts/acc-main" });
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ id: "acc-main", name: "Checking" });
		const missing = await call(t, { path: "/accounts/nope" });
		expect(missing.status).toBe(404);
		expect(missing.json).toEqual({ error: 'No account "nope"' });
	});
});

describe("POST /accounts", () => {
	it("creates with defaults, answers 201 with written, saves and refreshes", async () => {
		const t = await fixture();
		const res = await call(t, { method: "POST", path: "/accounts", body: { name: "  Wallet ", openingBalance: 20 } });
		expect(res.status).toBe(201);
		const { account, written } = res.json as { account: Account; written: string[] };
		expect(written).toEqual([ACCOUNTS_FILE]);
		expect(account).toMatchObject({ name: "Wallet", type: "debit", currency: "EUR", openingBalance: 20 });
		expect(account.id).toMatch(/^acc-/);
		expect(t.refreshes()).toBeGreaterThan(0);
		expect((await reloaded(t)).find((a) => a.id === account.id)).toEqual(account);
	});

	it("stores a tracked, open account without the default flags", async () => {
		const t = await fixture();
		const body = { name: "Card", type: "credit", currency: "usd", trackBalance: true, archived: false };
		const res = await call(t, { method: "POST", path: "/accounts", body });
		const { account } = res.json as { account: Account };
		expect(account.currency).toBe("USD");
		expect("trackBalance" in account).toBe(false);
		expect("archived" in account).toBe(false);
	});

	it.each([
		[{}, "name is required"],
		[{ name: "   " }, "name can't be empty"],
		[{ name: "X", type: "piggy" }, "type must be one of"],
		[{ name: "X", type: null }, "type can't be cleared"],
		[{ name: "X", currency: "EURO" }, "currency must be a 3-letter"],
		[{ name: "X", statementDay: 32 }, "statementDay must be at most 31"],
		[{ name: "X", openingDate: "2024-02-30" }, "openingDate must be a date"],
		[{ name: "X", colour: "red" }, 'Unknown field "colour"'],
		[{ name: "X", id: "acc-mine" }, 'Unknown field "id"'],
	])("refuses %j with a 400", async (body, message) => {
		const t = await fixture();
		const res = await call(t, { method: "POST", path: "/accounts", body });
		expect(res.status).toBe(400);
		expect((res.json as { error: string }).error).toContain(message);
		expect(t.store.accounts).toHaveLength(2);
	});

	it("refuses a body that isn't an object", async () => {
		const t = await fixture();
		const res = await call(t, { method: "POST", path: "/accounts", body: ["Wallet"] });
		expect(res.status).toBe(400);
	});
});

describe("PATCH /accounts/:id", () => {
	it("changes only the fields sent, and null clears an optional one", async () => {
		const t = await fixture();
		const res = await call(t, { method: "PATCH", path: "/accounts/acc-main", body: { name: "Main", iban: null, archived: true } });
		expect(res.status).toBe(200);
		const { account, written } = res.json as { account: Account; written: string[] };
		expect(written).toEqual([ACCOUNTS_FILE]);
		expect(account).toEqual({ id: "acc-main", name: "Main", type: "debit", currency: "EUR", archived: true });
		expect((await reloaded(t)).find((a) => a.id === "acc-main")).toEqual(account);
	});

	it("writes trackBalance: true back as absent, and false as false", async () => {
		const t = await fixture();
		let res = await call(t, { method: "PATCH", path: "/accounts/acc-main", body: { trackBalance: false } });
		expect((res.json as { account: Account }).account.trackBalance).toBe(false);
		res = await call(t, { method: "PATCH", path: "/accounts/acc-main", body: { trackBalance: true } });
		expect("trackBalance" in (res.json as { account: Account }).account).toBe(false);
	});

	it("404s an unknown id and 400s bad bodies", async () => {
		const t = await fixture();
		expect((await call(t, { method: "PATCH", path: "/accounts/nope", body: { name: "X" } })).status).toBe(404);
		for (const body of [{}, { name: null }, { nickname: "X" }, { creditLimit: "lots" }]) {
			const res = await call(t, { method: "PATCH", path: "/accounts/acc-main", body });
			expect(res.status).toBe(400);
		}
		expect(t.store.accounts[0].name).toBe("Checking");
	});
});

describe("DELETE /accounts/:id", () => {
	it("deletes an account with nothing filed against it", async () => {
		const t = await fixture();
		const res = await call(t, { method: "DELETE", path: "/accounts/acc-empty" });
		expect(res.status).toBe(200);
		expect(res.json).toEqual({
			deleted: "acc-empty",
			removed: { transactions: 0, snapshots: 0, cards: 0 },
			cleared: { subscriptions: 0, debts: 0 },
			keptTransactions: 0,
			written: [ACCOUNTS_FILE],
		});
		expect((await reloaded(t)).map((a) => a.id)).toEqual(["acc-main"]);
	});

	it("refuses with 409 while transactions are filed against it, and changes nothing", async () => {
		const t = await fixture();
		const res = await call(t, { method: "DELETE", path: "/accounts/acc-main" });
		expect(res.status).toBe(409);
		expect((res.json as { error: string }).error).toMatch(/2 transactions.*\?transactions=delete/);
		expect(t.store.accounts).toHaveLength(2);
		expect(t.store.snapshots).toHaveLength(1);
	});

	it("?transactions=delete removes the rows, snapshots and cards, and clears references", async () => {
		const t = await fixture();
		const res = await call(t, { method: "DELETE", path: "/accounts/acc-main?transactions=delete" });
		expect(res.status).toBe(200);
		expect(res.json).toEqual({
			deleted: "acc-main",
			removed: { transactions: 2, snapshots: 1, cards: 1 },
			cleared: { subscriptions: 1, debts: 1 },
			keptTransactions: 0,
			written: expect.arrayContaining([
				"TestFinance/data/ledger/manual/2024.csv",
				"TestFinance/data/snapshots.json",
				"TestFinance/data/cards.json",
				"TestFinance/data/subscriptions.json",
				"TestFinance/data/debts.json",
				ACCOUNTS_FILE,
			]),
		});
		expect(t.store.transactions).toHaveLength(0);
		expect(t.store.subscriptions[0].accountId).toBeUndefined();
		expect(t.store.debts[0].accountId).toBeUndefined();
		expect(t.settings.activeAccountId).toBeUndefined();
		await t.store.load();
		expect(t.store.transactions).toHaveLength(0);
		expect(t.store.accounts.map((a) => a.id)).toEqual(["acc-empty"]);
	});

	it("?transactions=keep leaves the rows in the ledger", async () => {
		const t = await fixture();
		const res = await call(t, { method: "DELETE", path: "/accounts/acc-main?transactions=keep" });
		expect(res.status).toBe(200);
		expect(res.json).toMatchObject({ removed: { transactions: 0 }, keptTransactions: 2 });
		await t.store.load();
		expect(t.store.transactions).toHaveLength(2);
		expect(t.store.accounts.map((a) => a.id)).toEqual(["acc-empty"]);
	});

	it("404s an unknown id and 400s an unknown mode", async () => {
		const t = await fixture();
		expect((await call(t, { method: "DELETE", path: "/accounts/nope" })).status).toBe(404);
		expect((await call(t, { method: "DELETE", path: "/accounts/acc-main?transactions=maybe" })).status).toBe(400);
	});
});
