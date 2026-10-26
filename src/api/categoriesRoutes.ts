import { canReparent, descendantIds, reparented, secondaryCategoriesOf, withArchived } from "../categories";
import type { FinanceStore } from "../store";
import type { Category, Transaction } from "../types";
import {
	applyChanges,
	boolean,
	newId,
	numberRecord,
	objectBody,
	oneOf,
	readFields,
	stringList,
	takeChange,
	text,
	type Fields,
} from "./bodyFields";
import { HttpError, reply, type RequestContext, type Router } from "./router";

/**
 * Categories — the API side of Settings → Categories.
 *
 * GET    /categories        { categories: Category[] } — primaries and secondaries in one flat list;
 *                           a secondary carries the `parentId` of the primary it sits under
 * GET    /categories/:id    the category
 * POST   /categories        { name, parentId?, color?, icon?, ... } → 201 { category, written }
 * PATCH  /categories/:id    changed fields only; null clears an optional one → { category, written }
 * DELETE /categories/:id    → { deleted, written, ... } — see deleteCategory
 *
 * The model is exactly two levels deep, and the rules that keep it so are the ones in categories.ts,
 * not a copy of them: a new secondary needs a primary for a parent, and a move (`PATCH { parentId }`,
 * null for the top level) is accepted only when canReparent says the UI's own dropdown would offer it.
 *
 * `PATCH { "archived": true }` hides a category from budgets and pickers while every transaction keeps
 * it — the soft alternative to deleting — and, through withArchived, takes a primary's secondaries
 * with it; `false` brings them all back.
 *
 * `written` lists the vault files a call wrote or removed, as every write in the API does.
 */

const DEFAULT_COLOR = "#64748b";
const DEFAULT_ICON = "tag";

/** `parentId` and `archived` are read here and applied by their own rules; see updateCategory. */
const CATEGORY_FIELDS: Fields = {
	name: text({ required: true }),
	color: text({ required: true }),
	icon: text({ required: true }),
	aliases: stringList(),
	parentId: text(),
	archived: boolean(),
	budgetMode: oneOf(["total", "breakdown"]),
	kind: oneOf(["expense", "income"]),
	essential: boolean(),
	budgetHistory: numberRecord(/^\d{4}-(0[1-9]|1[0-2])$/, "months as YYYY-MM"),
	annualBudgets: numberRecord(/^\d{4}$/, "years as YYYY"),
};

export function register(router: Router): void {
	router.get("/categories", (ctx) => ({ categories: ctx.store().categories }));
	router.get("/categories/:id", (ctx) => findCategory(ctx.store(), ctx.params.id));
	router.post("/categories", createCategory);
	router.patch("/categories/:id", updateCategory);
	router.delete("/categories/:id", deleteCategory);
}

export function findCategory(store: FinanceStore, id: string): Category {
	const category = store.categories.find((c) => c.id === id);
	if (!category) throw new HttpError(404, `No category "${id}"`);
	return category;
}

/** A parent named in a body: it has to exist and be a primary, or the result is three levels deep. */
function primaryParent(store: FinanceStore, parentId: string): Category {
	const parent = store.categories.find((c) => c.id === parentId);
	if (!parent) throw new HttpError(400, `parentId: no category "${parentId}"`);
	if (parent.parentId) throw new HttpError(400, `parentId: "${parent.name}" is itself a subcategory — categories nest one level deep`);
	return parent;
}

/** `budgetMode` means "budget is the sum of my subcategories", which a subcategory can't have. */
function checkBudgetMode(category: Category): void {
	if (category.parentId && category.budgetMode) throw new HttpError(400, "budgetMode applies to primary categories only");
}

/**
 * Only `name` is required. A secondary inherits its parent's colour and icon unless given its own,
 * exactly as Settings → Categories pre-fills them; a primary gets the same defaults that row offers.
 */
async function createCategory(ctx: RequestContext): Promise<unknown> {
	const store = ctx.store();
	const input = objectBody(ctx.body);
	const parentId = typeof input.parentId === "string" ? input.parentId.trim() : "";
	const parent = parentId ? primaryParent(store, parentId) : undefined;
	const body = { color: parent?.color ?? DEFAULT_COLOR, icon: parent?.icon ?? DEFAULT_ICON, aliases: [], ...input };
	const changes = readFields(body, CATEGORY_FIELDS, "create");
	if (changes.archived === false) changes.archived = undefined;

	const category = applyChanges({ id: newId("cat") } as Category, changes);
	if (!category.aliases) category.aliases = [];
	checkBudgetMode(category);
	store.categories.push(category);
	await store.saveCategories();
	ctx.refresh();
	return reply(201, { category, written: ctx.written() });
}

/**
 * The move first, then the archive flag, then everything else — so `budgetMode` is checked against
 * where the category ends up, and a move that drops `budgetMode` (reparented does, for a primary that
 * becomes a secondary) can't be undone by the same request setting it again.
 */
async function updateCategory(ctx: RequestContext): Promise<unknown> {
	const store = ctx.store();
	const current = findCategory(store, ctx.params.id);
	const changes = readFields(ctx.body, CATEGORY_FIELDS, "patch");
	let categories = store.categories;

	const parent = takeChange(changes, "parentId");
	if (parent.sent) {
		const newParentId = parent.value as string | undefined;
		if ((current.parentId ?? undefined) !== newParentId) {
			if (newParentId !== undefined) primaryParent(store, newParentId);
			if (newParentId === current.id) throw new HttpError(400, "parentId: a category can't be its own parent");
			if (!canReparent(categories, current.id, newParentId)) {
				const children = secondaryCategoriesOf(categories, current.id).length;
				const what = `${children} subcategor${children === 1 ? "y" : "ies"}`;
				throw new HttpError(400, `parentId: "${current.name}" has ${what} of its own, so it can't become one — move or delete them first`);
			}
			categories = reparented(categories, current.id, newParentId);
		}
	}

	const archived = takeChange(changes, "archived");
	if (archived.sent) categories = withArchived(categories, current.id, archived.value === true);

	if (changes.aliases === undefined && "aliases" in changes) changes.aliases = [];
	let updated = categories.find((c) => c.id === current.id) as Category;
	updated = applyChanges({ ...updated }, changes);
	checkBudgetMode(updated);
	store.categories = categories.map((c) => (c.id === current.id ? updated : c));
	await store.saveCategories();
	ctx.refresh();
	return { category: updated, written: ctx.written() };
}

/**
 * DELETE /categories/:id[?moveTo=<categoryId>|none]
 *
 * What Settings → Categories → delete does (DeleteCategoryModal): a primary is deleted together with
 * its secondaries, and the transactions tagged with any of them have to go somewhere. Deleting used to
 * silently orphan them — still pointing at an id nothing resolves, reading as "Uncategorized" but not
 * findable as uncategorized, so the spend dropped out of every total — so when there are any, the
 * delete is a 409 until `?moveTo=<categoryId>` names where they go or `?moveTo=none` says to leave
 * them uncategorized, the dialog's two choices. A category nothing uses needs no answer.
 *
 * To hide a category without touching a single transaction, archive it instead.
 */
async function deleteCategory(ctx: RequestContext): Promise<unknown> {
	const store = ctx.store();
	const category = findCategory(store, ctx.params.id);
	const doomed = new Set(category.parentId ? [category.id] : descendantIds(store.categories, category.id));
	const moveTo = ctx.query.get("moveTo");

	let target: Category | undefined;
	if (moveTo !== null && moveTo !== "none") {
		target = store.categories.find((c) => c.id === moveTo);
		if (!target) throw new HttpError(400, `moveTo: no category "${moveTo}"`);
		if (doomed.has(target.id)) throw new HttpError(400, "moveTo can't be a category that is being deleted");
	}

	const affected = store.transactions.filter((t) => t.categoryId && doomed.has(t.categoryId));
	if (affected.length > 0 && moveTo === null) {
		throw new HttpError(
			409,
			`${affected.length} transaction${affected.length === 1 ? " is" : "s are"} tagged with "${category.name}"` +
				(doomed.size > 1 ? " or its subcategories" : "") +
				" — add ?moveTo=<categoryId> to move them, or ?moveTo=none to leave them uncategorized"
		);
	}

	if (affected.length > 0) {
		const patches = new Map<string, Partial<Transaction>>();
		for (const tx of affected) patches.set(tx.id, { categoryId: target?.id });
		await store.updateTransactions(patches);
	}

	store.categories = store.categories.filter((c) => !doomed.has(c.id));
	await store.saveCategories();
	ctx.refresh();

	return {
		deleted: category.id,
		deletedSubcategories: Array.from(doomed).filter((id) => id !== category.id),
		transactions: { affected: affected.length, movedTo: target?.id ?? null },
		written: ctx.written(),
	};
}
