import { resolvePrimaryId } from "../categories";
import type { FinanceStore } from "../store";
import { isLiabilityType, type ReviewStatus, type Transaction } from "../types";
import { HttpError, type RequestContext, type Router } from "./router";

/**
 * GET /transactions, GET /transactions/:id and PATCH /transactions/:id — reading the ledger, and the
 * handful of per-row edits a client may make to it.
 *
 * The edit surface is deliberately the Review page's, not the edit modal's: a category, a note, and the
 * existing debt-payment split. Date, amount, account and description stay with the app, because those
 * are what decide which ledger file a row lives in and whether a later import dedupes against it, and a
 * client that changed them would be one bad request away from a duplicated or orphaned row. Every write
 * goes through the same store and plugin calls the UI makes, so merchant memory, rule provenance and
 * the review milestone behave exactly as they would had the change been made by hand.
 */

export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 1000;

const REVIEW_STATUSES: readonly ReviewStatus[] = ["new", "approved", "flagged"];

/** What a list request asked for, parsed and validated once so /review can reuse the same filters. */
export interface TransactionFilter {
	accountId?: string;
	/** Inclusive "YYYY-MM-DD" bounds. */
	from?: string;
	to?: string;
	categoryId?: string;
	/** true: only rows without a category; false: only rows with one; absent: either. */
	uncategorised?: boolean;
	/** Lower-cased needle. */
	q?: string;
	review?: ReviewStatus[];
	limit: number;
	offset: number;
}

export interface TransactionPage {
	items: Transaction[];
	total: number;
	/** The offset of the next page, or null when this one reached the end. */
	nextOffset: number | null;
}

/**
 * The store as it is for this request, or a 503 while the plugin is still loading. Resolved per call —
 * see RequestContext.store for why it is never kept.
 */
export function requireStore(ctx: RequestContext): FinanceStore {
	const store = ctx.store();
	if (!store) throw new HttpError(503, "Finance data is not loaded yet");
	return store;
}

/**
 * How many files a write touched, read off the store's revision counter. The counter goes up once per
 * file written and nowhere else during a request, so the difference is an honest "written" without the
 * API having to know which ledger files a row maps to.
 */
export function writtenSince(store: FinanceStore, revisionBefore: number): number {
	return store.revision - revisionBefore;
}

/** Absent means "new" — see ReviewStatus. */
export function reviewStatusOf(tx: Transaction): ReviewStatus {
	return tx.review ?? "new";
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
	if (!ISO_DATE.test(value)) return false;
	const date = new Date(`${value}T00:00:00Z`);
	// "2024-02-30" parses — into March — so the round-trip is what proves the day exists.
	return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function dateParam(query: URLSearchParams, name: string): string | undefined {
	const value = query.get(name);
	if (value === null || value === "") return undefined;
	if (!isRealDate(value)) throw new HttpError(400, `${name} must be a date in YYYY-MM-DD form`);
	return value;
}

function integerParam(query: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
	const raw = query.get(name);
	if (raw === null || raw === "") return fallback;
	if (!/^\d+$/.test(raw)) throw new HttpError(400, `${name} must be a whole number`);
	const value = Number(raw);
	if (value < min || value > max) throw new HttpError(400, `${name} must be between ${min} and ${max}`);
	return value;
}

function booleanParam(query: URLSearchParams, name: string): boolean | undefined {
	const raw = query.get(name);
	if (raw === null || raw === "") return undefined;
	if (raw === "true") return true;
	if (raw === "false") return false;
	throw new HttpError(400, `${name} must be true or false`);
}

/** `review=new,flagged` or `review=new&review=flagged` — both read naturally, so both are accepted. */
function reviewParam(query: URLSearchParams): ReviewStatus[] | undefined {
	const values = query
		.getAll("review")
		.flatMap((v) => v.split(","))
		.map((v) => v.trim())
		.filter((v) => v !== "");
	if (values.length === 0) return undefined;
	for (const value of values) {
		if (!REVIEW_STATUSES.includes(value as ReviewStatus)) throw new HttpError(400, `review must be one of ${REVIEW_STATUSES.join(", ")}`);
	}
	return Array.from(new Set(values)) as ReviewStatus[];
}

export function parseTransactionFilter(query: URLSearchParams): TransactionFilter {
	const from = dateParam(query, "from");
	const to = dateParam(query, "to");
	if (from && to && from > to) throw new HttpError(400, "from must not be after to");
	const q = query.get("q")?.trim().toLowerCase();
	return {
		accountId: query.get("account") || undefined,
		from,
		to,
		categoryId: query.get("category") || undefined,
		uncategorised: booleanParam(query, "uncategorised"),
		q: q || undefined,
		review: reviewParam(query),
		limit: integerParam(query, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT),
		offset: integerParam(query, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
	};
}

/**
 * Every row the filter matches, newest first.
 *
 * A primary category matches its subcategories too, as the Review page's category filter does —
 * asking for "Groceries" and missing every row filed under "Groceries > Supermarket" would read as data
 * loss. A date bound excludes undated rows: they have no place on either side of a date, and a client
 * asking for March should not be handed the rows the ledger keeps under unknown.csv.
 */
export function filterTransactions(store: FinanceStore, filter: TransactionFilter): Transaction[] {
	const { accountId, from, to, categoryId, uncategorised, q, review } = filter;
	const matches = store.transactions.filter((t) => {
		if (accountId && t.accountId !== accountId) return false;
		if (from && !(t.date && t.date >= from)) return false;
		if (to && !(t.date && t.date <= to)) return false;
		if (uncategorised === true && t.categoryId) return false;
		if (uncategorised === false && !t.categoryId) return false;
		if (categoryId && t.categoryId !== categoryId && resolvePrimaryId(store.categories, t.categoryId) !== categoryId) return false;
		if (review && !review.includes(reviewStatusOf(t))) return false;
		if (q && ![t.description, t.counterparty, t.notes].some((field) => field?.toLowerCase().includes(q))) return false;
		return true;
	});
	// Id as the tie-break so a page boundary falls in the same place on every request, even across
	// the dozens of rows a busy day holds.
	return matches.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function paginate(rows: Transaction[], filter: Pick<TransactionFilter, "limit" | "offset">): TransactionPage {
	const items = rows.slice(filter.offset, filter.offset + filter.limit);
	const end = filter.offset + items.length;
	return { items, total: rows.length, nextOffset: end < rows.length ? end : null };
}

function findTransaction(store: FinanceStore, id: string): Transaction {
	const tx = store.transactions.find((t) => t.id === id);
	if (!tx) throw new HttpError(404, `Transaction ${id} not found`);
	return tx;
}

/**
 * Checks that a category id names something a person could pick. Archived categories are refused
 * unless the row already sits in one, which is the same allowance the category picker makes
 * (offerableCategories) so that opening an old row never silently moves it.
 */
export function requireCategory(store: FinanceStore, categoryId: unknown, currentId?: string): string {
	if (typeof categoryId !== "string" || categoryId === "") throw new HttpError(400, "categoryId must be a category id");
	const category = store.categories.find((c) => c.id === categoryId);
	if (!category) throw new HttpError(400, `Category ${categoryId} not found`);
	if (category.archived && categoryId !== currentId) throw new HttpError(400, `Category ${categoryId} is archived`);
	return categoryId;
}

const SPLIT_FIELDS = ["principalAmount", "interestAmount", "feeAmount"] as const;
type SplitField = (typeof SPLIT_FIELDS)[number];
const PATCHABLE = new Set<string>(["categoryId", "notes", ...SPLIT_FIELDS]);

/**
 * Whether a row is a payment onto a debt — money coming into a loan, mortgage or credit card. The same
 * test the edit modal uses to decide whether to show the split fields at all (showsDebtSplit), so the
 * API can't put a split on a row the app would never have offered one for.
 */
function isDebtPayment(store: FinanceStore, tx: Transaction): boolean {
	const account = store.accounts.find((a) => a.id === tx.accountId);
	if (!account) return false;
	return tx.amount > 0 && (isLiabilityType(account.type) || account.type === "credit");
}

/**
 * Turns a PATCH body into the field patch it means, refusing anything outside the editable surface.
 *
 * The split rules are the modal's, made strict. The modal only accepts non-negative amounts and only
 * on a debt payment, but it merely *says* "over" when the parts exceed the total, because a person is
 * looking at that sentence as they type. A client is not, so a split that overshoots the amount by a
 * cent or more — the modal's own "accounted for" tolerance — is a 400 here rather than a silent save.
 */
function parsePatch(store: FinanceStore, tx: Transaction, body: unknown): { fields: Partial<Transaction>; categoryId?: string | null } {
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object");
	const record = body as Record<string, unknown>;
	const keys = Object.keys(record);
	const unknown = keys.filter((k) => !PATCHABLE.has(k));
	if (unknown.length > 0) {
		throw new HttpError(400, `Cannot change ${unknown.join(", ")} through the API — only categoryId, notes and the debt-payment split`);
	}
	if (keys.length === 0) throw new HttpError(400, "Nothing to change — send categoryId, notes or a debt-payment split field");

	const fields: Partial<Transaction> = {};
	let categoryId: string | null | undefined;
	if ("categoryId" in record) {
		categoryId = record.categoryId === null ? null : requireCategory(store, record.categoryId, tx.categoryId);
	}
	if ("notes" in record) {
		const notes = record.notes;
		if (notes !== null && typeof notes !== "string") throw new HttpError(400, "notes must be a string or null");
		// Blank is the same as cleared, as it is when the modal saves an emptied notes box.
		fields.notes = notes === null ? undefined : notes.trim() || undefined;
	}

	const touchesSplit = SPLIT_FIELDS.filter((f) => f in record);
	for (const field of touchesSplit) {
		const value = record[field];
		if (value === null) {
			fields[field] = undefined;
			continue;
		}
		if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
			throw new HttpError(400, `${field} must be a number of zero or more, or null`);
		}
		fields[field] = value;
	}
	if (touchesSplit.some((f) => record[f] !== null)) {
		if (!isDebtPayment(store, tx)) {
			throw new HttpError(400, "A principal/interest/fee split only applies to a payment into a loan, mortgage or credit card account");
		}
		const merged = (f: SplitField): number => (f in fields ? fields[f] : tx[f]) ?? 0;
		const split = merged("principalAmount") + merged("interestAmount") + merged("feeAmount");
		// In whole cents: 200 + 50.01 - 250 is 0.00999… in floating point, which would wave through
		// exactly the one-cent overshoot this is meant to catch.
		if (Math.round((split - tx.amount) * 100) >= 1) {
			throw new HttpError(400, `The split (${split.toFixed(2)}) is more than the transaction amount (${tx.amount.toFixed(2)})`);
		}
	}
	return { fields, categoryId };
}

function changes(tx: Transaction, fields: Partial<Transaction>): boolean {
	return (Object.keys(fields) as (keyof Transaction)[]).some((k) => tx[k] !== fields[k]);
}

export function register(router: Router): void {
	router.get("/transactions", (ctx) => {
		const store = requireStore(ctx);
		const filter = parseTransactionFilter(ctx.query);
		return paginate(filterTransactions(store, filter), filter);
	});

	router.get("/transactions/:id", (ctx) => findTransaction(requireStore(ctx), ctx.params.id));

	/**
	 * Changed fields only; null clears. Everything is validated before anything is written, so a bad
	 * split never leaves the category half-applied.
	 *
	 * A category goes through plugin.assignCategory — the call the transaction detail modal and the
	 * Review page's inline picker make — rather than a bare updateTransaction, because setting a
	 * category there is also a lesson: merchant memory learns it and every blank sibling from the same
	 * shop follows. `alsoCategorised` is how many siblings that reached. Re-sending the category the row
	 * already has is not a change and teaches nothing, as PATCH promises. Clearing one (null) is a plain
	 * field write: there is nothing to learn from "I don't know".
	 */
	router.patch("/transactions/:id", async (ctx) => {
		const store = requireStore(ctx);
		const tx = findTransaction(store, ctx.params.id);
		const { fields, categoryId } = parsePatch(store, tx, ctx.body);
		if (categoryId === null) fields.categoryId = undefined;

		const revisionBefore = store.revision;
		if (changes(tx, fields)) await store.updateTransaction(tx.id, fields);
		let alsoCategorised = 0;
		if (typeof categoryId === "string" && categoryId !== tx.categoryId) {
			alsoCategorised = await ctx.plugin.assignCategory(tx, categoryId);
		}

		const written = writtenSince(store, revisionBefore);
		if (written > 0) ctx.refresh();
		return { transaction: findTransaction(store, tx.id), alsoCategorised, written };
	});
}
