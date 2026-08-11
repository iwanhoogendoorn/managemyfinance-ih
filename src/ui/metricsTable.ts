import { microbar } from "./charts";

export function formatEUR(n: number): string {
	return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);
}

export function formatPct(n: number, digits = 0): string {
	return `${n * 100 >= 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`;
}

/** YoY change as a fraction of the (absolute) prior value; undefined when there's no prior year to compare to. */
export function yoy(curr: number, prev: number | undefined): number | undefined {
	if (prev === undefined || prev === 0) return undefined;
	return (curr - prev) / Math.abs(prev);
}

/**
 * @deprecated Superseded by the inline microbar in {@link metricRow}. The old red→amber→green ramp
 * was a rainbow scale with a *hue* at its midpoint (so "average" read as a third state, not as
 * neutral) and its 0.22-alpha pastels went muddy on dark themes. Returns a transparent color so any
 * remaining caller degrades to "no tint" instead of failing to compile.
 */
export function heatColor(_t: number, _invert: boolean): string {
	return "transparent";
}

/**
 * A metric row: one value per year, rendered via `format`. With `heat`, each cell carries a 2px
 * microbar under the number scaled to the row's own maximum — the same "scan a row across years"
 * benefit as the old color scale, but identical in both themes and without tinting the text's own
 * background. `invert` marks rows where a bigger bar is a worse result (expenses), which picks the
 * bar's color; the number itself always stays in normal ink.
 */
export function metricRow(
	tbody: HTMLTableSectionElement,
	label: string,
	values: number[],
	format: (n: number) => string,
	opts?: { emphasize?: boolean; heat?: "normal" | "invert" }
): void {
	const tr = tbody.createEl("tr", { cls: opts?.emphasize ? "fp-table-row-emphasis" : undefined });
	tr.createEl("td", { text: label });
	const peak = Math.max(...values.map((v) => Math.abs(v)), 0);
	const money = format === formatEUR;
	const barColor = opts?.heat === "invert" ? "var(--fp-neg-fill)" : "var(--fp-pos-fill)";
	values.forEach((v) => {
		const cell = tr.createEl("td", { cls: "fp-table-num" });
		// `.fp-money` rides the number, not the cell: privacy redaction paints a block behind its
		// element, and on the `<td>` that block would swallow the microbar too.
		cell.createSpan({ cls: money ? "fp-money" : undefined, text: format(v) });
		if (opts?.heat && peak > 0) microbar(cell, Math.abs(v) / peak, barColor);
	});
}

/** A "Δ YoY" row under a metric row: blank for the first year, a colored % change for the rest. */
export function deltaRow(tbody: HTMLTableSectionElement, values: number[], opts?: { invert?: boolean; label?: string }): void {
	const tr = tbody.createEl("tr", { cls: "fp-table-row-delta" });
	tr.createEl("td", { text: opts?.label ?? "Δ YoY" });
	values.forEach((v, i) => {
		const cell = tr.createEl("td", { cls: "fp-table-num" });
		const change = yoy(v, values[i - 1]);
		if (change === undefined) {
			cell.setText("—");
			return;
		}
		const good = opts?.invert ? change <= 0 : change >= 0;
		cell.addClass(good ? "fp-delta-good" : "fp-delta-bad");
		cell.setText(formatPct(change));
	});
}

/**
 * Builds the `<thead>` for a year-columns metrics table (blank first cell, then one right-aligned
 * year per column). With `onClick`, each year header becomes a button into that year's detail.
 */
export function yearHeaderRow(table: HTMLTableElement, years: string[], opts?: { onClick?: (year: string) => void }): void {
	const thead = table.createEl("thead").createEl("tr");
	thead.createEl("th", { text: "" });
	years.forEach((y) => {
		const th = thead.createEl("th", { cls: "fp-table-num" });
		if (opts?.onClick) {
			// A real <button>, so the drilldown is focusable, announced and keyboard-operable —
			// a click handler on a bare <th> is none of those.
			const onClick = opts.onClick;
			const btn = th.createEl("button", {
				cls: "fp-table-year-clickable",
				text: y,
				attr: { type: "button", "aria-label": `Open ${y} details` },
			});
			btn.addEventListener("click", () => onClick(y));
		} else {
			th.setText(y);
		}
	});
}
