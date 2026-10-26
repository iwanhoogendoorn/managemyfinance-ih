import { currentMonth } from "../budgets";
import { categoryChain } from "../categories";
import { collectReportAttachments } from "../reports/attachments";
import { buildReportCsv, buildReportHtml, buildReportMarkdown, buildReportXml, type ExportContext } from "../reports/export";
import { buildMonthlyReport, buildNetWorthReport, buildYearlyReport, type ReportContext } from "../reports/markdown";
import {
	describePeriod,
	describeQuery,
	reportSlug,
	runReport,
	UNCATEGORIZED,
	type ReportQuery,
	type ReportResult,
	type ReportSource,
} from "../reports/query";
import { writeReportNote } from "../reports/write";
import type { FinanceStore } from "../store";
import { boolean, isoDate, oneOf, readFields, stringList, text, type Field, type Fields } from "./bodyFields";
import { HttpError, type RequestContext, type Router } from "./router";
import { requireStore } from "./transactionsRoutes";

/**
 * Reports — the API side of the Reports page and of the "Write this month's report" commands.
 *
 * GET  /reports             what can be generated: every report type, the formats each comes in, and
 *                           the format table (extension, content type)
 * GET  /reports/generate    ?type=&period=&title=&format= plus the query's own fields (from, to, categoryIds, …)
 *                           → the same reply as the POST, computed only: `written` is always []
 * POST /reports/generate    { type, period?, query?, title?, format?, write? }
 *                           → { type, format, period, fileName, contentType, content, written, ... }
 *
 * Four types, two families. `monthly`, `yearly` and `net-worth` are the fixed snapshot notes the
 * commands write (reports/markdown.ts) — a budget-and-totals summary rather than a list of rows, so they
 * come as markdown and nothing else. `custom` is the Reports page's query builder (reports/query.ts):
 * any slice of the ledger, rendered by reports/export.ts as markdown, CSV, SpreadsheetML (`xml`, what
 * the page's Excel button saves as .xls) or the HTML its PDF is printed from. Every type runs the same
 * builder the app does, so a report fetched here can't disagree with the one the app would have made.
 *
 * The content comes back inline, as a string. `write: true` also saves it as a note under
 * `<dataFolder>/reports/`, through the same writer and under the same name the app uses — so it
 * replaces the note the command or the Reports page would have written, rather than adding a copy.
 * Only markdown is a note; the other formats are files to take out of Obsidian, which is the caller's
 * job once it has the content.
 *
 * Generating comes in two methods, split by whether anything is written. GET computes the report and
 * hands it back, nothing more: it can't carry `write`, never touches the vault, and so — being a read —
 * the pipeline lets another device call it while "Allow writes from other devices" is off, which is what
 * a phone asking for this month's figures needs. POST does the same and can also save the note, so with
 * that switch off it is refused for another device like every other POST. Both read their input into
 * one GenerateRequest and run the one generator, so the same report asked for either way comes back
 * identical, down to the 400s: a GET's query fields are the POST's `query` object spread flat into the
 * query string, and its 400s name them bare (`from`) where the POST's say `query.from`.
 *
 * A report note is not finance data: the store doesn't write it, so it doesn't move `x-mmf-revision`
 * and repaints no view. It is still listed in `written`, as every file an API call writes is.
 */

/** The formats a report can be rendered in, and what a client should save each one as. */
export const REPORT_FORMATS = {
	markdown: { extension: "md", contentType: "text/markdown; charset=utf-8" },
	csv: { extension: "csv", contentType: "text/csv; charset=utf-8" },
	xml: { extension: "xls", contentType: "application/vnd.ms-excel" },
	html: { extension: "html", contentType: "text/html; charset=utf-8" },
} as const;

export type ReportFormat = keyof typeof REPORT_FORMATS;

const FORMATS = Object.keys(REPORT_FORMATS) as ReportFormat[];

/**
 * Every report type, as GET /reports lists it — and the table /reports/generate validates against,
 * so what is advertised and what is accepted can't drift apart.
 */
export const REPORT_TYPES = [
	{
		type: "monthly",
		description: "One month as a note: income, expenses, net, savings rate, spending by category and budget performance.",
		period: "YYYY-MM — defaults to this month",
		formats: ["markdown"],
	},
	{
		type: "yearly",
		description: "One year as a note: the headline figures, the month-by-month walk and budget planned vs actual.",
		period: "YYYY — defaults to this year",
		formats: ["markdown"],
	},
	{
		type: "net-worth",
		description: "Net worth today, its trajectory year by year, and every account's balance.",
		period: null,
		formats: ["markdown"],
	},
	{
		type: "custom",
		description: "Any slice of the ledger — totals, breakdowns by category, month, merchant and account, and the matching rows.",
		period: null,
		formats: FORMATS,
	},
] as const satisfies readonly { type: string; description: string; period: string | null; formats: readonly ReportFormat[] }[];

export type ReportType = (typeof REPORT_TYPES)[number]["type"];

const TYPES = REPORT_TYPES.map((t) => t.type);

/** A custom report's query, field for field the ReportQuery the Reports page builds. */
const QUERY_FIELDS: Fields = {
	from: isoDate(),
	to: isoDate(),
	categoryIds: stringList(),
	excludeCategoryIds: stringList(),
	accountIds: stringList(),
	search: text(),
	measure: oneOf(["economic", "cash-flow"]),
	direction: oneOf(["all", "out", "in"]),
	includeTransfers: boolean(),
};

/** The query object, read by the same rules as a top-level body so a typo in it is a 400 too. */
const queryField: Field = {
	parse(value, name) {
		if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${name} must be an object`);
		try {
			return readFields(value, QUERY_FIELDS, "create");
		} catch (err) {
			if (err instanceof HttpError) throw new HttpError(400, `${name}: ${err.message}`);
			throw err;
		}
	},
};

const GENERATE_FIELDS: Fields = {
	type: oneOf(TYPES, { required: true }),
	period: text(),
	query: queryField,
	title: text(),
	format: oneOf(FORMATS),
	write: boolean(),
};

/**
 * The body fields a GET's query string carries as themselves. `query` isn't one — its fields come bare,
 * next to these — and neither is `write`, which a GET refuses by name rather than as an unknown.
 */
const GET_FIELDS: Fields = {
	type: GENERATE_FIELDS.type,
	period: GENERATE_FIELDS.period,
	title: GENERATE_FIELDS.title,
	format: GENERATE_FIELDS.format,
};

/** The query fields that are lists, so may be repeated in a query string — every other parameter is one value. */
const LIST_PARAMS = ["categoryIds", "excludeCategoryIds", "accountIds"];

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR = /^\d{4}$/;

export function register(router: Router): void {
	router.get("/reports", () => ({
		types: REPORT_TYPES,
		formats: FORMATS.map((format) => ({ format, ...REPORT_FORMATS[format] })),
		queryFields: Object.keys(QUERY_FIELDS),
	}));
	router.get("/reports/generate", generateForGet);
	router.post("/reports/generate", generateReport);
}

/** A generate request, read from a POST body or a GET query string, in the one shape the generator takes. */
interface GenerateRequest {
	type: ReportType;
	format: ReportFormat;
	period?: string;
	title?: string;
	query?: ReportQuery;
	/** What the caller sent the query as, for the 400 a fixed report gives it: `query` in a body, its first field in a query string. */
	querySentAs?: string;
	/** Put before a query field's name in a 400: "query." in a body, where the fields sit inside `query`, nothing in a query string. */
	queryPrefix: string;
}

function hasOwn(object: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(object, key);
}

interface Rendered {
	period: string;
	/** The file's name without its extension — the note name for markdown, as the app names it. */
	name: string;
	content: string;
	/** Only for custom reports, which have a result worth quoting without parsing the content. */
	title?: string;
	summary?: Record<string, unknown>;
}

async function generateReport(ctx: RequestContext): Promise<unknown> {
	const store = requireStore(ctx);
	const changes = readFields(ctx.body, GENERATE_FIELDS, "create");
	const request: GenerateRequest = {
		type: changes.type as ReportType,
		format: (changes.format as ReportFormat | undefined) ?? "markdown",
		period: changes.period as string | undefined,
		title: changes.title as string | undefined,
		query: changes.query as ReportQuery | undefined,
		querySentAs: changes.query !== undefined ? "query" : undefined,
		queryPrefix: "query.",
	};
	const write = changes.write === true;
	checkRequest(request);
	if (write && request.format !== "markdown") throw new HttpError(400, "write saves the report as a note, so it needs format markdown");

	const rendered = await renderReport(ctx, store, request);
	const written = ctx.written();
	if (write) {
		const path = await writeReportNote(ctx.plugin.app, ctx.plugin.settings.dataFolder, rendered.name, rendered.content);
		if (!written.includes(path)) written.push(path);
		// A no-op today — the note went through the vault, not the store, so nothing a view shows has
		// changed — but kept so a write here repaints like every other the moment that stops being true.
		ctx.refresh();
	}
	return reportReply(request, rendered, written);
}

/**
 * GET /reports/generate: the POST without the write. Nothing here can reach writeReportNote or the
 * store's writers, so `written` is a literal [] rather than whatever the request tracked, and the
 * revision can't move.
 */
async function generateForGet(ctx: RequestContext): Promise<unknown> {
	const store = requireStore(ctx);
	const request = readGenerateParams(ctx.query);
	checkRequest(request);
	return reportReply(request, await renderReport(ctx, store, request), []);
}

/**
 * A GET's query string read as the POST body it stands for: `type`, `period`, `title` and `format` as
 * themselves, the custom query's fields bare beside them, each through the same Field as the body's.
 * A list field takes `categoryIds=a,b` or `categoryIds=a&categoryIds=b`, as /transactions takes
 * `review`; a value left empty (`period=`) counts as not sent, as it does there.
 *
 * Every parameter is checked before any is read. An unknown one is a 400 naming it, for the reason an
 * unknown body field is — `month=2024-02` for `period` would otherwise give this month's report and
 * look like it had worked. `write` gets its own 400, so the caller is told where writing lives instead of
 * being told the parameter doesn't exist. A single-valued parameter sent twice is a 400 too, rather than
 * quietly taking one of the two.
 */
function readGenerateParams(params: URLSearchParams): GenerateRequest {
	for (const name of new Set(params.keys())) {
		if (name === "write") {
			throw new HttpError(400, "write can't be sent with GET, which never writes — POST with write: true saves the note");
		}
		if (!hasOwn(GET_FIELDS, name) && !hasOwn(QUERY_FIELDS, name)) throw new HttpError(400, `Unknown parameter "${name}"`);
		if (!LIST_PARAMS.includes(name) && params.getAll(name).length > 1) throw new HttpError(400, `${name} can be sent only once`);
	}

	const top: Record<string, unknown> = {};
	for (const name of Object.keys(GET_FIELDS)) {
		const value = params.get(name);
		if (value !== null && value !== "") top[name] = value;
	}
	const fields: Record<string, unknown> = {};
	for (const name of Object.keys(QUERY_FIELDS)) {
		const value = queryParam(params, name);
		if (value !== undefined) fields[name] = value;
	}

	const changes = readFields(top, GET_FIELDS, "create");
	const sent = Object.keys(fields);
	return {
		type: changes.type as ReportType,
		format: (changes.format as ReportFormat | undefined) ?? "markdown",
		period: changes.period as string | undefined,
		title: changes.title as string | undefined,
		query: sent.length > 0 ? (readFields(fields, QUERY_FIELDS, "create") as ReportQuery) : undefined,
		querySentAs: sent[0],
		queryPrefix: "",
	};
}

/**
 * One query field's value as the JSON a body would have carried, for its Field to parse: a list for the
 * list fields, true/false for `includeTransfers` — anything else left a string, so boolean() refuses it
 * in the POST's own words — and a string for the rest. Undefined when it wasn't sent, or was sent empty.
 */
function queryParam(params: URLSearchParams, name: string): unknown {
	if (LIST_PARAMS.includes(name)) {
		const values = params
			.getAll(name)
			.flatMap((v) => v.split(","))
			.map((v) => v.trim())
			.filter((v) => v !== "");
		return values.length > 0 ? values : undefined;
	}
	const value = params.get(name);
	if (value === null || value === "") return undefined;
	if (name === "includeTransfers" && (value === "true" || value === "false")) return value === "true";
	return value;
}

/** What doesn't fit together in a request — the same rules, and the same 400s, whichever method sent it. */
function checkRequest(request: GenerateRequest): void {
	const { type, format, period, querySentAs, queryPrefix } = request;
	const spec = REPORT_TYPES.find((t) => t.type === type)!;
	if (type !== "custom" && querySentAs !== undefined) {
		throw new HttpError(400, `${querySentAs} applies to custom reports only — monthly and yearly reports take a period`);
	}
	if (type !== "custom" && request.title !== undefined) throw new HttpError(400, "title applies to custom reports only");
	if (type === "custom" && period !== undefined) {
		throw new HttpError(400, `A custom report takes its dates as ${queryPrefix}from and ${queryPrefix}to, not period`);
	}
	if (type === "net-worth" && period !== undefined) throw new HttpError(400, "A net-worth report is as of today, so it takes no period");
	if (!(spec.formats as readonly ReportFormat[]).includes(format)) {
		throw new HttpError(400, `A ${type} report comes as ${spec.formats.join(", ")} only — ${format} is for custom reports`);
	}
}

/** The generator both methods share: the report the request asks for, built by the app's own builders. */
async function renderReport(ctx: RequestContext, store: FinanceStore, request: GenerateRequest): Promise<Rendered> {
	const { type, period } = request;
	if (type === "monthly") {
		const month = period ?? currentMonth();
		if (!MONTH.test(month)) throw new HttpError(400, "period must be a month as YYYY-MM for a monthly report");
		return { period: month, name: month, content: buildMonthlyReport(reportContext(ctx, store), month) };
	}
	if (type === "yearly") {
		const year = period ?? String(new Date().getFullYear());
		if (!YEAR.test(year)) throw new HttpError(400, "period must be a year as YYYY for a yearly report");
		return { period: year, name: year, content: buildYearlyReport(reportContext(ctx, store), year) };
	}
	if (type === "net-worth") {
		return { period: "today", name: "Net worth", content: buildNetWorthReport(reportContext(ctx, store)) };
	}
	return customReport(ctx, store, request.query ?? {}, request.title, request.format, request.queryPrefix);
}

function reportReply(request: GenerateRequest, rendered: Rendered, written: string[]): unknown {
	const { extension, contentType } = REPORT_FORMATS[request.format];
	return {
		type: request.type,
		format: request.format,
		period: rendered.period,
		...(rendered.title !== undefined ? { title: rendered.title } : {}),
		fileName: `${rendered.name}.${extension}`,
		contentType,
		content: rendered.content,
		...(rendered.summary ? { summary: rendered.summary } : {}),
		written,
	};
}

/** What the plugin's own reportContext() builds for the commands — the same fields, from the same places. */
function reportContext(ctx: RequestContext, store: FinanceStore): ReportContext {
	return {
		store,
		categories: store.categories,
		baseCurrency: ctx.plugin.settings.baseCurrency,
		generatedAt: new Date().toISOString(),
		pluginVersion: ctx.plugin.manifest.version,
		portfolioName: ctx.plugin.activePortfolio?.name,
		rolloverMode: store.budgeting.rolloverMode ?? "off",
	};
}

/**
 * An id the query names that doesn't exist would quietly narrow the report to nothing — "spent €0 on
 * restaurants" for a category id with a typo in it — so it is a 400 instead, naming the id.
 */
function checkIds(store: FinanceStore, query: ReportQuery, prefix: string): void {
	for (const name of ["categoryIds", "excludeCategoryIds"] as const) {
		for (const id of query[name] ?? []) {
			if (id !== UNCATEGORIZED && !store.categories.some((c) => c.id === id)) {
				throw new HttpError(400, `${prefix}${name}: no category "${id}"`);
			}
		}
	}
	for (const id of query.accountIds ?? []) {
		if (!store.accounts.some((a) => a.id === id)) throw new HttpError(400, `${prefix}accountIds: no account "${id}"`);
	}
	if (query.from && query.to && query.from > query.to) throw new HttpError(400, `${prefix}from must not be after ${prefix}to`);
}

async function customReport(
	ctx: RequestContext,
	store: FinanceStore,
	query: ReportQuery,
	title: string | undefined,
	format: ReportFormat,
	queryPrefix: string
): Promise<Rendered> {
	checkIds(store, query, queryPrefix);
	const source: ReportSource = { transactions: store.transactions, categories: store.categories, accounts: store.accounts, fx: store.fx };
	const result = runReport(source, query);
	const exportCtx: ExportContext = {
		title: title ?? describeQuery(source, query),
		period: describePeriod(query.from, query.to),
		categories: store.categories,
		accounts: store.accounts,
		generatedAt: new Date().toISOString(),
		pluginVersion: ctx.plugin.manifest.version,
		portfolioName: ctx.plugin.activePortfolio?.name,
		filterSummary: filterSummary(store, query, result),
	};

	let content: string;
	if (format === "csv") content = buildReportCsv(result, exportCtx, { delimiter: ctx.plugin.settings.reportCsvDelimiter ?? "," });
	else if (format === "xml") content = buildReportXml(result, exportCtx);
	// No receipts: inlined as data: URIs they would turn one JSON response into megabytes, and the
	// scheduled delivery leaves them out of its HTML for the same reason.
	else if (format === "html") content = buildReportHtml(result, exportCtx);
	// A note embeds receipts by link rather than by content, so it carries them exactly as the Reports
	// page's "Write note" does.
	else content = buildReportMarkdown(result, exportCtx, await collectReportAttachments(ctx.plugin.app, result.rows));

	return {
		period: exportCtx.period,
		name: reportSlug(exportCtx.title),
		title: exportCtx.title,
		content,
		// In cents, as every figure in the content itself is: a sum of amounts carries float noise
		// (64.55000000000001) that a client would otherwise have to know to round away.
		summary: {
			count: result.count,
			spent: cents(result.spent),
			received: cents(result.received),
			net: cents(result.net),
			largest: cents(result.largest),
			months: result.months,
			baseCurrency: result.baseCurrency,
			mixedCurrencies: result.mixedCurrencies,
		},
	};
}

function cents(n: number): number {
	return Math.round(n * 100) / 100;
}

/**
 * The filter chips reprinted as words for the report's header — the same list, in the same words, the
 * Reports page prints (filterSummary in ReportsSection.ts), so a report generated here reads like one
 * exported there.
 */
function filterSummary(store: FinanceStore, query: ReportQuery, result: ReportResult): string[] {
	const categoryName = (id: string): string | undefined => {
		if (id === UNCATEGORIZED) return "Uncategorized";
		const chain = categoryChain(store.categories, id);
		if (!chain.primary) return undefined;
		return chain.secondary ? `${chain.primary.name} › ${chain.secondary.name}` : chain.primary.name;
	};

	const out: string[] = [describePeriod(query.from, query.to)];
	for (const id of query.categoryIds ?? []) {
		const name = categoryName(id);
		if (name) out.push(name);
	}
	for (const id of query.excludeCategoryIds ?? []) {
		const name = categoryName(id);
		if (name) out.push(`Excl. ${name}`);
	}
	for (const id of query.accountIds ?? []) {
		const account = store.accounts.find((a) => a.id === id);
		if (account) out.push(account.name);
	}
	if (query.search?.trim()) out.push(`Text: "${query.search.trim()}"`);
	out.push(query.direction === "in" ? "Money in" : query.direction === "out" ? "Money out" : "Money in and out");
	if (query.includeTransfers) out.push("Transfers included");
	if (result.mixedCurrencies.length > 0) out.push(`Unconverted: ${result.mixedCurrencies.join(", ")}`);
	return out;
}
