import { reviewCounts } from "../review";
import type { FinanceStore } from "../store";
import type { ReviewStatus, Transaction } from "../types";
import { HttpError, type RequestContext, type Router } from "./router";
import { filterTransactions, paginate, parseTransactionFilter, requireCategory, requireStore } from "./transactionsRoutes";

/**
 * GET /review, POST /review/approve and POST /review/recategorise — working the review queue from
 * outside the app.
 *
 * Each action is the Review page's own bulk action, step for step: the same updateTransactions patch,
 * then the same merchant-memory bookkeeping (rememberMerchantsFor, confirmFullyApprovedMerchants), so a
 * queue cleared over the API leaves merchants exactly as confirmed as one cleared by hand. Leaving that
 * second half out is the bug review.ts and main.ts both describe — 3,950 approved rows behind a recheck
 * dialog still offering to re-examine every shop.
 */

/** What still needs a decision. Approved rows are done and never part of the queue. */
const QUEUE: readonly ReviewStatus[] = ["new", "flagged"];

export interface BulkFailure {
	ref: string;
	error: string;
}

/**
 * The `ids` of a bulk body, de-duplicated, split into rows that exist and refs that don't. A missing id
 * is reported per ref rather than failing the whole request — a client working from a page it read a
 * minute ago should get the other forty-nine approved, and be told plainly which one had gone.
 */
function resolveIds(store: FinanceStore, body: unknown): { found: Transaction[]; failed: BulkFailure[] } {
	if (typeof body !== "object" || body === null || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object");
	const ids = (body as { ids?: unknown }).ids;
	if (!Array.isArray(ids) || ids.length === 0) throw new HttpError(400, "ids must be a non-empty array of transaction ids");
	if (ids.some((id) => typeof id !== "string" || id === "")) throw new HttpError(400, "ids must contain only transaction ids");

	const byId = new Map(store.transactions.map((t) => [t.id, t] as const));
	const found: Transaction[] = [];
	const failed: BulkFailure[] = [];
	for (const id of new Set(ids as string[])) {
		const tx = byId.get(id);
		if (tx) found.push(tx);
		else failed.push({ ref: id, error: "Transaction not found" });
	}
	return { found, failed };
}

/**
 * Runs one bulk patch the way ReviewSection does and reports it in the bulk shape. `applied` counts
 * every row now in the requested state, including rows that already were — approving an approved row
 * succeeded, it just had nothing to do. `changed` is how many actually moved, and `written` the files
 * that did — [] when nothing did, and then the pipeline repaints nothing either.
 */
async function applyBulk(
	ctx: RequestContext,
	store: FinanceStore,
	found: Transaction[],
	failed: BulkFailure[],
	patch: Partial<Transaction>,
	after: (ids: string[]) => Promise<unknown>
): Promise<{ applied: number; changed: number; failed: BulkFailure[]; written: string[] }> {
	const ids = found.map((t) => t.id);
	let changed = 0;
	if (ids.length > 0) {
		changed = await store.updateTransactions(new Map(ids.map((id) => [id, { ...patch }] as const)));
		await after(ids);
	}
	return { applied: ids.length, changed, failed, written: ctx.written() };
}

export function register(router: Router): void {
	/**
	 * The queue: everything still "new" or "flagged", newest first, with the same filters and paging as
	 * GET /transactions. `review` may narrow the queue to one pile but not widen it to approved rows —
	 * that is GET /transactions?review=approved. `counts` are review.ts's tallies, for the account when
	 * one is asked for and for the whole ledger otherwise, which is the distinction reviewCounts exists
	 * to make.
	 */
	router.get("/review", (ctx) => {
		const store = requireStore(ctx);
		const filter = parseTransactionFilter(ctx.query);
		if (filter.review?.some((s) => !QUEUE.includes(s))) throw new HttpError(400, "review may only be new or flagged here");
		filter.review = filter.review ?? [...QUEUE];
		const scope = filter.accountId ? store.transactions.filter((t) => t.accountId === filter.accountId) : store.transactions;
		return { ...paginate(filterTransactions(store, filter), filter), counts: reviewCounts(scope) };
	});

	/** Bulk approve — ReviewSection's setStatus(ids, "approved"). */
	router.post("/review/approve", async (ctx) => {
		const store = requireStore(ctx);
		const { found, failed } = resolveIds(store, ctx.body);
		return applyBulk(ctx, store, found, failed, { review: "approved" }, (ids) => ctx.plugin.confirmFullyApprovedMerchants(ids));
	});

	/**
	 * Category and approval in one — ReviewSection's categorizeAndApprove, the common case when working
	 * down the queue. Merchant memory learns the category for every row, then any merchant whose rows
	 * are now all approved under one category is credited as confirmed.
	 */
	router.post("/review/recategorise", async (ctx) => {
		const store = requireStore(ctx);
		const { found, failed } = resolveIds(store, ctx.body);
		const categoryId = requireCategory(store, (ctx.body as { categoryId?: unknown }).categoryId);
		return applyBulk(ctx, store, found, failed, { categoryId, review: "approved" }, async (ids) => {
			await ctx.plugin.rememberMerchantsFor(ids, categoryId);
			await ctx.plugin.confirmFullyApprovedMerchants(ids);
		});
	});
}
