import { ACCOUNT_TYPE_META } from "../constants";
import type { FinanceStore } from "../store";
import type { Account } from "../types";
import { applyChanges, boolean, isoDate, newId, number, objectBody, oneOf, readFields, text, type Fields } from "./bodyFields";
import { HttpError, reply, type RequestContext, type Router } from "./router";

/**
 * Accounts — the API side of Manage accounts.
 *
 * GET    /accounts          { accounts: Account[] }, in the order the sidebar lists them
 * GET    /accounts/:id      the account
 * POST   /accounts          { name, type?, currency?, ...optional fields } → 201 { account, written }
 * PATCH  /accounts/:id      changed fields only; null clears an optional one → { account, written }
 * DELETE /accounts/:id      → { deleted, removed: {...}, written }
 *
 * Closing an account is `PATCH { "archived": true }`, not a delete: it keeps every transaction, balance
 * and report exactly as it was and only takes the account out of the pickers for new activity (see
 * `Account.archived`). DELETE is the destructive one, and does exactly what the Manage accounts dialog
 * does — see deleteAccount below.
 *
 * `written` lists the vault files a call wrote or removed, as every write in the API does.
 */

export const ACCOUNT_TYPES = Object.keys(ACCOUNT_TYPE_META) as Account["type"][];

/** Day-of-month fields: a statement can close on the 31st, and a short month clamps it at read time. */
const dayOfMonth = number({ integer: true, min: 1, max: 31 });

/** `id` is not among them: it is minted here, and changing it would orphan every row filed under it. */
const ACCOUNT_FIELDS: Fields = {
	name: text({ required: true }),
	type: oneOf(ACCOUNT_TYPES, { required: true }),
	currency: {
		required: true,
		parse(value, name) {
			if (typeof value !== "string" || !/^[A-Za-z]{3}$/.test(value.trim())) {
				throw new HttpError(400, `${name} must be a 3-letter ISO 4217 code`);
			}
			return value.trim().toUpperCase();
		},
	},
	institution: text(),
	openingBalance: number(),
	openingDate: isoDate(),
	iban: text(),
	creditLimit: number({ min: 0 }),
	statementDay: dayOfMonth,
	paymentDueDay: dayOfMonth,
	apr: number({ min: 0 }),
	minPaymentPct: number({ min: 0, max: 1 }),
	archived: boolean(),
	trackBalance: boolean(),
};

export function register(router: Router): void {
	router.get("/accounts", (ctx) => ({ accounts: ctx.store().accounts }));
	router.get("/accounts/:id", (ctx) => findAccount(ctx.store(), ctx.params.id));
	router.post("/accounts", createAccount);
	router.patch("/accounts/:id", updateAccount);
	router.delete("/accounts/:id", deleteAccount);
}

export function findAccount(store: FinanceStore, id: string): Account {
	const account = store.accounts.find((a) => a.id === id);
	if (!account) throw new HttpError(404, `No account "${id}"`);
	return account;
}

/**
 * Only `name` is required. `type` defaults to "debit" and `currency` to the portfolio's base currency,
 * which is what Create account would pick for you; both are still validated when sent.
 */
async function createAccount(ctx: RequestContext): Promise<unknown> {
	const store = ctx.store();
	const body = { type: "debit", currency: store.fx.baseCurrency, ...objectBody(ctx.body) };
	const changes = readFields(body, ACCOUNT_FIELDS, "create");
	const account = applyChanges({ id: newId("acc") } as Account, normalise(changes));
	store.accounts.push(account);
	await store.saveAccounts();
	ctx.refresh();
	return reply(201, { account, written: ctx.written() });
}

async function updateAccount(ctx: RequestContext): Promise<unknown> {
	const store = ctx.store();
	const current = findAccount(store, ctx.params.id);
	const changes = normalise(readFields(ctx.body, ACCOUNT_FIELDS, "patch"));
	const next = applyChanges({ ...current }, changes);
	store.accounts = store.accounts.map((a) => (a.id === current.id ? next : a));
	await store.saveAccounts();
	ctx.refresh();
	return { account: next, written: ctx.written() };
}

/**
 * Absent-means-default fields are stored as absent, the way the UI writes them: an account that keeps
 * a running balance carries no `trackBalance`, and an open one no `archived`, so an account edited
 * through the API serialises exactly like one edited by hand and no file churns for nothing.
 */
function normalise(changes: Record<string, unknown>): Record<string, unknown> {
	if (changes.trackBalance === true) changes.trackBalance = undefined;
	if (changes.archived === false) changes.archived = undefined;
	return changes;
}

/**
 * DELETE /accounts/:id[?transactions=delete|keep]
 *
 * The same steps, in the same order, as Manage accounts → remove (ManageAccountsModal.performRemove):
 * recorded balances and linked cards go with the account, since neither can exist without one;
 * subscriptions and debts that merely point at it are kept with the reference cleared; and the
 * sidebar's active account is reset if it was this one.
 *
 * The one thing that dialog asks is what to do with the account's transactions, so the API asks too:
 * an account that still has any is a 409 until `?transactions=delete` (remove them from the ledger for
 * good — the dialog's "Delete everything") or `?transactions=keep` (leave them in the ledger with no
 * account — its "Keep the transactions") says which. Choosing for the caller would either destroy
 * history or quietly leave rows nothing in the app can open again, and neither should happen by
 * default. An account with no transactions needs no answer.
 */
async function deleteAccount(ctx: RequestContext): Promise<unknown> {
	const store = ctx.store();
	const account = findAccount(store, ctx.params.id);
	const mode = ctx.query.get("transactions");
	if (mode !== null && mode !== "delete" && mode !== "keep") {
		throw new HttpError(400, 'transactions must be "delete" or "keep"');
	}

	const transactionIds = store.transactions.filter((t) => t.accountId === account.id).map((t) => t.id);
	if (transactionIds.length > 0 && mode === null) {
		throw new HttpError(
			409,
			`Account "${account.name}" has ${transactionIds.length} transaction${transactionIds.length === 1 ? "" : "s"} — ` +
				"add ?transactions=delete to remove them with it, or ?transactions=keep to leave them in the ledger without an account"
		);
	}

	// The ledger first, as the dialog does: it is the only step that can fail on I/O, and failing it
	// after the account is gone is what would leave the orphans this whole flow exists to prevent.
	const deletedTransactions = mode === "delete" && transactionIds.length > 0 ? await store.deleteTransactions(transactionIds) : 0;

	const snapshotsBefore = store.snapshots.length;
	store.snapshots = store.snapshots.filter((s) => s.accountId !== account.id);
	const snapshots = snapshotsBefore - store.snapshots.length;
	if (snapshots > 0) await store.saveSnapshots();

	const cardsBefore = store.cards.length;
	store.cards = store.cards.filter((c) => c.accountId !== account.id);
	const cards = cardsBefore - store.cards.length;
	if (cards > 0) await store.saveCards();

	let subscriptions = 0;
	for (const subscription of store.subscriptions) {
		if (subscription.accountId !== account.id) continue;
		subscription.accountId = undefined;
		subscriptions++;
	}
	if (subscriptions > 0) await store.saveSubscriptions();

	let debts = 0;
	for (const debt of store.debts) {
		if (debt.accountId !== account.id) continue;
		debt.accountId = undefined;
		debts++;
	}
	if (debts > 0) await store.saveDebts();

	store.accounts = store.accounts.filter((a) => a.id !== account.id);
	if (ctx.plugin.settings.activeAccountId === account.id) {
		ctx.plugin.settings.activeAccountId = undefined;
		await ctx.plugin.saveSettings();
	}
	await store.saveAccounts();
	ctx.refresh();

	return {
		deleted: account.id,
		removed: { transactions: deletedTransactions, snapshots, cards },
		cleared: { subscriptions, debts },
		keptTransactions: mode === "keep" ? transactionIds.length : 0,
		written: ctx.written(),
	};
}
