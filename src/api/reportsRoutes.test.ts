import * as crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildReportCsv, buildReportHtml, buildReportXml, type ExportContext } from "../reports/export";
import { buildMonthlyReport, buildNetWorthReport, buildYearlyReport, type ReportContext } from "../reports/markdown";
import { runReport, type ReportQuery } from "../reports/query";
import { REPORT_FORMATS, REPORT_TYPES } from "./reportsRoutes";
import { send, type TestRequest } from "./testPlugin";
import { makeLedgerPlugin, type LedgerFixture } from "./transactionsFixture";

interface Generated {
	type: string;
	format: string;
	period: string;
	title?: string;
	fileName: string;
	contentType: string;
	content: string;
	summary?: { count: number; spent: number; received: number; net: number; baseCurrency: string };
	written: string[];
}

const NOW = new Date("2024-04-15T09:30:00.000Z");

function generate(t: LedgerFixture, body: unknown, extra: Partial<TestRequest> = {}) {
	return send(t, crypto, { method: "POST", path: "/reports/generate", body, ...extra });
}

async function generated(t: LedgerFixture, body: unknown): Promise<Generated> {
	const res = await generate(t, body);
	expect(res.status, JSON.stringify(res.json)).toBe(200);
	return res.json as Generated;
}

/** What main.ts's reportContext() hands the builders, for the fixture plugin at the frozen time. */
function commandContext(t: LedgerFixture): ReportContext {
	return {
		store: t.store,
		categories: t.store.categories,
		baseCurrency: t.settings.baseCurrency,
		generatedAt: NOW.toISOString(),
		pluginVersion: "0.0.0-test",
		portfolioName: "Test portfolio",
		rolloverMode: "off",
	};
}

function vaultFiles(t: LedgerFixture): Map<string, string> {
	return (t.plugin.app.vault.adapter as unknown as { files: Map<string, string> }).files;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("GET /mmf/v1/reports", () => {
	it("lists every report type with the formats it comes in, and the format table", async () => {
		const t = await makeLedgerPlugin();
		const res = await send(t, crypto, { path: "/reports" });
		expect(res.status).toBe(200);
		const body = res.json as { types: { type: string; formats: string[] }[]; formats: { format: string; extension: string }[] };
		expect(body.types.map((x) => [x.type, x.formats])).toEqual([
			["monthly", ["markdown"]],
			["yearly", ["markdown"]],
			["net-worth", ["markdown"]],
			["custom", ["markdown", "csv", "xml", "html"]],
		]);
		expect(body.formats.map((f) => [f.format, f.extension])).toEqual([
			["markdown", "md"],
			["csv", "csv"],
			["xml", "xls"],
			["html", "html"],
		]);
		expect(body).toMatchObject({ queryFields: expect.arrayContaining(["from", "to", "categoryIds", "direction"]) });
	});

	it("needs the token like every other route", async () => {
		const t = await makeLedgerPlugin();
		expect((await send(t, crypto, { path: "/reports", token: null })).status).toBe(401);
	});
});

describe("POST /mmf/v1/reports/generate — fixed reports", () => {
	it("renders a monthly report exactly as the command does, inline, writing nothing", async () => {
		const t = await makeLedgerPlugin();
		const before = new Map(vaultFiles(t));
		const body = await generated(t, { type: "monthly", period: "2024-02" });
		expect(body).toMatchObject({
			type: "monthly",
			format: "markdown",
			period: "2024-02",
			fileName: "2024-02.md",
			contentType: "text/markdown; charset=utf-8",
			written: [],
		});
		expect(body.content).toBe(buildMonthlyReport(commandContext(t), "2024-02"));
		expect(body.content).toContain("# February 2024");
		expect(body).not.toHaveProperty("summary");
		expect(vaultFiles(t)).toEqual(before);
	});

	it("defaults a monthly report to this month and a yearly one to this year, as the commands do", async () => {
		const t = await makeLedgerPlugin();
		expect((await generated(t, { type: "monthly" })).period).toBe("2024-04");
		expect((await generated(t, { type: "yearly" })).period).toBe("2024");
	});

	it("renders a yearly report exactly as the command does", async () => {
		const t = await makeLedgerPlugin();
		const body = await generated(t, { type: "yearly", period: "2024", format: "markdown" });
		expect(body).toMatchObject({ type: "yearly", period: "2024", fileName: "2024.md" });
		expect(body.content).toBe(buildYearlyReport(commandContext(t), "2024"));
	});

	it("renders the net-worth report exactly as the command does", async () => {
		const t = await makeLedgerPlugin();
		const body = await generated(t, { type: "net-worth" });
		expect(body).toMatchObject({ type: "net-worth", period: "today", fileName: "Net worth.md" });
		expect(body.content).toBe(buildNetWorthReport(commandContext(t)));
	});

	it("writes the note where the command would, and reports it as written", async () => {
		const t = await makeLedgerPlugin();
		const revision = (await send(t, crypto, { path: "/health" })).headers["x-mmf-revision"];
		const res = await generate(t, { type: "monthly", period: "2024-02", write: true });
		expect(res.status).toBe(200);
		const body = res.json as Generated;
		expect(body.written).toEqual(["TestFinance/reports/2024-02.md"]);
		expect(vaultFiles(t).get("TestFinance/reports/2024-02.md")).toBe(body.content);
		// A note is not ledger data: the store wrote nothing, so the revision clients poll stays put.
		expect(res.headers["x-mmf-revision"]).toBe(revision);
	});

	it("replaces the note on a second write rather than adding a copy", async () => {
		const t = await makeLedgerPlugin();
		await generate(t, { type: "net-worth", write: true });
		await generate(t, { type: "net-worth", write: true });
		const notes = Array.from(vaultFiles(t).keys()).filter((p) => p.startsWith("TestFinance/reports/"));
		expect(notes).toEqual(["TestFinance/reports/Net worth.md"]);
	});
});

describe("POST /mmf/v1/reports/generate — custom reports", () => {
	const food: ReportQuery = { from: "2024-01-01", to: "2024-12-31", categoryIds: ["cat-food"], direction: "out" };

	/** What the Reports page would hand the export builders for the same query. */
	function exportContext(t: LedgerFixture, title: string, filterSummary: string[]): ExportContext {
		return {
			title,
			period: "2024",
			categories: t.store.categories,
			accounts: t.store.accounts,
			generatedAt: NOW.toISOString(),
			pluginVersion: "0.0.0-test",
			portfolioName: "Test portfolio",
			filterSummary,
		};
	}

	function result(t: LedgerFixture, query: ReportQuery) {
		const store = t.store;
		return runReport({ transactions: store.transactions, categories: store.categories, accounts: store.accounts, fx: store.fx }, query);
	}

	it("runs the query, pulling a primary's subcategories in, and quotes the totals", async () => {
		const t = await makeLedgerPlugin();
		const body = await generated(t, { type: "custom", query: food });
		expect(body).toMatchObject({ type: "custom", format: "markdown", period: "2024", title: "Food · 2024", fileName: "Food - 2024.md" });
		expect(body.summary).toMatchObject({ count: 2, baseCurrency: "EUR" });
		expect(body.summary!.spent).toBe(11.95);
		expect(body.content).toContain("period: custom");
		expect(body.content).toContain("# Food · 2024");
		expect(body.content).toContain("`2024` · `Food` · `Money out`");
	});

	it("renders CSV with the CSV builder and the delimiter set in settings", async () => {
		const t = await makeLedgerPlugin();
		const body = await generated(t, { type: "custom", query: food, format: "csv" });
		expect(body).toMatchObject({ fileName: "Food - 2024.csv", contentType: "text/csv; charset=utf-8" });
		const ctx = exportContext(t, "Food · 2024", ["2024", "Food", "Money out"]);
		expect(body.content).toBe(buildReportCsv(result(t, food), ctx, { delimiter: "," }));
		expect(body.content.split("\n")[0]).toContain("Date,Description");

		t.settings.reportCsvDelimiter = ";";
		const semicolons = await generated(t, { type: "custom", query: food, format: "csv" });
		expect(semicolons.content.split("\n")[0]).toContain("Date;Description");
	});

	it("renders SpreadsheetML for xml, saved as .xls", async () => {
		const t = await makeLedgerPlugin();
		const body = await generated(t, { type: "custom", query: food, format: "xml", title: "Groceries" });
		expect(body).toMatchObject({ title: "Groceries", fileName: "Groceries.xls", contentType: REPORT_FORMATS.xml.contentType });
		expect(body.content).toBe(buildReportXml(result(t, food), exportContext(t, "Groceries", ["2024", "Food", "Money out"])));
		expect(body.content).toContain("<Workbook");
	});

	it("renders the HTML a PDF is printed from", async () => {
		const t = await makeLedgerPlugin();
		const body = await generated(t, { type: "custom", query: food, format: "html" });
		expect(body).toMatchObject({ fileName: "Food - 2024.html", contentType: "text/html; charset=utf-8" });
		expect(body.content).toBe(buildReportHtml(result(t, food), exportContext(t, "Food · 2024", ["2024", "Food", "Money out"])));
	});

	it("quotes the summary in cents, without the float noise of a long sum", async () => {
		const t = await makeLedgerPlugin();
		// -40.1 + -12.5 + -3.2 + -8.75 sums to 64.55000000000001 — the four Food rows once t-01/t-02 are filed.
		for (const id of ["t-01", "t-02"]) await send(t, crypto, { method: "PATCH", path: `/transactions/${id}`, body: { categoryId: "cat-food" } });
		const body = await generated(t, { type: "custom", query: food });
		expect(body.summary).toMatchObject({ count: 4, spent: 64.55, net: -64.55 });
	});

	it("treats an empty query as the whole ledger", async () => {
		const t = await makeLedgerPlugin();
		const body = await generated(t, { type: "custom", format: "csv" });
		expect(body).toMatchObject({ period: "All time", title: "All transactions · All time" });
		expect(body.summary!.count).toBe(result(t, {}).count);
	});

	it("writes a markdown report as a note named after its title", async () => {
		const t = await makeLedgerPlugin();
		const body = await generated(t, { type: "custom", query: food, title: "Food 2024", write: true });
		expect(body.written).toEqual(["TestFinance/reports/Food 2024.md"]);
		expect(vaultFiles(t).get("TestFinance/reports/Food 2024.md")).toBe(body.content);
	});
});

describe("POST /mmf/v1/reports/generate — refused", () => {
	const cases: [string, unknown, string][] = [
		["a body that isn't an object", [], "Expected a JSON object as the request body"],
		["no type", { period: "2024-02" }, "type is required"],
		["an unknown type", { type: "weekly" }, "type must be one of monthly, yearly, net-worth, custom"],
		["an unknown field", { type: "monthly", month: "2024-02" }, 'Unknown field "month"'],
		["an unknown format", { type: "custom", format: "pdf" }, "format must be one of markdown, csv, xml, html"],
		["write that isn't a boolean", { type: "monthly", write: "yes" }, "write must be true or false"],
		["a month that doesn't exist", { type: "monthly", period: "2024-13" }, "period must be a month as YYYY-MM for a monthly report"],
		["a year that isn't one", { type: "yearly", period: "24" }, "period must be a year as YYYY for a yearly report"],
		["a period on net worth", { type: "net-worth", period: "2024" }, "A net-worth report is as of today, so it takes no period"],
		["a period on a custom report", { type: "custom", period: "2024" }, "A custom report takes its dates as query.from and query.to, not period"],
		["a query on a fixed report", { type: "monthly", query: {} }, "query applies to custom reports only — monthly and yearly reports take a period"],
		["a title on a fixed report", { type: "yearly", title: "Mine" }, "title applies to custom reports only"],
		["CSV of a fixed report", { type: "monthly", format: "csv" }, "A monthly report comes as markdown only — csv is for custom reports"],
		["write with a non-markdown format", { type: "custom", format: "csv", write: true }, "write saves the report as a note, so it needs format markdown"],
		["a query that isn't an object", { type: "custom", query: "food" }, "query must be an object"],
		["an unknown query field", { type: "custom", query: { category: "cat-food" } }, 'query: Unknown field "category"'],
		["a query date that doesn't exist", { type: "custom", query: { from: "2024-02-30" } }, "query: from must be a date as YYYY-MM-DD"],
		["from after to", { type: "custom", query: { from: "2024-03-01", to: "2024-02-01" } }, "query.from must not be after query.to"],
		["a bad direction", { type: "custom", query: { direction: "sideways" } }, "query: direction must be one of all, out, in"],
		["an unknown category", { type: "custom", query: { categoryIds: ["cat-nope"] } }, 'query.categoryIds: no category "cat-nope"'],
		["an unknown excluded category", { type: "custom", query: { excludeCategoryIds: ["cat-nope"] } }, 'query.excludeCategoryIds: no category "cat-nope"'],
		["an unknown account", { type: "custom", query: { accountIds: ["acc-nope"] } }, 'query.accountIds: no account "acc-nope"'],
	];

	it.each(cases)("refuses %s with a 400 that says why", async (_name, body, error) => {
		const t = await makeLedgerPlugin();
		const before = new Map(vaultFiles(t));
		const res = await generate(t, body);
		expect(res.status).toBe(400);
		expect(res.json).toEqual({ error });
		expect(vaultFiles(t)).toEqual(before);
	});

	it("accepts the uncategorized pseudo-category", async () => {
		const t = await makeLedgerPlugin();
		const body = await generated(t, { type: "custom", query: { categoryIds: ["__uncategorized"] } });
		expect(body.summary!.count).toBeGreaterThan(0);
	});

	it("is a GET or a POST, so any other method is a 405 that says so", async () => {
		const t = await makeLedgerPlugin();
		const res = await send(t, crypto, { method: "PUT", path: "/reports/generate", body: { type: "net-worth" } });
		expect(res.status).toBe(405);
		expect(res.headers.Allow).toBe("GET, HEAD, POST");
	});

	it("is refused for another device while remote writes are off, like every POST", async () => {
		const t = await makeLedgerPlugin();
		t.settings.apiBind = "tailscale";
		const res = await generate(t, { type: "net-worth" }, { remoteAddress: "100.100.1.2" });
		expect(res.status).toBe(403);
		t.settings.apiAllowRemoteWrites = true;
		expect((await generate(t, { type: "net-worth" }, { remoteAddress: "100.100.1.2" })).status).toBe(200);
	});

	it("keeps the advertised types and the accepted ones in one table", () => {
		expect(REPORT_TYPES.every((t) => t.formats.every((f) => f in REPORT_FORMATS))).toBe(true);
	});
});

describe("GET /mmf/v1/reports/generate — read-only", () => {
	function generateGet(t: LedgerFixture, params: string, extra: Partial<TestRequest> = {}) {
		return send(t, crypto, { path: `/reports/generate?${params}`, ...extra });
	}

	async function generatedGet(t: LedgerFixture, params: string): Promise<Generated> {
		const res = await generateGet(t, params);
		expect(res.status, JSON.stringify(res.json)).toBe(200);
		return res.json as Generated;
	}

	/** Each GET next to the POST body it stands for — the same report, so the same reply, byte for byte. */
	const pairs: [string, string, Record<string, unknown>][] = [
		["a monthly report", "type=monthly&period=2024-02", { type: "monthly", period: "2024-02" }],
		["this month's report", "type=monthly", { type: "monthly" }],
		["a yearly report", "type=yearly&period=2024&format=markdown", { type: "yearly", period: "2024", format: "markdown" }],
		["the net-worth report", "type=net-worth", { type: "net-worth" }],
		[
			"a custom markdown report",
			"type=custom&from=2024-01-01&to=2024-12-31&categoryIds=cat-food&direction=out",
			{ type: "custom", query: { from: "2024-01-01", to: "2024-12-31", categoryIds: ["cat-food"], direction: "out" } },
		],
		[
			"a custom CSV report with a title",
			"type=custom&format=csv&title=Groceries&from=2024-01-01&to=2024-12-31&categoryIds=cat-food",
			{ type: "custom", format: "csv", title: "Groceries", query: { from: "2024-01-01", to: "2024-12-31", categoryIds: ["cat-food"] } },
		],
		[
			"a custom report over every query field",
			"type=custom&format=html&from=2024-01-01&to=2024-03-31&categoryIds=cat-food,cat-rent&excludeCategoryIds=cat-fun" +
				"&accountIds=acc-chk&search=grocer&measure=cash-flow&direction=all&includeTransfers=true",
			{
				type: "custom",
				format: "html",
				query: {
					from: "2024-01-01",
					to: "2024-03-31",
					categoryIds: ["cat-food", "cat-rent"],
					excludeCategoryIds: ["cat-fun"],
					accountIds: ["acc-chk"],
					search: "grocer",
					measure: "cash-flow",
					direction: "all",
					includeTransfers: true,
				},
			},
		],
		["the whole ledger", "type=custom&format=xml", { type: "custom", format: "xml" }],
	];

	it.each(pairs)("gives %s exactly as the POST does", async (_name, params, body) => {
		const t = await makeLedgerPlugin();
		const viaGet = await generatedGet(t, params);
		const viaPost = await generated(t, body);
		expect(viaGet).toEqual(viaPost);
		expect(viaGet.written).toEqual([]);
	});

	it("quotes a custom report's totals as the POST does", async () => {
		const t = await makeLedgerPlugin();
		const body = await generatedGet(t, "type=custom&from=2024-01-01&to=2024-12-31&categoryIds=cat-food&direction=out");
		expect(body).toMatchObject({ type: "custom", period: "2024", title: "Food · 2024", fileName: "Food - 2024.md" });
		expect(body.summary).toMatchObject({ count: 2, spent: 11.95, baseCurrency: "EUR" });
	});

	it("takes a list as repeated parameters or comma-separated, the same either way", async () => {
		const t = await makeLedgerPlugin();
		const repeated = await generatedGet(t, "type=custom&format=csv&categoryIds=cat-food&categoryIds=cat-rent");
		const commas = await generatedGet(t, "type=custom&format=csv&categoryIds=cat-food,%20cat-rent");
		const viaPost = await generated(t, { type: "custom", format: "csv", query: { categoryIds: ["cat-food", "cat-rent"] } });
		expect(repeated).toEqual(viaPost);
		expect(commas).toEqual(viaPost);
	});

	it("reads an empty parameter as one not sent", async () => {
		const t = await makeLedgerPlugin();
		expect(await generatedGet(t, "type=monthly&period=")).toEqual(await generated(t, { type: "monthly" }));
	});

	it("writes nothing: no note, no file, written [] and the revision unchanged", async () => {
		const t = await makeLedgerPlugin();
		const before = new Map(vaultFiles(t));
		const revision = (await send(t, crypto, { path: "/health" })).headers["x-mmf-revision"];
		const storeRevision = t.store.revision;
		for (const params of ["type=monthly&period=2024-02", "type=net-worth", "type=custom&categoryIds=cat-food&title=Food%202024"]) {
			const res = await generateGet(t, params);
			expect(res.status).toBe(200);
			expect((res.json as Generated).written).toEqual([]);
			expect(res.headers["x-mmf-revision"]).toBe(revision);
		}
		expect(vaultFiles(t)).toEqual(before);
		expect(Array.from(vaultFiles(t).keys()).filter((p) => p.startsWith("TestFinance/reports/"))).toEqual([]);
		expect(t.store.revision).toBe(storeRevision);
		expect(t.refreshes()).toBe(0);
	});

	it("is allowed for another device while remote writes are off, where the POST is still refused", async () => {
		const t = await makeLedgerPlugin();
		t.settings.apiBind = "tailscale";
		expect(t.settings.apiAllowRemoteWrites).toBeFalsy();
		const phone = { remoteAddress: "100.100.1.2" };
		const res = await generateGet(t, "type=monthly&period=2024-02", phone);
		expect(res.status).toBe(200);
		expect((res.json as Generated).content).toBe(buildMonthlyReport(commandContext(t), "2024-02"));
		expect((await generate(t, { type: "monthly", period: "2024-02" }, phone)).status).toBe(403);
		// Relayed by `tailscale serve` from loopback, it still counts as another device — and is still a read.
		const relayed = { headers: { "x-forwarded-for": "100.100.1.2" } };
		expect((await generateGet(t, "type=net-worth", relayed)).status).toBe(200);
		expect((await generate(t, { type: "net-worth" }, relayed)).status).toBe(403);
	});

	it("needs the token like every other route", async () => {
		const t = await makeLedgerPlugin();
		expect((await generateGet(t, "type=net-worth", { token: null })).status).toBe(401);
	});

	const refused: [string, string, string][] = [
		["write=true", "type=monthly&write=true", "write can't be sent with GET, which never writes — POST with write: true saves the note"],
		["write=false", "type=monthly&write=false", "write can't be sent with GET, which never writes — POST with write: true saves the note"],
		["an unknown parameter", "type=monthly&month=2024-02", 'Unknown parameter "month"'],
		["query, which a GET sends flat", "type=custom&query=food", 'Unknown parameter "query"'],
		["no type", "period=2024-02", "type is required"],
		["an empty type", "type=", "type is required"],
		["an unknown type", "type=weekly", "type must be one of monthly, yearly, net-worth, custom"],
		["a type sent twice", "type=monthly&type=yearly", "type can be sent only once"],
		["an unknown format", "type=custom&format=pdf", "format must be one of markdown, csv, xml, html"],
		["a month that doesn't exist", "type=monthly&period=2024-13", "period must be a month as YYYY-MM for a monthly report"],
		["a year that isn't one", "type=yearly&period=24", "period must be a year as YYYY for a yearly report"],
		["a period on net worth", "type=net-worth&period=2024", "A net-worth report is as of today, so it takes no period"],
		["a period on a custom report", "type=custom&period=2024", "A custom report takes its dates as from and to, not period"],
		["a query field on a fixed report", "type=monthly&from=2024-01-01", "from applies to custom reports only — monthly and yearly reports take a period"],
		["a title on a fixed report", "type=yearly&title=Mine", "title applies to custom reports only"],
		["CSV of a fixed report", "type=monthly&format=csv", "A monthly report comes as markdown only — csv is for custom reports"],
		["a date that doesn't exist", "type=custom&from=2024-02-30", "from must be a date as YYYY-MM-DD"],
		["from after to", "type=custom&from=2024-03-01&to=2024-02-01", "from must not be after to"],
		["a bad direction", "type=custom&direction=sideways", "direction must be one of all, out, in"],
		["includeTransfers that isn't true or false", "type=custom&includeTransfers=yes", "includeTransfers must be true or false"],
		["an unknown category", "type=custom&categoryIds=cat-food,cat-nope", 'categoryIds: no category "cat-nope"'],
		["an unknown excluded category", "type=custom&excludeCategoryIds=cat-nope", 'excludeCategoryIds: no category "cat-nope"'],
		["an unknown account", "type=custom&accountIds=acc-nope", 'accountIds: no account "acc-nope"'],
	];

	it.each(refused)("refuses %s with a 400 that says why", async (_name, params, error) => {
		const t = await makeLedgerPlugin();
		const before = new Map(vaultFiles(t));
		const res = await generateGet(t, params);
		expect(res.status).toBe(400);
		expect(res.json).toEqual({ error });
		expect(vaultFiles(t)).toEqual(before);
	});
});
