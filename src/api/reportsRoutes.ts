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
 * Generating is a POST because it takes a body and can write, so with "Allow writes from other devices"
 * off it is refused for another device like every other POST — the safe reading of a request that may
 * write into the vault.
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
 * Every report type, as GET /reports lists it — and the table POST /reports/generate validates against,
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

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const YEAR = /^\d{4}$/;

export function register(router: Router): void {
	router.get("/reports", () => ({
		types: REPORT_TYPES,
		formats: FORMATS.map((format) => ({ format, ...REPORT_FORMATS[format] })),
		queryFields: Object.keys(QUERY_FIELDS),
	}));
	router.post("/reports/generate", generateReport);
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
	const type = changes.type as ReportType;
	const format = (changes.format as ReportFormat | undefined) ?? "markdown";
	const write = changes.write === true;
	const period = changes.period as string | undefined;
	const spec = REPORT_TYPES.find((t) => t.type === type)!;

	if (type !== "custom" && changes.query !== undefined) {
		throw new HttpError(400, "query applies to custom reports only — monthly and yearly reports take a period");
	}
	if (type !== "custom" && changes.title !== undefined) throw new HttpError(400, "title applies to custom reports only");
	if (type === "custom" && period !== undefined) throw new HttpError(400, "A custom report takes its dates as query.from and query.to, not period");
	if (type === "net-worth" && period !== undefined) throw new HttpError(400, "A net-worth report is as of today, so it takes no period");
	if (!(spec.formats as readonly ReportFormat[]).includes(format)) {
		throw new HttpError(400, `A ${type} report comes as ${spec.formats.join(", ")} only — ${format} is for custom reports`);
	}
	if (write && format !== "markdown") throw new HttpError(400, "write saves the report as a note, so it needs format markdown");

	let rendered: Rendered;
	if (type === "monthly") {
		const month = period ?? currentMonth();
		if (!MONTH.test(month)) throw new HttpError(400, "period must be a month as YYYY-MM for a monthly report");
		rendered = { period: month, name: month, content: buildMonthlyReport(reportContext(ctx, store), month) };
	} else if (type === "yearly") {
		const year = period ?? String(new Date().getFullYear());
		if (!YEAR.test(year)) throw new HttpError(400, "period must be a year as YYYY for a yearly report");
		rendered = { period: year, name: year, content: buildYearlyReport(reportContext(ctx, store), year) };
	} else if (type === "net-worth") {
		rendered = { period: "today", name: "Net worth", content: buildNetWorthReport(reportContext(ctx, store)) };
	} else {
		rendered = await customReport(ctx, store, (changes.query ?? {}) as ReportQuery, changes.title as string | undefined, format);
	}

	const written = ctx.written();
	if (write) {
		const path = await writeReportNote(ctx.plugin.app, ctx.plugin.settings.dataFolder, rendered.name, rendered.content);
		if (!written.includes(path)) written.push(path);
		// A no-op today — the note went through the vault, not the store, so nothing a view shows has
		// changed — but kept so a write here repaints like every other the moment that stops being true.
		ctx.refresh();
	}

	const { extension, contentType } = REPORT_FORMATS[format];
	return {
		type,
		format,
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
function checkIds(store: FinanceStore, query: ReportQuery): void {
	for (const name of ["categoryIds", "excludeCategoryIds"] as const) {
		for (const id of query[name] ?? []) {
			if (id !== UNCATEGORIZED && !store.categories.some((c) => c.id === id)) throw new HttpError(400, `query.${name}: no category "${id}"`);
		}
	}
	for (const id of query.accountIds ?? []) {
		if (!store.accounts.some((a) => a.id === id)) throw new HttpError(400, `query.accountIds: no account "${id}"`);
	}
	if (query.from && query.to && query.from > query.to) throw new HttpError(400, "query.from must not be after query.to");
}

async function customReport(
	ctx: RequestContext,
	store: FinanceStore,
	query: ReportQuery,
	title: string | undefined,
	format: ReportFormat
): Promise<Rendered> {
	checkIds(store, query);
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
