import { merchantKey } from "../import/merchantKey";
import { dismissSuggestion, markReviewed, remember, type MerchantEntry, type MerchantMap } from "../import/merchantMemory";
import type { FinanceStore } from "../store";
import { boolean, objectBody, readFields, takeChange, text, type Fields } from "./bodyFields";
import { HttpError, reply, type RequestContext, type Router } from "./router";

/**
 * Merchant memory — what the portfolio has learned about which category each merchant belongs to
 * (data/merchants.json; see import/merchantMemory.ts). Entries are keyed by merchantKey(), the
 * normalised merchant identity every import groups rows by, and the key is the id in every path:
 * URL-encode it, since keys contain spaces ("albert heijn" → /merchants/albert%20heijn).
 *
 * GET    /merchants                  { merchants: MerchantEntry[] }, by key
 * GET    /merchants/:key             the entry
 * POST   /merchants                  { key | description (+ counterparty?), categoryId } → { merchant, written };
 *                                    201 when the merchant was new. `description` is turned into the
 *                                    key the way an import would, for a caller holding a bank line
 *                                    rather than a key
 * PATCH  /merchants/:key             { categoryId?, reviewed? } → { merchant, written }
 * POST   /merchants/:key/dismiss     rejects a parked AI suggestion without choosing a category, and
 *                                    remembers that, so the same guess isn't offered again
 * DELETE /merchants/:key             forgets the merchant entirely → { deleted, written }
 *
 * A category set here is recorded as your own decision (`source: "user"`), the strongest there is: an
 * AI answer or a rule match never overwrites it afterwards. That is the same call — remember() — the
 * transaction editor makes when you file a row by hand. Like that call, it changes what the next import
 * does and not the ledger: filing existing rows is a transaction write.
 *
 * `written` lists the vault files a call wrote or removed, as every write in the API does.
 */

const CREATE_FIELDS: Fields = {
	key: text(),
	description: text(),
	counterparty: text(),
	categoryId: text({ required: true }),
};

const PATCH_FIELDS: Fields = {
	categoryId: text(),
	reviewed: boolean(),
};

export function register(router: Router): void {
	router.get("/merchants", (ctx) => {
		const merchants = Object.values(ctx.store().merchants).sort((a, b) => a.key.localeCompare(b.key));
		return { merchants };
	});
	router.get("/merchants/:key", (ctx) => findMerchant(ctx.store(), ctx.params.key));
	router.post("/merchants", createMerchant);
	router.patch("/merchants/:key", updateMerchant);
	router.post("/merchants/:key/dismiss", async (ctx) => {
		const store = ctx.store();
		const key = ctx.params.key;
		if (ctx.body !== undefined && Object.keys(objectBody(ctx.body)).length > 0) throw new HttpError(400, "dismiss takes no body");
		await save(store, dismissSuggestion(store.merchants, key));
		ctx.refresh();
		return { merchant: store.merchants[key], written: ctx.written() };
	});
	router.delete("/merchants/:key", async (ctx) => {
		const store = ctx.store();
		const entry = findMerchant(store, ctx.params.key);
		const next: MerchantMap = { ...store.merchants };
		delete next[entry.key];
		await save(store, next);
		ctx.refresh();
		return { deleted: entry.key, written: ctx.written() };
	});
}

export function findMerchant(store: FinanceStore, key: string): MerchantEntry {
	const entry = Object.prototype.hasOwnProperty.call(store.merchants, key) ? store.merchants[key] : undefined;
	if (!entry) throw new HttpError(404, `No merchant "${key}"`);
	return entry;
}

async function save(store: FinanceStore, map: MerchantMap): Promise<void> {
	store.merchants = map;
	await store.saveMerchants();
}

function checkCategory(store: FinanceStore, categoryId: string): void {
	if (!store.categories.some((c) => c.id === categoryId)) throw new HttpError(400, `categoryId: no category "${categoryId}"`);
}

function today(): string {
	return new Date().toISOString().slice(0, 10);
}

async function createMerchant(ctx: RequestContext): Promise<unknown> {
	const store = ctx.store();
	const changes = readFields(ctx.body, CREATE_FIELDS, "create");
	const sentKey = changes.key as string | undefined;
	const description = changes.description as string | undefined;
	if (sentKey && description) throw new HttpError(400, "Send key or description, not both");
	if (!sentKey && changes.counterparty !== undefined && !description) throw new HttpError(400, "counterparty goes with description");

	const counterparty = changes.counterparty as string | undefined;
	const key = sentKey ?? (description ? merchantKey({ description, counterparty }) : undefined);
	if (!sentKey && !description) throw new HttpError(400, "key or description is required");
	if (!key) throw new HttpError(400, "description: no merchant could be recognised in it");

	const categoryId = changes.categoryId as string;
	checkCategory(store, categoryId);
	const isNew = !Object.prototype.hasOwnProperty.call(store.merchants, key);
	await save(store, remember(store.merchants, key, categoryId, "user"));
	ctx.refresh();
	const body = { merchant: store.merchants[key], written: ctx.written() };
	return isNew ? reply(201, body) : body;
}

/**
 * `categoryId` files the merchant (as your own decision, see above); `null` takes its category away
 * and leaves it to be learned or asked about again. `reviewed: true` records that a person has checked
 * the category — what stops a recheck raising it again — and `false` or `null` withdraws that.
 */
async function updateMerchant(ctx: RequestContext): Promise<unknown> {
	const store = ctx.store();
	const entry = findMerchant(store, ctx.params.key);
	const changes = readFields(ctx.body, PATCH_FIELDS, "patch");
	let map = store.merchants;

	const category = takeChange(changes, "categoryId");
	if (category.sent) {
		if (typeof category.value === "string") {
			checkCategory(store, category.value);
			map = remember(map, entry.key, category.value, "user");
		} else {
			const cleared: MerchantEntry = { ...map[entry.key], source: "user", at: today() };
			delete cleared.categoryId;
			delete cleared.suggestion;
			map = { ...map, [entry.key]: cleared };
		}
	}

	const reviewed = takeChange(changes, "reviewed");
	if (reviewed.sent) {
		if (reviewed.value === true) {
			map = markReviewed(map, entry.key, map[entry.key].categoryId);
		} else {
			const unreviewed: MerchantEntry = { ...map[entry.key] };
			delete unreviewed.reviewedAt;
			map = { ...map, [entry.key]: unreviewed };
		}
	}

	await save(store, map);
	ctx.refresh();
	return { merchant: store.merchants[entry.key], written: ctx.written() };
}
