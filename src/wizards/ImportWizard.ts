import { Notice } from "obsidian";
import { parseCSV } from "../csv";
import { formatMoney } from "../format";
import { applyRules, buildAliasLookup } from "../import/categorize";
import { applyColumnMapping, COLUMN_MAPPING_FIELDS, emptyColumnMapping, guessColumnMapping } from "../import/columnMapping";
import { detectFormat } from "../import/detect";
import { ingAccountIbans, parseIngRows } from "../import/ingParser";
import { parseTradeRepublicRows } from "../import/tradeRepublicParser";
import { extractTransactionTables, DetectedTable } from "../import/xlsxWorkbook";
import type FinancePlugin from "../main";
import { CreateAccountModal } from "../modals/CreateAccountModal";
import { openReviewQueue } from "../modals/ReviewQueueModal";
import { buildUserRule, deriveRulePattern, groupByMerchant, MerchantGroup } from "../reviewQueue";
import { detectRecurring } from "../subscriptionDetect";
import type { CategoryRule, Transaction } from "../types";
import { setLedgerFilter } from "../views/sections/LedgerSection";
import { badge, icon } from "../ui/dom";
import { WizardModal, WizardStep } from "./WizardModal";

const FORMAT_LABEL: Record<DetectedTable["format"], string> = {
	ing: "ING bank",
	"trade-republic": "Trade Republic",
	unknown: "Unrecognized",
};

/** What one merchant group's row in the categorize step decides. */
interface GroupDecision {
	categoryId?: string;
	/** "Remember this merchant" — creates a CategoryRule at import time, not before. */
	makeRule: boolean;
}

/** Where the user chose to go from the summary screen — "none" is the plain Done button. */
export type ImportDestination = "none" | "review" | "subscriptions" | "ledger";

export interface ImportOutcome {
	added: number;
	skipped: number;
	rulesCreated: number;
	/**
	 * Which button ended the wizard. A host that owns the workspace body (first-run setup) has to know
	 * whether the user asked to *go* somewhere before deciding whether to keep showing itself.
	 */
	destination: ImportDestination;
}

export interface ImportWizardOptions {
	/** Fired after a successful import, once the user leaves the summary screen. Awaited before the
	 *  wizard performs its own navigation, so a host can hand the body over first. */
	onDone?: (outcome: ImportOutcome) => void | Promise<void>;
}

/** Bank/broker CSV or Excel import: pick file → detect & preview → review categorization → confirm → summary. */
export function openImportWizard(plugin: FinancePlugin, opts: ImportWizardOptions = {}): void {
	const store = plugin.store;
	/** The store's world as it was when this wizard opened. Switching portfolio re-points the same
	 *  store instance at another folder, and every row parsed here carries *this* portfolio's account
	 *  ids — appending them afterwards files them permanently into the wrong ledger. */
	const openedAtGeneration = store.generation;

	let selectedFile: string | null = null;
	let tables: DetectedTable[] = [];
	// Kept separate on purpose: ING and Trade Republic rows never share a fallback account, so a
	// sheet of one format can never silently borrow whatever account the other format landed on.
	let ingAccountId = store.accounts.find((a) => a.type !== "investing" && a.type !== "crypto")?.id ?? store.accounts[0]?.id ?? "";
	let tradeRepublicAccountId = store.accounts.find((a) => a.type === "investing")?.id ?? store.accounts[0]?.id ?? "";
	let genericAccountId = store.accounts.find((a) => a.type === "saving")?.id ?? store.accounts[0]?.id ?? "";
	let mapping = emptyColumnMapping();
	let ibans: string[] = [];
	let ibanAccountMap = new Map<string, string>();
	let parsed: Transaction[] = [];
	let loadError: string | null = null;

	/** Rows that are genuinely new, and rows the ledger already has. Split at parse time (not on the
	 *  confirm step) so nobody spends a minute categorizing a row that is about to be skipped. */
	let fresh: Transaction[] = [];
	let dupes: Transaction[] = [];
	/** Auto-categorized count, frozen at parse time — the summary's "318 auto-categorized" is about
	 *  what the app did for you, not what you then did by hand. */
	let autoCategorized = 0;
	let reviewGroups: MerchantGroup[] = [];
	const decisions = new Map<string, GroupDecision>();
	/**
	 * Fingerprint of every input the parse depends on. Re-parsing unconditionally (the old `onNext`)
	 * rebuilt `parsed` from scratch, so Categorize → Back → Next silently threw away every manual
	 * category the user had just assigned.
	 */
	let parsedSignature: string | null = null;

	let importResult: { added: number; skipped: number } | null = null;
	let importError: string | null = null;
	let rulesCreated: CategoryRule[] = [];

	function parseSignature(): string {
		return JSON.stringify({
			file: selectedFile,
			tables: tables.map((t) => [t.sheetName, t.format, t.rows.length]),
			mapping,
			ingAccountId,
			tradeRepublicAccountId,
			genericAccountId,
			ibans: [...ibanAccountMap.entries()].sort(),
		});
	}

	function setTables(name: string, newTables: DetectedTable[]): void {
		selectedFile = name;
		tables = newTables;
		const ingTables = tables.filter((t) => t.format === "ing");
		ibans = Array.from(new Set(ingTables.flatMap((t) => ingAccountIbans(t.headers, t.rows))));
		ibanAccountMap = new Map(
			ibans.filter((iban) => store.accounts.some((a) => a.iban === iban)).map((iban) => [iban, store.accounts.find((a) => a.iban === iban)!.id])
		);
	}

	/** The mapping grid is shown (and used) for any table whose columns fit the flat ledger shape —
	 *  every format except Trade Republic, whose action/ticker/shares/price/fee/tax columns don't. Guessed
	 *  from the first such table so a multi-sheet export shares one mapping, same as the parsing step does. */
	function mappableHeaders(): string[] {
		return tables.find((t) => t.format !== "trade-republic")?.headers ?? [];
	}

	function loadCsvText(name: string, text: string): void {
		loadError = null;
		const rows = parseCSV(text);
		const headers = rows[0] ?? [];
		const dataRows = rows.slice(1);
		const format = detectFormat(headers);
		// Unlike xlsx (which just skips unrecognized sheets — a workbook has plenty of other sheets to
		// fall back on), a single unrecognized CSV is kept so the mapping UI below has something to map.
		setTables(name, [{ sheetName: name, format, headers, rows: dataRows }]);
		mapping = guessColumnMapping(mappableHeaders());
	}

	async function loadXlsx(name: string, data: ArrayBuffer): Promise<void> {
		loadError = null;
		try {
			setTables(name, await extractTransactionTables(data));
			mapping = guessColumnMapping(mappableHeaders());
		} catch (err) {
			setTables(name, []);
			loadError = err instanceof Error ? err.message : String(err);
		}
	}

	/** Parses every sheet, applies the rules, then splits new-vs-duplicate and builds the merchant
	 *  groups the categorize step works through. */
	function reparse(): void {
		const categoryLookup = buildAliasLookup(store.categories);
		parsed = [];
		for (const t of tables) {
			if (t.format === "ing") {
				const mappedHeaders = applyColumnMapping(t.headers, mapping);
				parsed.push(
					...parseIngRows(mappedHeaders, t.rows, {
						defaultAccountId: ingAccountId,
						accountByIban: ibanAccountMap,
						categoryLookup,
						debitValues: mapping.debitCredit && mapping.debitValue ? [mapping.debitValue] : undefined,
					})
				);
			} else if (t.format === "trade-republic") {
				parsed.push(...parseTradeRepublicRows(t.headers, t.rows, tradeRepublicAccountId));
			} else if (t.format === "unknown") {
				const mappedHeaders = applyColumnMapping(t.headers, mapping);
				parsed.push(
					...parseIngRows(mappedHeaders, t.rows, {
						defaultAccountId: genericAccountId,
						categoryLookup,
						debitValues: mapping.debitCredit && mapping.debitValue ? [mapping.debitValue] : undefined,
						source: "generic",
					})
				);
			}
		}
		for (const tx of parsed) {
			if (!tx.categoryId) tx.categoryId = applyRules(tx, store.rules);
		}

		const existing = store.existingIds();
		fresh = parsed.filter((t) => !existing.has(t.id));
		dupes = parsed.filter((t) => existing.has(t.id));
		autoCategorized = fresh.filter((t) => !!t.categoryId).length;
		reviewGroups = groupByMerchant(fresh.filter((t) => !t.categoryId));
		decisions.clear();
		for (const group of reviewGroups) {
			// Defaulted on for a repeat merchant: one decision that covers 18 rows is worth remembering,
			// a one-off almost never is.
			decisions.set(group.key, { makeRule: group.transactions.length >= 2 && !!deriveRulePattern(group.transactions) });
		}
		parsedSignature = parseSignature();
	}

	/** Applies the categorize step's decisions to the parsed rows — idempotent, so stepping Back and
	 *  forward through the step re-applies rather than compounds. */
	function applyDecisions(): void {
		for (const group of reviewGroups) {
			const decision = decisions.get(group.key);
			for (const tx of group.transactions) tx.categoryId = decision?.categoryId || undefined;
		}
	}

	function pendingRules(): CategoryRule[] {
		const rules: CategoryRule[] = [];
		for (const group of reviewGroups) {
			const decision = decisions.get(group.key);
			if (!decision?.categoryId || !decision.makeRule) continue;
			const pattern = deriveRulePattern(group.transactions);
			if (!pattern) continue;
			rules.push(buildUserRule(pattern, decision.categoryId));
		}
		return rules;
	}

	function dateRangeLabel(txs: Transaction[]): string {
		const dates = txs.map((t) => t.date).filter(Boolean).sort();
		if (dates.length === 0) return "";
		return dates[0] === dates[dates.length - 1] ? dates[0] : `${dates[0]} – ${dates[dates.length - 1]}`;
	}

	const steps: WizardStep[] = [
		{
			id: "source",
			title: "Source",
			icon: "file-up",
			render: (c, api) => {
				c.createEl("h3", { text: "Pick a file to import" });
				c.createEl("p", {
					cls: "fp-step-desc",
					text: "Drag a CSV or Excel (.xlsx) export here, or click to browse for one.",
				});

				// B1: a wizard that tells you to close it and go elsewhere is a dead end. Zero accounts
				// is fixable right here, and the wizard picks the new account up without reopening.
				if (store.accounts.length === 0) {
					const notice = c.createDiv({ cls: "fp-import-blocker fp-card fp-card--tight" });
					notice.createDiv({ cls: "fp-import-blocker-title", text: "You'll need an account first" });
					notice.createDiv({
						cls: "fp-step-desc",
						text: "Transactions live inside an account — create one now and this import continues where it left off.",
					});
					const createBtn = notice.createEl("button", { cls: "fp-btn fp-btn--primary fp-btn-primary", attr: { type: "button" } });
					icon(createBtn, "plus");
					createBtn.createSpan({ text: "Create an account" });
					createBtn.addEventListener("click", () => {
						new CreateAccountModal(plugin.app, plugin, (account) => {
							ingAccountId ||= account.id;
							tradeRepublicAccountId ||= account.id;
							genericAccountId ||= account.id;
							api.rerender();
						}).open();
					});
				}

				const dropzone = c.createDiv({ cls: "fp-dropzone" + (selectedFile ? " has-file" : "") });
				icon(dropzone, selectedFile ? "file-check-2" : "upload", "fp-dropzone-icon");
				dropzone.createDiv({ cls: "fp-dropzone-text", text: selectedFile ?? "Drop a CSV or Excel file here" });
				dropzone.createDiv({
					cls: "fp-dropzone-subtext",
					text: selectedFile ? "Click, or drop another file, to replace it" : "or click to browse",
				});

				const fileInput = c.createEl("input", { cls: "fp-file-input-hidden", attr: { type: "file", accept: ".csv,.xlsx" } });

				async function handleFile(file: File): Promise<void> {
					if (file.name.toLowerCase().endsWith(".xlsx")) await loadXlsx(file.name, await file.arrayBuffer());
					else loadCsvText(file.name, await file.text());
					api.rerender();
				}

				dropzone.addEventListener("click", () => fileInput.click());
				fileInput.addEventListener("change", async () => {
					const file = fileInput.files?.[0];
					if (file) await handleFile(file);
				});
				dropzone.addEventListener("dragover", (ev) => {
					ev.preventDefault();
					dropzone.addClass("is-dragover");
				});
				dropzone.addEventListener("dragleave", () => dropzone.removeClass("is-dragover"));
				dropzone.addEventListener("drop", async (ev) => {
					ev.preventDefault();
					dropzone.removeClass("is-dragover");
					const file = ev.dataTransfer?.files?.[0];
					if (file) await handleFile(file);
				});

				if (loadError) {
					const errorRow = c.createDiv({ cls: "fp-format-row" });
					badge(errorRow, `Couldn't read "${selectedFile}": ${loadError}`, "bad");
				}
			},
			canGoNext: () => !!selectedFile && store.accounts.length > 0,
		},
		{
			id: "preview",
			title: "Preview",
			icon: "table",
			render: (c) => {
				c.createEl("h3", { text: "Preview & format" });
				const formatRow = c.createDiv({ cls: "fp-format-row" });
				const hasUnknown = tables.some((t) => t.format === "unknown");
				if (tables.length === 0) {
					badge(formatRow, "Couldn't find any data in this file", "bad");
				} else if (hasUnknown) {
					badge(formatRow, "Unrecognized format — map its columns below", "warn");
				} else {
					(["ing", "trade-republic"] as const).forEach((fmt) => {
						const count = tables.filter((t) => t.format === fmt).length;
						if (count > 0) badge(formatRow, `${FORMAT_LABEL[fmt]} — ${count} sheet${count === 1 ? "" : "s"} detected`, "good");
					});
				}

				const hasIng = tables.some((t) => t.format === "ing");
				const hasTradeRepublic = tables.some((t) => t.format === "trade-republic");
				const showMapping = mappableHeaders().length > 0;

				if (hasUnknown) {
					const accountRow = c.createDiv({ cls: "fp-setting-row" });
					accountRow.createSpan({ text: "Import into account: " });
					const accSelect = accountRow.createEl("select");
					store.accounts.forEach((acc) => {
						const opt = accSelect.createEl("option", { text: acc.name, value: acc.id });
						if (acc.id === genericAccountId) opt.selected = true;
					});
					accSelect.addEventListener("change", () => (genericAccountId = accSelect.value));
				}

				if (showMapping) {
					c.createEl("p", {
						cls: "fp-step-desc",
						text: hasUnknown
							? "We didn't recognize this file's columns — pick which of your file's columns holds each piece of data. Date, Description, and Amount are required; everything else is optional."
							: "Column mapping (auto-detected) — review or override which column holds each piece of data before importing.",
					});

					const mapGrid = c.createDiv({ cls: "fp-column-mapping-grid" });
					const headers = mappableHeaders();
					COLUMN_MAPPING_FIELDS.forEach((field) => {
						const row = mapGrid.createDiv({ cls: "fp-form-row" });
						row.createEl("label", { text: field.label });
						const select = row.createEl("select");
						select.createEl("option", { text: "— none —", value: "" });
						headers.forEach((h) => {
							const opt = select.createEl("option", { text: h, value: h });
							if (mapping[field.key] === h) opt.selected = true;
						});
						select.addEventListener("change", () => (mapping[field.key] = select.value));
					});
					const dvRow = mapGrid.createDiv({ cls: "fp-form-row" });
					dvRow.createEl("label", { text: "Value that means \"money out\" (only used if Debit/Credit is mapped)" });
					const dvInput = dvRow.createEl("input", { type: "text", attr: { placeholder: "e.g. Debit, DR, -" } });
					dvInput.value = mapping.debitValue;
					dvInput.addEventListener("input", () => (mapping.debitValue = dvInput.value));
				}

				if (hasIng) {
					if (ibans.length > 1) {
						c.createEl("p", {
							cls: "fp-step-desc",
							text: "This export covers multiple ING accounts — map each IBAN to one of your Finance accounts.",
						});
						const mapWrap = c.createDiv({ cls: "fp-iban-map" });
						ibans.forEach((iban) => {
							const row = mapWrap.createDiv({ cls: "fp-setting-row" });
							row.createSpan({ text: iban, cls: "fp-iban-label" });
							const select = row.createEl("select");
							select.createEl("option", { text: "Choose account…", value: "" });
							store.accounts.forEach((acc) => {
								const opt = select.createEl("option", { text: acc.name, value: acc.id });
								if (ibanAccountMap.get(iban) === acc.id) opt.selected = true;
							});
							select.addEventListener("change", () => {
								if (select.value) ibanAccountMap.set(iban, select.value);
								else ibanAccountMap.delete(iban);
							});
						});
						c.createEl("p", {
							cls: "fp-step-desc",
							text: "Don't see an account? Add it (with its IBAN) from the sidebar, then come back to this step.",
						});
					} else {
						const accountRow = c.createDiv({ cls: "fp-setting-row" });
						accountRow.createSpan({ text: "ING account: " });
						const select = accountRow.createEl("select");
						store.accounts.forEach((acc) => {
							const opt = select.createEl("option", { text: acc.name, value: acc.id });
							if (acc.id === ingAccountId) opt.selected = true;
						});
						if (ibans.length === 1 && ibanAccountMap.has(ibans[0])) {
							ingAccountId = ibanAccountMap.get(ibans[0])!;
							select.value = ingAccountId;
						}
						select.addEventListener("change", () => (ingAccountId = select.value));
					}
				}

				if (hasTradeRepublic) {
					const trRow = c.createDiv({ cls: "fp-setting-row" });
					trRow.createSpan({ text: "Trade Republic account: " });
					const trSelect = trRow.createEl("select");
					store.accounts.forEach((acc) => {
						const opt = trSelect.createEl("option", { text: acc.name, value: acc.id });
						if (acc.id === tradeRepublicAccountId) opt.selected = true;
					});
					trSelect.addEventListener("change", () => (tradeRepublicAccountId = trSelect.value));
				}

				const totalRows = tables.reduce((sum, t) => sum + t.rows.length, 0);
				tables.forEach((t) => {
					c.createEl("h4", { text: `${t.sheetName} — ${FORMAT_LABEL[t.format]} (${t.rows.length} rows)` });
					const table = c.createEl("table", { cls: "fp-preview-table" });
					const thead = table.createEl("thead").createEl("tr");
					t.headers.forEach((h) => thead.createEl("th", { text: h }));
					const tbody = table.createEl("tbody");
					t.rows.slice(0, 4).forEach((r) => {
						const tr = tbody.createEl("tr");
						r.forEach((cell) => tr.createEl("td", { text: cell }));
					});
				});
				if (tables.length > 0) {
					c.createEl("p", { cls: "fp-step-desc", text: `${totalRows} rows found across ${tables.length} sheet${tables.length === 1 ? "" : "s"}.` });
				}
			},
			canGoNext: () => {
				if (tables.length === 0) return false;
				const mappingOk = mappableHeaders().length === 0 || (!!mapping.date && !!mapping.description && !!mapping.amount);
				const genericOk = !tables.some((t) => t.format === "unknown") || !!genericAccountId;
				const ingOk = !tables.some((t) => t.format === "ing") || (ibans.length > 1 ? ibans.every((i) => ibanAccountMap.has(i)) : !!ingAccountId);
				const trOk = !tables.some((t) => t.format === "trade-republic") || !!tradeRepublicAccountId;
				return mappingOk && genericOk && ingOk && trOk;
			},
			onNext: () => {
				// Only re-parse when something the parse actually depends on changed — otherwise
				// stepping Back to check a column mapping would wipe the work done on the next step.
				if (parsedSignature !== parseSignature()) reparse();
			},
		},
		{
			id: "review",
			title: "Categorize",
			icon: "tags",
			render: (c, api) => {
				c.createEl("h3", { text: "Review categorization" });

				const needCount = reviewGroups.reduce((sum, g) => sum + g.transactions.length, 0);
				c.createEl("p", {
					cls: "fp-step-desc",
					text:
						`${autoCategorized} auto-categorized · ${needCount} need a category, across ${reviewGroups.length} merchant${reviewGroups.length === 1 ? "" : "s"}` +
						(dupes.length > 0 ? ` · ${dupes.length} duplicate${dupes.length === 1 ? "" : "s"} already excluded` : ""),
				});

				if (reviewGroups.length === 0) {
					// `fresh.length === 0` has two causes, and they are opposites: every row was a
					// duplicate, or there were no rows at all. A header-only file used to be reported as
					// "every row is already in your ledger", which sends the user looking for rows that
					// were never read.
					c.createEl("p", {
						cls: "fp-step-desc",
						text:
							parsed.length === 0
								? "No rows could be read from this file — check the column mapping on the previous step."
								: fresh.length === 0
									? "Nothing new in this file — every row is already in your ledger."
									: "Everything in this file already has a category. Nothing to do here.",
					});
					return;
				}

				const list = c.createDiv({ cls: "fp-merchant-list" });
				reviewGroups.forEach((group) => {
					const decision = decisions.get(group.key)!;
					const pattern = deriveRulePattern(group.transactions);
					const card = list.createDiv({ cls: "fp-merchant-card fp-card fp-card--tight" });

					const top = card.createDiv({ cls: "fp-merchant-top" });
					top.createDiv({ cls: "fp-merchant-name fp-sensitive", text: group.displayName });
					const stats = top.createDiv({ cls: "fp-merchant-stats" });
					stats.createSpan({ text: `${group.transactions.length} txn${group.transactions.length === 1 ? "" : "s"} · ` });
					stats.createSpan({ cls: "fp-money", text: formatMoney(group.total) });
					card.createDiv({
						cls: "fp-merchant-range",
						text: dateRangeLabel(group.transactions),
					});

					const controls = card.createDiv({ cls: "fp-merchant-controls" });
					const select = controls.createEl("select", { cls: "fp-select" });
					select.createEl("option", { text: "Uncategorized", value: "" });
					store.categories.forEach((cat) => {
						const opt = select.createEl("option", { text: cat.name, value: cat.id });
						if (cat.id === decision.categoryId) opt.selected = true;
					});
					select.addEventListener("change", () => (decision.categoryId = select.value || undefined));

					const ruleLabel = controls.createEl("label", { cls: "fp-merchant-rule" });
					const check = ruleLabel.createEl("input", { type: "checkbox" });
					check.checked = decision.makeRule && !!pattern;
					check.disabled = !pattern;
					check.addEventListener("change", () => (decision.makeRule = check.checked));
					ruleLabel.createSpan({
						text: pattern ? `Remember "${pattern}"` : "Too varied to remember",
						attr: {
							title: pattern
								? `Future imports matching "${pattern}" get this category automatically.`
								: "These rows don't share enough text to build a rule that would reliably fire.",
						},
					});
				});

				const skipRow = c.createDiv({ cls: "fp-merchant-skip" });
				const skipBtn = skipRow.createEl("button", { cls: "fp-btn fp-btn--ghost fp-btn-ghost", text: "Skip the rest →", attr: { type: "button" } });
				skipBtn.addEventListener("click", () => api.next());
			},
			onNext: () => applyDecisions(),
		},
		{
			id: "confirm",
			title: "Import",
			icon: "check-circle-2",
			render: (c) => {
				c.createEl("h3", { text: "Ready to import" });
				const stats = c.createDiv({ cls: "fp-import-stats" });
				stats.createDiv({ cls: "fp-import-stat", text: `${parsed.length} rows parsed` });
				stats.createDiv({ cls: "fp-import-stat", text: `${fresh.length} new` });
				stats.createDiv({ cls: "fp-import-stat", text: `${dupes.length} duplicate — will be skipped` });

				const rules = pendingRules();
				if (rules.length > 0) {
					c.createEl("p", {
						cls: "fp-step-desc",
						text: `${rules.length} merchant rule${rules.length === 1 ? "" : "s"} will be saved, so these merchants categorize themselves next time.`,
					});
				}

				if (dupes.length > 0) {
					// The id hashes accountId|date|amount|description|counterparty, so two genuinely
					// identical same-day purchases collapse into one. The user deserves to see which.
					const details = c.createEl("details", { cls: "fp-dupe-details" });
					details.createEl("summary", { text: `${dupes.length} duplicate${dupes.length === 1 ? "" : "s"} — show` });
					details.createEl("p", {
						cls: "fp-step-desc",
						text: "Already in your ledger, matched on account, date, amount and description. Two identical same-day purchases look like one row here.",
					});
					const wrap = details.createDiv({ cls: "fp-table-scroll" });
					const table = wrap.createEl("table", { cls: "fp-table fp-table--dense" });
					const head = table.createEl("thead").createEl("tr");
					["Date", "Description", "Amount"].forEach((h) => head.createEl("th", { text: h }));
					const tbody = table.createEl("tbody");
					dupes.slice(0, 100).forEach((tx) => {
						const tr = tbody.createEl("tr");
						tr.createEl("td", { text: tx.date });
						tr.createEl("td", { cls: "fp-sensitive", text: tx.description });
						tr.createEl("td", { cls: "fp-table-num" }).createSpan({ cls: "fp-money", text: formatMoney(tx.amount, tx.currency || "EUR") });
					});
					if (dupes.length > 100) {
						details.createEl("p", { cls: "fp-step-desc", text: `+ ${dupes.length - 100} more not listed.` });
					}
				}
			},
			nextLabel: "Import",
			onNext: async () => {
				importError = null;
				rulesCreated = [];
				if (store.generation !== openedAtGeneration) {
					// Belt and braces: `switchPortfolio` closes open dialogs before reloading, so this
					// only fires for a wizard that outran that (or was opened mid-switch).
					importError = "Portfolio changed — reopen this dialog and import again.";
					new Notice("Portfolio changed — reopen this dialog");
					return;
				}
				try {
					const rules = pendingRules().filter((rule) => !store.rules.some((r) => r.pattern === rule.pattern && r.categoryId === rule.categoryId));
					if (rules.length > 0) {
						store.rules.push(...rules);
						await store.saveRules();
						rulesCreated = rules;
					}
					importResult = await store.importTransactions(parsed);
					new Notice(`Imported ${importResult.added} new transactions (${importResult.skipped} duplicates skipped)`);
				} catch (err) {
					importError = err instanceof Error ? err.message : String(err);
				}
				plugin.refreshViews();
			},
		},
		{
			id: "done",
			title: "Done",
			icon: "party-popper",
			hidden: true,
			hideBack: true,
			hideNext: true,
			render: (c, api) => {
				if (importError) {
					c.createEl("h3", { text: "The import didn't finish" });
					const errRow = c.createDiv({ cls: "fp-format-row" });
					badge(errRow, importError, "bad");
					c.createEl("p", {
						cls: "fp-step-desc",
						text: `Nothing was lost — your ledger files live under "${plugin.settings.dataFolder}/data/ledger". Fix whatever the message points at and run the import again.`,
					});
					const footer = c.createDiv({ cls: "fp-wizard-footer" });
					const right = footer.createDiv({ cls: "fp-wizard-footer-right" });
					const close = right.createEl("button", { cls: "fp-btn fp-btn--primary fp-btn-primary", text: "Close", attr: { type: "button" } });
					close.addEventListener("click", () => api.close());
					return;
				}

				const result = importResult ?? { added: 0, skipped: 0 };
				// The rows that actually landed: `fresh` minus any id the file itself repeated (the
				// store keeps the first and counts the rest as skipped).
				const seenIds = new Set<string>();
				const imported = fresh.filter((t) => (seenIds.has(t.id) ? false : (seenIds.add(t.id), true)));
				const accountNames = Array.from(new Set(imported.map((t) => store.accounts.find((a) => a.id === t.accountId)?.name).filter(Boolean)));
				const needCategory = imported.filter((t) => !t.categoryId).length;

				c.createEl("h3", {
					text: accountNames.length === 1 ? `Imported into ${accountNames[0]}` : "Import complete",
				});

				if (result.added === 0 && result.skipped > 0) {
					c.createEl("p", {
						cls: "fp-step-desc",
						text: `Nothing new — all ${result.skipped} row${result.skipped === 1 ? "" : "s"} were already in your ledger.`,
					});
				} else if (result.added === 0) {
					c.createEl("p", { cls: "fp-step-desc", text: "No rows could be read from this file." });
				}

				const candidates = detectRecurring(store, store.subscriptions, plugin.settings.dismissedSubscriptionKeys ?? []);

				const statRow = c.createDiv({ cls: "fp-done-stats" });
				const stat = (value: string, label: string, tone?: string): void => {
					const cell = statRow.createDiv({ cls: "fp-done-stat" + (tone ? ` fp-tone-${tone}` : "") });
					cell.createDiv({ cls: "fp-done-stat-value", text: value });
					cell.createDiv({ cls: "fp-done-stat-label", text: label });
				};
				stat(String(result.added), "added");
				stat(String(result.skipped), "duplicates skipped");
				stat(String(autoCategorized), "auto-categorized");
				stat(String(needCategory), needCategory === 1 ? "needs a category" : "need a category", needCategory > 0 ? "warn" : undefined);
				if (candidates.length > 0) stat(String(candidates.length), "possible subscriptions");
				if (rulesCreated.length > 0) stat(String(rulesCreated.length), rulesCreated.length === 1 ? "rule created" : "rules created", "good");

				const range = dateRangeLabel(imported);
				if (range) {
					c.createEl("p", { cls: "fp-step-desc", text: `Covers ${range} · ${reviewGroups.length} merchant${reviewGroups.length === 1 ? "" : "s"} reviewed.` });
				}

				const footer = c.createDiv({ cls: "fp-wizard-footer" });
				const left = footer.createDiv({ cls: "fp-wizard-footer-left" });
				const right = footer.createDiv({ cls: "fp-wizard-footer-right" });

				/** Awaited before navigating: a host that owns the workspace body (first-run setup) has
				 *  to release it first, or the destination is painted over by the host's own screen. */
				const finishWith = async (destination: ImportDestination): Promise<void> => {
					api.close();
					await opts.onDone?.({ added: result.added, skipped: result.skipped, rulesCreated: rulesCreated.length, destination });
				};

				if (needCategory > 0) {
					const review = left.createEl("button", { cls: "fp-btn fp-btn--primary fp-btn-primary", attr: { type: "button" } });
					icon(review, "tags");
					review.createSpan({ text: `Review ${needCategory} uncategorized` });
					review.addEventListener("click", async () => {
						const ids = new Set(imported.filter((t) => !t.categoryId).map((t) => t.id));
						await finishWith("review");
						openReviewQueue(plugin, { transactionIds: ids, title: "Review this import" });
					});
				}

				if (candidates.length > 0) {
					const subs = left.createEl("button", { cls: "fp-btn fp-btn--secondary fp-btn-secondary", attr: { type: "button" } });
					icon(subs, "repeat");
					subs.createSpan({ text: `${candidates.length} possible subscriptions` });
					subs.addEventListener("click", async () => {
						await finishWith("subscriptions");
						plugin.settings.activeView = "subscriptions";
						await plugin.saveSettings();
						await plugin.activateView();
						plugin.refreshViews();
					});
				}

				// When everything in the file was a duplicate, `imported` is empty — the button used to
				// set no account and no date filter, so it re-rendered whatever page you were already on
				// (nothing at all, on All Accounts). The duplicates name the account and the range just
				// as well, and that is exactly where the user wanted to look.
				const ledgerRows = imported.length > 0 ? imported : dupes;
				if (ledgerRows.length > 0) {
					const ledger = right.createEl("button", { cls: "fp-btn fp-btn--ghost fp-btn-ghost", text: "Go to ledger", attr: { type: "button" } });
					ledger.addEventListener("click", async () => {
						const accountId = ledgerRows[0]?.accountId;
						await finishWith("ledger");
						// Scope the ledger to exactly what this import covered, so "go to ledger" lands
						// on the new rows instead of the full history.
						const dates = ledgerRows.map((t) => t.date).filter(Boolean).sort();
						if (dates.length > 0) setLedgerFilter({ dateFrom: dates[0], dateTo: dates[dates.length - 1] });
						if (accountId) {
							plugin.settings.activeAccountId = accountId;
							plugin.settings.activeView = undefined;
							await plugin.saveSettings();
						}
						await plugin.activateView();
						plugin.refreshViews();
					});
				}

				const done = right.createEl("button", { cls: "fp-btn fp-btn--primary fp-btn-primary", text: "Done", attr: { type: "button" } });
				done.addEventListener("click", () => void finishWith("none"));
			},
		},
	];

	new WizardModal(plugin.app, {
		title: "Import transactions",
		subtitle: "Bring in a bank or broker export without re-typing anything.",
		icon: "download",
		steps,
	}).open();
}
