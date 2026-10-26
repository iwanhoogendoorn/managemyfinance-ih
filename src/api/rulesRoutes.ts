import { resolveRuleMatch, unsafeRegexReason } from "../import/categorize";
import { staleStampPatches } from "../rules";
import type { FinanceStore } from "../store";
import type { CategoryRule, CategoryRuleMatch, RuleAmountCondition, RuleAmountOp } from "../types";
import { applyChanges, newId, oneOf, readFields, text, type Field, type Fields } from "./bodyFields";
import { HttpError, reply, type RequestContext, type Router } from "./router";

/**
 * Category rules — the API side of the rule dialog and Manage rules.
 *
 * GET    /rules          { rules: CategoryRule[] }, in the order they are tried: the first match wins
 * GET    /rules/:id      the rule
 * POST   /rules          { pattern, categoryId, match?, amount? } → 201 { rule, written }
 * PATCH  /rules/:id      changed fields only; `amount: null` drops the amount condition → { rule, written }
 * DELETE /rules/:id      → { deleted, written }
 *
 * `match` is contains (the default), exact, starts-with or regex. A regex has to compile, and a pattern
 * that nests one repeat inside another — "(a+)+" — is refused with unsafeRegexReason's explanation:
 * the matcher would refuse to run it anyway, so saving it would only make a rule that never matches.
 * `isRegex`, the flag `match` superseded, is kept in step by the API rather than sent: it is written
 * alongside `match: "regex"` exactly as the rule dialog writes it, for anything still reading it.
 *
 * `amount` narrows the text match by the absolute amount, in the row's own currency:
 *   { op: "exactly" | "at-most" | "at-least", value }
 *   { op: "between", value, value2 }
 *   { op: "any-of", values: [9.99, 2.99] }
 *
 * Saving a rule does not re-file the ledger. Rules run on every import, and the in-app rule dialog is
 * where a rule is applied to existing rows with a preview of what moves; doing that from here, with no
 * one looking at the preview, is a different and much bigger write. The one ledger change a PATCH does
 * make is the one the dialog makes on every edit: rows still stamped as filed by this rule that the
 * edited rule no longer matches lose the stamp (never their category) — see staleStampPatches.
 *
 * `written` lists the vault files a call wrote or removed, as every write in the API does.
 */

const MATCH_TYPES: CategoryRuleMatch[] = ["contains", "exact", "starts-with", "regex"];
const AMOUNT_OPS: RuleAmountOp[] = ["exactly", "any-of", "between", "at-most", "at-least"];

function finite(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, `${name} must be a number`);
	return value;
}

/** The amount condition, in exactly the shape the rule dialog writes for each op and nothing more. */
const amountCondition: Field = {
	parse(value, name) {
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new HttpError(400, `${name} must be an object like {"op":"exactly","value":9.99}`);
		}
		const input = value as Record<string, unknown>;
		for (const key of Object.keys(input)) {
			if (!["op", "value", "value2", "values"].includes(key)) throw new HttpError(400, `Unknown field "${name}.${key}"`);
		}
		const op = input.op as RuleAmountOp;
		if (!AMOUNT_OPS.includes(op)) throw new HttpError(400, `${name}.op must be one of ${AMOUNT_OPS.join(", ")}`);

		if (op === "any-of") {
			if (!Array.isArray(input.values) || input.values.length === 0) {
				throw new HttpError(400, `${name}.values must be a non-empty list of amounts`);
			}
			const values = input.values.map((v, i) => finite(v, `${name}.values[${i}]`));
			return { op, value: values[0], values } satisfies RuleAmountCondition;
		}
		if (input.values !== undefined) throw new HttpError(400, `${name}.values is only for op "any-of"`);
		const condition: RuleAmountCondition = { op, value: finite(input.value, `${name}.value`) };
		if (op === "between") condition.value2 = finite(input.value2, `${name}.value2`);
		else if (input.value2 !== undefined) throw new HttpError(400, `${name}.value2 is only for op "between"`);
		return condition;
	},
};

const RULE_FIELDS: Fields = {
	pattern: text({ required: true }),
	categoryId: text({ required: true }),
	match: oneOf(MATCH_TYPES),
	amount: amountCondition,
};

export function register(router: Router): void {
	router.get("/rules", (ctx) => ({ rules: ctx.store().rules }));
	router.get("/rules/:id", (ctx) => findRule(ctx.store(), ctx.params.id));
	router.post("/rules", createRule);
	router.patch("/rules/:id", updateRule);
	router.delete("/rules/:id", async (ctx) => {
		const store = ctx.store();
		const rule = findRule(store, ctx.params.id);
		store.rules = store.rules.filter((r) => r.id !== rule.id);
		await store.saveRules();
		ctx.refresh();
		return { deleted: rule.id, written: ctx.written() };
	});
}

export function findRule(store: FinanceStore, id: string): CategoryRule {
	const rule = store.rules.find((r) => r.id === id);
	if (!rule) throw new HttpError(404, `No rule "${id}"`);
	return rule;
}

/**
 * Everything about a rule that depends on more than one field, checked on the rule as it would be
 * saved — so a PATCH that sends only `pattern` to a regex rule is checked as a regex, and one that
 * sends only `match: "regex"` checks the pattern already there.
 */
function checkRule(store: FinanceStore, rule: CategoryRule): void {
	if (!store.categories.some((c) => c.id === rule.categoryId)) throw new HttpError(400, `categoryId: no category "${rule.categoryId}"`);
	if (resolveRuleMatch(rule) !== "regex") return;
	const unsafe = unsafeRegexReason(rule.pattern);
	if (unsafe) throw new HttpError(400, `pattern: ${unsafe}`);
	try {
		new RegExp(rule.pattern, "i");
	} catch {
		throw new HttpError(400, "pattern isn't a regular expression that can be read");
	}
}

/** `isRegex` follows `match` whenever `match` is set, written alongside it and never instead of it. */
function syncLegacyFlag(rule: CategoryRule): void {
	if (rule.match === undefined) return;
	if (rule.match === "regex") rule.isRegex = true;
	else delete rule.isRegex;
}

/**
 * New rules go first, as the rule dialog puts them: a rule written about a specific merchant is the
 * most specific intent in the list, and appending it would let a broad older keyword rule keep winning.
 */
async function createRule(ctx: RequestContext): Promise<unknown> {
	const store = ctx.store();
	const changes = readFields(ctx.body, RULE_FIELDS, "create");
	const rule = applyChanges({ id: newId("rule"), match: "contains" } as CategoryRule, changes);
	syncLegacyFlag(rule);
	checkRule(store, rule);
	store.rules.unshift(rule);
	await store.saveRules();
	ctx.refresh();
	return reply(201, { rule, written: ctx.written() });
}

async function updateRule(ctx: RequestContext): Promise<unknown> {
	const store = ctx.store();
	const current = findRule(store, ctx.params.id);
	const changes = readFields(ctx.body, RULE_FIELDS, "patch");
	const next = applyChanges({ ...current }, changes);
	syncLegacyFlag(next);
	checkRule(store, next);

	// In place, so the rule keeps its position — its place in the order is part of what was set up.
	store.rules = store.rules.map((r) => (r.id === current.id ? next : r));
	await store.saveRules();

	const scopeChanged = "pattern" in changes || "match" in changes || "amount" in changes;
	const unstamped = scopeChanged ? await store.updateTransactions(staleStampPatches(store.transactions, next)) : 0;
	ctx.refresh();
	return { rule: next, unstamped, written: ctx.written() };
}
