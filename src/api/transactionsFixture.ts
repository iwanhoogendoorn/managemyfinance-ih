import FinancePlugin from "../main";
import type { Account, Category, Transaction } from "../types";
import { makeTestPlugin, type TestPlugin } from "./testPlugin";

/**
 * Test-only: a small synthetic ledger for the transaction and review endpoint tests, on top of the
 * shared makeTestPlugin. Never imported by production code, and none of it is real bank data.
 *
 * The test plugin from testPlugin.ts is a plain object, so it has none of FinancePlugin's category
 * methods. The real ones are borrowed from the prototype rather than re-implemented: they only touch
 * `this.store`, and the whole point of these tests is that the API runs the exact code the UI runs.
 */

export const ACCOUNTS: Account[] = [
	{ id: "acc-chk", name: "Checking", type: "debit", currency: "EUR" } as Account,
	{ id: "acc-loan", name: "Car loan", type: "loan", currency: "EUR" } as Account,
	{ id: "acc-cc", name: "Credit card", type: "credit", currency: "EUR" } as Account,
];

function category(id: string, name: string, extra: Partial<Category> = {}): Category {
	return { id, name, color: "#888888", icon: "tag", aliases: [], ...extra };
}

export const CATEGORIES: Category[] = [
	category("cat-food", "Food"),
	category("cat-food-super", "Supermarket", { parentId: "cat-food" }),
	category("cat-rent", "Rent"),
	category("cat-fun", "Fun"),
	category("cat-old", "Old stuff", { archived: true }),
];

function tx(id: string, date: string, accountId: string, description: string, amount: number, extra: Partial<Transaction> = {}): Transaction {
	return { id, date, accountId, description, amount, currency: "EUR", source: "generic", ...extra };
}

/** Newest first is 2024-03-20, oldest 2024-01-05; t-undated has no date at all. */
export function ledger(): Transaction[] {
	return [
		tx("t-01", "2024-01-05", "acc-chk", "GROCER BROTHERS 0012", -40.1),
		tx("t-02", "2024-01-20", "acc-chk", "GROCER BROTHERS 0034", -12.5),
		tx("t-03", "2024-02-01", "acc-chk", "Landlord Ltd", -900, { categoryId: "cat-rent", review: "approved", counterparty: "Housing Co" }),
		tx("t-04", "2024-02-14", "acc-chk", "Cinema Plaza", -22, { categoryId: "cat-fun", review: "flagged", notes: "Birthday outing" }),
		tx("t-05", "2024-02-28", "acc-chk", "Corner shop", -3.2, { categoryId: "cat-food-super", review: "approved" }),
		tx("t-06", "2024-03-01", "acc-loan", "Loan instalment", 250),
		tx("t-07", "2024-03-10", "acc-cc", "Card repayment", 120, { principalAmount: 100, interestAmount: 20 }),
		tx("t-08", "2024-03-20", "acc-chk", "GROCER BROTHERS 0056", -8.75, { categoryId: "cat-food", categoryRuleId: "rule-grocer" }),
		tx("t-09", "2024-03-20", "acc-cc", "Paper store", -15, { counterparty: "Stationery World" }),
		tx("t-undated", "", "acc-chk", "Mystery row", -1),
	];
}

export interface LedgerFixture extends TestPlugin {
	/** Every onReviewChange the store reported, in order. */
	reviewChanges: unknown[][];
}

/** A loaded test plugin holding the fixture ledger, with FinancePlugin's category methods attached. */
export async function makeLedgerPlugin(transactions: Transaction[] = ledger()): Promise<LedgerFixture> {
	const t = makeTestPlugin();
	await t.store.load();
	t.store.accounts = ACCOUNTS.map((a) => ({ ...a }));
	t.store.categories = CATEGORIES.map((c) => ({ ...c }));
	t.store.merchants = {};
	await t.store.importTransactions(transactions);
	const proto = FinancePlugin.prototype;
	Object.assign(t.plugin, {
		assignCategory: proto.assignCategory,
		rememberMerchantsFor: proto.rememberMerchantsFor,
		confirmFullyApprovedMerchants: proto.confirmFullyApprovedMerchants,
	});
	const reviewChanges: unknown[][] = [];
	t.store.onReviewChange = (before, after) => reviewChanges.push([before, after]);
	return { ...t, reviewChanges };
}

/** The ledger as data, for comparing two stores — strips the per-import batch id, which differs by run. */
export function snapshot(transactions: Transaction[]): Record<string, unknown>[] {
	return transactions
		.map((t) => {
			const { importBatchId: _batch, ...rest } = t;
			return JSON.parse(JSON.stringify(rest)) as Record<string, unknown>;
		})
		.sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
