import { setIcon } from "obsidian";

export interface ChartSeries {
	label: string;
	color: string;
	values: number[];
}

const NS = "http://www.w3.org/2000/svg";

/* Unique-per-instance ids for <linearGradient>/<title>/<desc>: several charts share one document,
   so `url(#grad)` and aria-labelledby would otherwise resolve to whichever chart drew first. */
let uidCounter = 0;
function nextId(prefix: string): string {
	uidCounter += 1;
	return `fp-${prefix}-${uidCounter}`;
}

function svgEl<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
	return document.createElementNS(NS, name);
}

/** Local copy of ui/dom's `icon()`. charts.ts must NOT import dom.ts — dom.ts now imports
 *  `sparkline` from here for the unified stat component, and a cycle would follow. */
function chartIcon(parent: HTMLElement, name: string, cls?: string): HTMLElement {
	const span = parent.createSpan({ cls: ["fp-icon", cls].filter(Boolean).join(" ") });
	setIcon(span, name);
	return span;
}

function formatCompact(n: number): string {
	const abs = Math.abs(n);
	if (abs >= 1000) return `${n < 0 ? "-" : ""}${(abs / 1000).toFixed(abs >= 10000 ? 0 : 1)}k`;
	return String(Math.round(n));
}

const EUR = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

function niceTicks(min: number, max: number, count = 4): number[] {
	if (min === max) return [min];
	const span = max - min;
	const rawStep = span / count;
	const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
	const norm = rawStep / mag;
	const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
	const start = Math.ceil(min / step) * step;
	const ticks: number[] = [];
	for (let v = start; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 100) / 100);
	return ticks;
}

/** Width estimate for chart text. Real measurement needs a laid-out node, and we size the padding
 *  *before* drawing anything — this per-character approximation for the 10–11px UI font is within a
 *  couple of pixels and costs no layout thrash. */
function textWidth(s: string, fontSize = 10): number {
	return s.length * fontSize * 0.62;
}

/* ==========================================================================
   Rule 1 — render in CSS pixels, never scale the viewBox
   ========================================================================== */

export interface ResponsiveChartOpts {
	/** Fixed pixel height. When omitted the height follows `ratio`, clamped to [minHeight, maxHeight]. */
	height?: number;
	ratio?: number;
	minHeight?: number;
	maxHeight?: number;
	minWidth?: number;
}

/**
 * Draws `host`'s contents at the container's real pixel size and redraws on resize, so a 10px axis
 * label is 10px at every pane width and a 2px stroke is 2px — the single biggest reason hand-rolled
 * SVG reads as amateur is letting CSS scale a fixed viewBox.
 *
 * Sections rebuild their DOM with `.empty()` and never call the returned disposer, so the observer
 * self-disconnects as soon as its host leaves the document rather than leaking one per re-render.
 */
export function mountResponsiveChart(
	host: HTMLElement,
	draw: (width: number, height: number) => void,
	opts?: ResponsiveChartOpts
): () => void {
	const minWidth = opts?.minWidth ?? 240;
	const ratio = opts?.ratio ?? 0.42;
	const minHeight = opts?.minHeight ?? 180;
	const maxHeight = opts?.maxHeight ?? 320;

	let raf = 0;
	let lastWidth = -1;
	const dispose = () => {
		if (raf) cancelAnimationFrame(raf);
		raf = 0;
		ro.disconnect();
	};

	const ro = new ResizeObserver((entries) => {
		if (!host.isConnected) {
			dispose();
			return;
		}
		const observed = Math.round(entries[0].contentRect.width);
		// 0 means a hidden tab panel (tabSwitcher renders every panel eagerly). RO fires again the
		// moment it is shown, so skipping here costs nothing and avoids drawing a degenerate chart.
		if (observed <= 0 || observed === lastWidth) return;
		lastWidth = observed;
		if (raf) cancelAnimationFrame(raf);
		raf = requestAnimationFrame(() => {
			raf = 0;
			const width = Math.max(minWidth, observed);
			const height = opts?.height ?? Math.round(Math.min(maxHeight, Math.max(minHeight, width * ratio)));
			draw(width, height);
		});
	});
	ro.observe(host);
	return dispose;
}

/* ==========================================================================
   Rule 3 — monotone cubic smoothing
   ========================================================================== */

/**
 * Monotone cubic interpolation — smooth, and provably never overshoots the data. Catmull-Rom would
 * draw a savings line dipping below a value it never had, which is unacceptable in a finance chart.
 */
export function monotonePath(pts: { x: number; y: number }[]): string {
	const n = pts.length;
	if (n < 2) return "";
	if (n === 2) return `M${pts[0].x},${pts[0].y}L${pts[1].x},${pts[1].y}`;

	const dx: number[] = [];
	const dy: number[] = [];
	const m: number[] = [];
	for (let i = 0; i < n - 1; i++) {
		dx[i] = pts[i + 1].x - pts[i].x;
		dy[i] = pts[i + 1].y - pts[i].y;
		m[i] = dy[i] / dx[i];
	}
	const t: number[] = [m[0]];
	for (let i = 1; i < n - 1; i++) {
		if (m[i - 1] * m[i] <= 0) {
			t[i] = 0; // local extremum — flatten so the curve cannot overshoot
		} else {
			const w1 = 2 * dx[i] + dx[i - 1];
			const w2 = dx[i] + 2 * dx[i - 1];
			t[i] = (w1 + w2) / (w1 / m[i - 1] + w2 / m[i]); // weighted harmonic mean
		}
	}
	t[n - 1] = m[n - 2];

	let d = `M${pts[0].x},${pts[0].y}`;
	for (let i = 0; i < n - 1; i++) {
		const h = dx[i] / 3;
		d +=
			`C${pts[i].x + h},${pts[i].y + t[i] * h}` +
			` ${pts[i + 1].x - h},${pts[i + 1].y - t[i + 1] * h}` +
			` ${pts[i + 1].x},${pts[i + 1].y}`;
	}
	return d;
}

function polyPath(pts: { x: number; y: number }[]): string {
	if (pts.length === 0) return "";
	return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join("");
}

/* ==========================================================================
   Rule 7 — column geometry: square at the baseline, rounded at the data end
   ========================================================================== */

/** A bar path with only its top two corners rounded, so the baseline stays optically flat. */
export function roundedTopBar(x: number, y: number, w: number, h: number, r: number): string {
	const rr = Math.max(0, Math.min(r, w / 2, h));
	return (
		`M${x},${y + h}V${y + rr}A${rr},${rr} 0 0 1 ${x + rr},${y}` +
		`H${x + w - rr}A${rr},${rr} 0 0 1 ${x + w},${y + rr}V${y + h}Z`
	);
}

/* ==========================================================================
   Rule 10 — accessibility helpers
   ========================================================================== */

/** Gives an `<svg>` the role/title/desc trio so a screen reader announces the chart rather than
 *  a soup of unlabelled shapes. */
function describeSvg(svg: SVGSVGElement, title: string, desc: string): void {
	const titleId = nextId("t");
	const descId = nextId("d");
	svg.setAttribute("role", "img");
	svg.setAttribute("aria-labelledby", `${titleId} ${descId}`);
	const titleEl = svgEl("title");
	titleEl.id = titleId;
	titleEl.textContent = title;
	const descEl = svgEl("desc");
	descEl.id = descId;
	descEl.textContent = desc;
	svg.append(titleEl, descEl);
}

/**
 * Chart / Table view toggle for a chart card. Returns both panels; the caller fills them. Every
 * chart in the app should offer the table, which is also the relief valve for the categorical
 * slots that sit below 3:1 against the surface.
 */
export function chartTableToggle(
	container: HTMLElement,
	opts?: { chartLabel?: string; tableLabel?: string }
): { chartPanel: HTMLElement; tablePanel: HTMLElement; toggleEl: HTMLElement } {
	const toggleEl = container.createDiv({ cls: "fp-view-toggle", attr: { role: "tablist" } });
	const chartPanel = container.createDiv({ cls: "fp-view-panel" });
	const tablePanel = container.createDiv({ cls: "fp-view-panel is-hidden" });

	const mk = (label: string, active: boolean) =>
		toggleEl.createEl("button", {
			cls: "fp-view-toggle-btn" + (active ? " is-active" : ""),
			text: label,
			attr: { type: "button", role: "tab", "aria-selected": String(active) },
		});

	const chartBtn = mk(opts?.chartLabel ?? "Chart", true);
	const tableBtn = mk(opts?.tableLabel ?? "Table", false);

	const select = (btn: HTMLElement, panel: HTMLElement, otherBtn: HTMLElement, otherPanel: HTMLElement) => {
		btn.addClass("is-active");
		btn.setAttribute("aria-selected", "true");
		otherBtn.removeClass("is-active");
		otherBtn.setAttribute("aria-selected", "false");
		panel.removeClass("is-hidden");
		otherPanel.addClass("is-hidden");
	};
	chartBtn.addEventListener("click", () => select(chartBtn, chartPanel, tableBtn, tablePanel));
	tableBtn.addEventListener("click", () => select(tableBtn, tablePanel, chartBtn, chartPanel));

	return { chartPanel, tablePanel, toggleEl };
}

/* ==========================================================================
   Line chart
   ========================================================================== */

export interface LineChartOpts {
	height?: number;
	formatValue?: (n: number) => string;
	money?: boolean;
	/** Smooth continuous series (balances, net worth). Defaults on from 8 categories. */
	smooth?: boolean;
	/** Area gradient under the line — single-series charts only (overlapping washes turn to mud). */
	area?: boolean;
	title?: string;
	description?: string;
}

/**
 * Multi-series line chart rendered at the container's real pixel size: hairline gridlines that
 * recede, monotone-smoothed lines, selective markers (last point + the focus series' min/max),
 * leader-line end labels that stay attached to their line, a toggleable legend, and a crosshair
 * tooltip that tracks the hovered point. Colors arrive as CSS variables so light/dark stay in sync.
 */
export function lineChart(container: HTMLElement, categories: string[], series: ChartSeries[], opts?: LineChartOpts): void {
	const money = opts?.money !== false;
	const formatValue = opts?.formatValue ?? ((n: number) => EUR.format(n));
	const formatTick = opts?.formatValue ?? formatCompact;
	const smooth = opts?.smooth ?? categories.length >= 8;

	const wrap = container.createDiv({ cls: "fp-chart" + (money ? " fp-chart-money" : "") });
	const hidden = new Set<number>();

	// Legend first: it is also the isolate control, and it must exist before the first draw so the
	// plot can read `hidden`.
	let legend: HTMLElement | undefined;
	if (series.length >= 2) {
		legend = wrap.createDiv({ cls: "fp-chart-legend" });
		series.forEach((s, i) => {
			const item = legend!.createEl("button", {
				cls: "fp-chart-legend-item",
				attr: { type: "button", "aria-pressed": "true", title: `Toggle ${s.label}` },
			});
			const key = item.createSpan({ cls: "fp-chart-key fp-chart-key--line fp-chart-swatch" });
			key.style.setProperty("--fp-key", s.color);
			key.style.setProperty("--fp-swatch-color", s.color);
			item.createSpan({ text: s.label });
			item.addEventListener("click", () => {
				if (hidden.has(i)) hidden.delete(i);
				else if (hidden.size < series.length - 1) hidden.add(i);
				item.setAttribute("aria-pressed", String(!hidden.has(i)));
				redraw();
			});
		});
	}

	const plot = wrap.createDiv({ cls: "fp-chart-plot" });
	let lastSize: { w: number; h: number } | undefined;
	const redraw = () => {
		if (lastSize) drawLineChart(plot, categories, series, hidden, lastSize.w, lastSize.h, { formatValue, formatTick, smooth, area: !!opts?.area, title: opts?.title, description: opts?.description });
	};

	mountResponsiveChart(
		plot,
		(w, h) => {
			lastSize = { w, h };
			redraw();
		},
		{ height: opts?.height, minHeight: 180, maxHeight: 320 }
	);
}

interface DrawOpts {
	formatValue: (n: number) => string;
	formatTick: (n: number) => string;
	smooth: boolean;
	area: boolean;
	title?: string;
	description?: string;
}

function drawLineChart(
	plot: HTMLElement,
	categories: string[],
	series: ChartSeries[],
	hidden: Set<number>,
	width: number,
	height: number,
	o: DrawOpts
): void {
	plot.empty();

	const visible = series.filter((_, i) => !hidden.has(i));
	const allValues = visible.flatMap((s) => s.values);
	const dataMin = Math.min(0, ...allValues);
	const dataMax = Math.max(0, ...allValues);
	const ticks = niceTicks(dataMin, dataMax, 4);
	const scaleMin = Math.min(dataMin, ticks[0] ?? dataMin);
	const scaleMax = Math.max(dataMax, ticks[ticks.length - 1] ?? dataMax);

	// Padding is measured from the content, not hardcoded: a fixed padLeft: 52 clips six-figure
	// labels and wastes a third of a narrow pane on three-character ones.
	const widestTick = ticks.reduce((w, t) => Math.max(w, textWidth(o.formatTick(t))), 0);
	const padLeft = Math.round(8 + widestTick);
	const lastIdx = categories.length - 1;
	const showEndLabels = visible.length > 0 && visible.length <= 4 && lastIdx >= 0;
	const widestEnd = showEndLabels
		? visible.reduce((w, s) => Math.max(w, textWidth(o.formatTick(s.values[lastIdx] ?? 0), 11)), 0)
		: 0;
	const padRight = Math.round(showEndLabels ? 20 + widestEnd : 12);
	const padTop = 12;
	const padBottom = 26;
	const plotW = Math.max(40, width - padLeft - padRight);
	const plotH = Math.max(40, height - padTop - padBottom);

	const scaleY = (v: number) => padTop + plotH - ((v - scaleMin) / (scaleMax - scaleMin || 1)) * plotH;
	const scaleX = (i: number) => padLeft + (categories.length <= 1 ? plotW / 2 : (i / (categories.length - 1)) * plotW);

	const svg = svgEl("svg");
	svg.setAttribute("class", "fp-chart-svg");
	// width/height attributes AND an identical viewBox — one CSS pixel per user unit.
	svg.setAttribute("width", String(width));
	svg.setAttribute("height", String(height));
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	describeSvg(
		svg,
		o.title ?? `Line chart: ${visible.map((s) => s.label).join(", ")}`,
		o.description ??
			`${visible.length} series over ${categories.length} periods, ${categories[0] ?? ""} to ${categories[lastIdx] ?? ""}.`
	);
	plot.appendChild(svg);

	// --- Rule 2: grid and axes recede. Horizontal only, never dashed, snapped to the pixel grid.
	for (const t of ticks) {
		const y = Math.round(scaleY(t)) + 0.5;
		const line = svgEl("line");
		line.setAttribute("x1", String(padLeft));
		line.setAttribute("x2", String(width - padRight));
		line.setAttribute("y1", String(y));
		line.setAttribute("y2", String(y));
		line.setAttribute("shape-rendering", "crispEdges");
		line.setAttribute("class", t === 0 ? "fp-chart-baseline" : "fp-chart-grid");
		svg.appendChild(line);

		const label = svgEl("text");
		label.setAttribute("x", String(padLeft - 6));
		label.setAttribute("y", String(y));
		label.setAttribute("class", "fp-chart-axis");
		label.setAttribute("text-anchor", "end");
		label.setAttribute("dominant-baseline", "middle");
		label.textContent = o.formatTick(t);
		svg.appendChild(label);
	}

	// --- x labels, thinned to fit rather than overlapped or rotated.
	const widestCat = categories.reduce((w, c) => Math.max(w, textWidth(c)), 0) + 12;
	const step = Math.max(1, Math.ceil((categories.length * widestCat) / plotW));
	categories.forEach((cat, i) => {
		if (i % step !== 0 && i !== lastIdx) return;
		const label = svgEl("text");
		label.setAttribute("x", String(scaleX(i)));
		label.setAttribute("y", String(height - padBottom + 16));
		label.setAttribute("class", "fp-chart-axis");
		label.setAttribute("text-anchor", i === lastIdx && step > 1 ? "end" : "middle");
		label.textContent = cat;
		svg.appendChild(label);
	});

	// --- Rule 4: area gradient, single visible series only.
	const points = (s: ChartSeries) => s.values.map((v, i) => ({ x: scaleX(i), y: scaleY(v) }));
	if (o.area && visible.length === 1 && categories.length > 1) {
		const s = visible[0];
		const gradId = nextId("grad");
		const defs = svgEl("defs");
		const grad = svgEl("linearGradient");
		grad.setAttribute("id", gradId);
		grad.setAttribute("x1", "0");
		grad.setAttribute("y1", "0");
		grad.setAttribute("x2", "0");
		grad.setAttribute("y2", "1");
		([["0%", "0.20"], ["55%", "0.06"], ["100%", "0"]] as const).forEach(([offset, opacity]) => {
			const stop = svgEl("stop");
			stop.setAttribute("offset", offset);
			// currentColor resolves per series from the path's own `color`, so the wash stays
			// theme-correct in dark mode with zero extra plumbing.
			stop.setAttribute("stop-color", "currentColor");
			stop.setAttribute("stop-opacity", opacity);
			grad.appendChild(stop);
		});
		defs.appendChild(grad);
		svg.appendChild(defs);

		const pts = points(s);
		const baselineY = padTop + plotH;
		const area = svgEl("path");
		area.setAttribute("class", "fp-chart-area");
		area.setAttribute(
			"d",
			(o.smooth ? monotonePath(pts) : polyPath(pts)) +
				`L${pts[pts.length - 1].x},${baselineY}L${pts[0].x},${baselineY}Z`
		);
		area.setAttribute("fill", `url(#${gradId})`);
		area.style.color = s.color;
		svg.appendChild(area);
	}

	// --- Lines.
	visible.forEach((s) => {
		const pts = points(s);
		const path = svgEl("path");
		path.setAttribute("d", o.smooth ? monotonePath(pts) : polyPath(pts));
		path.setAttribute("class", "fp-chart-line");
		path.setAttribute("vector-effect", "non-scaling-stroke");
		path.style.setProperty("--fp-line-color", s.color);
		svg.appendChild(path);
	});

	// --- Rule 5: markers are selective — last point of every series, plus the focus series' extremes.
	const marker = (x: number, y: number, color: string, cls = "fp-chart-dot") => {
		const dot = svgEl("circle");
		dot.setAttribute("cx", String(x));
		dot.setAttribute("cy", String(y));
		dot.setAttribute("r", "4");
		dot.setAttribute("class", cls);
		dot.style.setProperty("--fp-line-color", color);
		svg.appendChild(dot);
	};
	visible.forEach((s, si) => {
		if (lastIdx >= 0) marker(scaleX(lastIdx), scaleY(s.values[lastIdx]), s.color);
		if (si !== 0 || s.values.length < 3) return;
		let minI = 0;
		let maxI = 0;
		s.values.forEach((v, i) => {
			if (v < s.values[minI]) minI = i;
			if (v > s.values[maxI]) maxI = i;
		});
		[minI, maxI].forEach((i) => {
			if (i !== lastIdx) marker(scaleX(i), scaleY(s.values[i]), s.color);
		});
	});

	// --- Rule 6: end labels with leader lines. Vertical stacking alone detaches a label from its
	// line; a leader keeps the association when converging series force a push.
	if (showEndLabels) {
		const MIN_GAP = 13;
		const labels = visible
			.map((s) => ({ natural: scaleY(s.values[lastIdx]), y: scaleY(s.values[lastIdx]), text: o.formatTick(s.values[lastIdx]), color: s.color }))
			.sort((a, b) => a.y - b.y);
		for (let i = 1; i < labels.length; i++) {
			const min = labels[i - 1].y + MIN_GAP;
			if (labels[i].y < min) labels[i].y = min;
		}
		const xEnd = scaleX(lastIdx);
		labels.forEach((l) => {
			if (Math.abs(l.y - l.natural) > 0.5) {
				const leader = svgEl("path");
				leader.setAttribute("class", "fp-chart-leader");
				leader.setAttribute("d", `M${xEnd + 4},${l.natural}H${xEnd + 8}L${xEnd + 12},${l.y}H${xEnd + 15}`);
				svg.appendChild(leader);
			}
			const text = svgEl("text");
			text.setAttribute("x", String(xEnd + 17));
			text.setAttribute("y", String(l.y));
			text.setAttribute("class", "fp-chart-end-label");
			text.setAttribute("dominant-baseline", "middle");
			text.style.setProperty("--fp-line-color", l.color);
			text.textContent = l.text;
			svg.appendChild(text);
		});
	}

	// --- Hover / keyboard crosshair.
	const crosshair = svgEl("line");
	crosshair.setAttribute("y1", String(padTop));
	crosshair.setAttribute("y2", String(padTop + plotH));
	crosshair.setAttribute("class", "fp-chart-crosshair");
	crosshair.style.display = "none";
	svg.appendChild(crosshair);

	const hoverLayer = svgEl("g");
	hoverLayer.setAttribute("class", "fp-chart-hover");
	svg.appendChild(hoverLayer);

	const tooltip = plot.createDiv({ cls: "fp-chart-tooltip" });

	const hitRect = svgEl("rect");
	hitRect.setAttribute("x", String(padLeft));
	hitRect.setAttribute("y", String(padTop));
	hitRect.setAttribute("width", String(plotW));
	hitRect.setAttribute("height", String(plotH));
	hitRect.setAttribute("class", "fp-chart-hit");
	hitRect.setAttribute("tabindex", "0");
	hitRect.setAttribute("focusable", "true");
	hitRect.setAttribute("aria-label", "Chart data. Use left and right arrow keys to step through periods.");
	svg.appendChild(hitRect);

	let activeIdx = -1;
	const hide = () => {
		activeIdx = -1;
		crosshair.style.display = "none";
		hoverLayer.empty();
		tooltip.removeClass("is-visible");
	};
	const show = (idx: number) => {
		if (categories.length === 0) return;
		activeIdx = Math.max(0, Math.min(categories.length - 1, idx));
		const x = scaleX(activeIdx);
		crosshair.style.display = "";
		crosshair.setAttribute("x1", String(x));
		crosshair.setAttribute("x2", String(x));

		hoverLayer.empty();
		visible.forEach((s) => {
			const dot = svgEl("circle");
			dot.setAttribute("cx", String(x));
			dot.setAttribute("cy", String(scaleY(s.values[activeIdx])));
			dot.setAttribute("r", "4");
			dot.setAttribute("class", "fp-chart-dot");
			dot.style.setProperty("--fp-line-color", s.color);
			hoverLayer.appendChild(dot);
		});

		tooltip.empty();
		tooltip.createDiv({ cls: "fp-chart-tooltip-title", text: categories[activeIdx] });
		visible.forEach((s) => {
			const row = tooltip.createDiv({ cls: "fp-chart-tooltip-row" });
			const swatch = row.createSpan({ cls: "fp-chart-swatch" });
			swatch.style.setProperty("--fp-swatch-color", s.color);
			row.createSpan({ text: s.label });
			row.createSpan({ cls: "fp-chart-tooltip-value fp-money", text: o.formatValue(s.values[activeIdx]) });
		});
		tooltip.addClass("is-visible");

		// The tooltip follows the point instead of being pinned to the top of the plot, and flips
		// side once past 60% so it never leaves the card.
		const flip = x / width > 0.6;
		tooltip.style.left = `${x + (flip ? -8 : 8)}px`;
		// Always write the transform: an empty string would fall back to the rest-state
		// `translateY(2px)` the CSS uses for the fade-in.
		tooltip.style.transform = flip ? "translateX(-100%)" : "none";
		const focusY = scaleY(visible[0]?.values[activeIdx] ?? 0);
		tooltip.style.top = `${Math.max(0, Math.min(plotH - tooltip.offsetHeight, focusY - tooltip.offsetHeight / 2))}px`;
	};

	hitRect.addEventListener("mousemove", (ev: MouseEvent) => {
		const rect = svg.getBoundingClientRect();
		const localX = ev.clientX - rect.left;
		show(Math.round(((localX - padLeft) / plotW) * (categories.length - 1)));
	});
	hitRect.addEventListener("mouseleave", hide);
	hitRect.addEventListener("blur", hide);
	hitRect.addEventListener("keydown", (ev: KeyboardEvent) => {
		if (ev.key === "ArrowRight") show(activeIdx < 0 ? 0 : activeIdx + 1);
		else if (ev.key === "ArrowLeft") show(activeIdx < 0 ? categories.length - 1 : activeIdx - 1);
		else if (ev.key === "Escape") hide();
		else return;
		ev.preventDefault();
	});
}

/* ==========================================================================
   Grouped columns (monthly income vs expenses)
   ========================================================================== */

export interface ColumnChartOpts {
	height?: number;
	formatValue?: (n: number) => string;
	money?: boolean;
	title?: string;
	description?: string;
	/** Max column thickness. Wider than this and the columns start reading as blocks. */
	maxBarWidth?: number;
}

/**
 * Grouped column chart for paired periodic aggregates (income vs expenses per month). Columns are
 * capped at 24px, separated by surface-colored gaps, and rounded on their top corners only so the
 * baseline stays optically flat.
 */
export function groupedColumnChart(
	container: HTMLElement,
	categories: string[],
	series: ChartSeries[],
	opts?: ColumnChartOpts
): void {
	const money = opts?.money !== false;
	const formatValue = opts?.formatValue ?? ((n: number) => EUR.format(n));
	const wrap = container.createDiv({ cls: "fp-chart" + (money ? " fp-chart-money" : "") });

	if (series.length >= 2) {
		const legend = wrap.createDiv({ cls: "fp-chart-legend" });
		series.forEach((s) => {
			const item = legend.createDiv({ cls: "fp-chart-legend-item" });
			const key = item.createSpan({ cls: "fp-chart-key fp-chart-key--area fp-chart-swatch" });
			key.style.setProperty("--fp-key", s.color);
			key.style.setProperty("--fp-swatch-color", s.color);
			item.createSpan({ text: s.label });
		});
	}

	const plot = wrap.createDiv({ cls: "fp-chart-plot" });
	mountResponsiveChart(
		plot,
		(width, height) => {
			plot.empty();
			const allValues = series.flatMap((s) => s.values);
			const ticks = niceTicks(Math.min(0, ...allValues), Math.max(0, ...allValues), 4);
			const scaleMin = Math.min(0, ...allValues, ticks[0] ?? 0);
			const scaleMax = Math.max(0, ...allValues, ticks[ticks.length - 1] ?? 0);

			const widestTick = ticks.reduce((w, t) => Math.max(w, textWidth(formatCompact(t))), 0);
			const padLeft = Math.round(8 + widestTick);
			const padRight = 12;
			const padTop = 12;
			const padBottom = 26;
			const plotW = Math.max(40, width - padLeft - padRight);
			const plotH = Math.max(40, height - padTop - padBottom);
			const scaleY = (v: number) => padTop + plotH - ((v - scaleMin) / (scaleMax - scaleMin || 1)) * plotH;
			const zeroY = scaleY(0);

			const svg = svgEl("svg");
			svg.setAttribute("class", "fp-chart-svg");
			svg.setAttribute("width", String(width));
			svg.setAttribute("height", String(height));
			svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
			describeSvg(
				svg,
				opts?.title ?? `Column chart: ${series.map((s) => s.label).join(" vs ")}`,
				opts?.description ?? `${series.length} series over ${categories.length} periods.`
			);
			plot.appendChild(svg);

			for (const t of ticks) {
				const y = Math.round(scaleY(t)) + 0.5;
				const line = svgEl("line");
				line.setAttribute("x1", String(padLeft));
				line.setAttribute("x2", String(width - padRight));
				line.setAttribute("y1", String(y));
				line.setAttribute("y2", String(y));
				line.setAttribute("shape-rendering", "crispEdges");
				line.setAttribute("class", t === 0 ? "fp-chart-baseline" : "fp-chart-grid");
				svg.appendChild(line);

				const label = svgEl("text");
				label.setAttribute("x", String(padLeft - 6));
				label.setAttribute("y", String(y));
				label.setAttribute("class", "fp-chart-axis");
				label.setAttribute("text-anchor", "end");
				label.setAttribute("dominant-baseline", "middle");
				label.textContent = formatCompact(t);
				svg.appendChild(label);
			}

			const slot = plotW / Math.max(1, categories.length);
			const groupW = Math.min(slot * 0.72, (opts?.maxBarWidth ?? 24) * series.length + 2 * (series.length - 1));
			const barW = Math.max(2, (groupW - 2 * (series.length - 1)) / Math.max(1, series.length));

			const widestCat = categories.reduce((w, c) => Math.max(w, textWidth(c)), 0) + 8;
			const step = Math.max(1, Math.ceil((categories.length * widestCat) / plotW));

			categories.forEach((cat, ci) => {
				const groupX = padLeft + slot * ci + (slot - groupW) / 2;
				series.forEach((s, si) => {
					const v = s.values[ci] ?? 0;
					const y = Math.min(scaleY(v), zeroY);
					const h = Math.max(1, Math.abs(zeroY - scaleY(v)));
					const bar = svgEl("path");
					bar.setAttribute("d", roundedTopBar(groupX + si * (barW + 2), y, barW, h, 4));
					bar.setAttribute("class", "fp-chart-column");
					bar.style.setProperty("--fp-bar-color", s.color);
					const t = svgEl("title");
					t.textContent = `${cat} · ${s.label}: ${formatValue(v)}`;
					bar.appendChild(t);
					svg.appendChild(bar);
				});

				if (ci % step === 0 || ci === categories.length - 1) {
					const label = svgEl("text");
					label.setAttribute("x", String(padLeft + slot * ci + slot / 2));
					label.setAttribute("y", String(height - padBottom + 16));
					label.setAttribute("class", "fp-chart-axis");
					label.setAttribute("text-anchor", "middle");
					label.textContent = cat;
					svg.appendChild(label);
				}
			});
		},
		{ height: opts?.height, ratio: 0.45, minHeight: 180, maxHeight: 300 }
	);
}

/* ==========================================================================
   Sparkline
   ========================================================================== */

/**
 * A tiny trend-only line (stat contract): the history rides in the de-emphasis ink, only the
 * current/last point picks up the series' accent color. No axes, no tooltip — it's a glance.
 */
export function sparkline(
	container: HTMLElement,
	values: number[],
	accentColor: string,
	opts?: { height?: number; width?: number; area?: boolean }
): void {
	if (values.length === 0) return;
	const height = opts?.height ?? 28;
	const width = opts?.width ?? 88;
	const pad = 3;
	const min = Math.min(...values, 0);
	const max = Math.max(...values, 0);
	const span = max - min || 1;
	const scaleY = (v: number) => pad + (height - pad * 2) * (1 - (v - min) / span);
	const scaleX = (i: number) => (values.length <= 1 ? width / 2 : pad + (i / (values.length - 1)) * (width - pad * 2));

	const svg = svgEl("svg");
	// 1:1 units — CSS sizes the sparkline to exactly these numbers, so strokes stay 2px.
	svg.setAttribute("width", String(width));
	svg.setAttribute("height", String(height));
	svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
	svg.setAttribute("class", "fp-sparkline");
	svg.setAttribute("role", "img");
	svg.setAttribute("aria-hidden", "true");
	container.appendChild(svg);

	const pts = values.map((v, i) => ({ x: scaleX(i), y: scaleY(v) }));

	if (opts?.area) {
		const area = svgEl("path");
		area.setAttribute("class", "fp-sparkline-area");
		area.setAttribute("d", `${polyPath(pts)}L${pts[pts.length - 1].x},${height}L${pts[0].x},${height}Z`);
		area.style.setProperty("--fp-line-color", accentColor);
		svg.appendChild(area);
	}

	const line = svgEl("path");
	line.setAttribute("d", polyPath(pts));
	line.setAttribute("class", "fp-sparkline-line");
	line.setAttribute("vector-effect", "non-scaling-stroke");
	svg.appendChild(line);

	const lastIdx = values.length - 1;
	const dot = svgEl("circle");
	dot.setAttribute("cx", String(scaleX(lastIdx)));
	dot.setAttribute("cy", String(scaleY(values[lastIdx])));
	dot.setAttribute("r", "2.5");
	dot.setAttribute("class", "fp-sparkline-dot");
	dot.style.setProperty("--fp-line-color", accentColor);
	svg.appendChild(dot);
}

/* ==========================================================================
   Rule 8 — share bar (part-to-whole; no donuts)
   ========================================================================== */

/**
 * Part-to-whole as a single horizontal bar with surface-colored gaps, plus a legend carrying value
 * and share. Hovering a segment dims its siblings and highlights the matching legend row.
 */
export function stackedShareBar(
	container: HTMLElement,
	segments: { label: string; value: number; color: string }[],
	opts?: { formatValue?: (n: number) => string }
): void {
	const formatValue = opts?.formatValue ?? ((n: number) => String(n));
	const total = segments.reduce((sum, s) => sum + Math.max(0, s.value), 0);

	const wrap = container.createDiv({ cls: "fp-share-bar-wrap" });
	const bar = wrap.createDiv({ cls: "fp-share-bar" });
	const legend = wrap.createDiv({ cls: "fp-share-bar-legend" });

	const legendItems: HTMLElement[] = [];
	segments.forEach((s) => {
		const pct = total > 0 ? (Math.max(0, s.value) / total) * 100 : 0;
		const item = legend.createDiv({ cls: "fp-share-bar-legend-item" });
		const swatch = item.createSpan({ cls: "fp-chart-swatch" });
		swatch.style.setProperty("--fp-swatch-color", s.color);
		item.createSpan({ cls: "fp-share-bar-legend-label", text: s.label });
		item.createSpan({ cls: "fp-share-bar-legend-value fp-money", text: `${formatValue(s.value)} · ${pct.toFixed(0)}%` });
		legendItems.push(item);
	});

	segments.forEach((s, i) => {
		const pct = total > 0 ? Math.max(0, s.value) / total : 0;
		if (pct <= 0) return;
		const seg = bar.createDiv({ cls: "fp-share-bar-seg" });
		seg.style.width = `${pct * 100}%`;
		seg.style.setProperty("--fp-seg-color", s.color);
		seg.setAttribute("title", `${s.label}: ${formatValue(s.value)} (${(pct * 100).toFixed(0)}%)`);
		seg.addEventListener("mouseenter", () => legendItems[i]?.addClass("is-highlight"));
		seg.addEventListener("mouseleave", () => legendItems[i]?.removeClass("is-highlight"));
	});
}

/* ==========================================================================
   Rule 7 — horizontal bars
   ========================================================================== */

/** Horizontal bar chart for category totals — each bar keeps that category's own color. */
export function barChart(
	container: HTMLElement,
	rows: { label: string; value: number; color: string; iconName?: string }[],
	opts?: { formatValue?: (n: number) => string; onRowClick?: (index: number) => void }
): void {
	const formatValue = opts?.formatValue ?? ((n: number) => EUR.format(n));
	const wrap = container.createDiv({ cls: "fp-barchart" });
	const max = Math.max(...rows.map((r) => r.value), 1);
	rows.forEach((r, i) => {
		const share = max > 0 ? (r.value / max) * 100 : 0;
		// The mark is the hit target here (no crosshair), so identity + value live on the row itself.
		// With onRowClick the row becomes a real button so it's focusable and announced.
		const row = opts?.onRowClick
			? wrap.createEl("button", {
					cls: "fp-barchart-row fp-barchart-row--clickable",
					attr: { type: "button", title: `${r.label}: ${formatValue(r.value)}`, "aria-label": `${r.label}: ${formatValue(r.value)}` },
			  })
			: wrap.createDiv({
					cls: "fp-barchart-row",
					attr: { title: `${r.label}: ${formatValue(r.value)}`, "aria-label": `${r.label}: ${formatValue(r.value)}` },
			  });
		if (opts?.onRowClick) row.addEventListener("click", () => opts.onRowClick!(i));
		const labelEl = row.createDiv({ cls: "fp-barchart-label" });
		if (r.iconName) chartIcon(labelEl, r.iconName, "fp-barchart-icon");
		labelEl.createSpan({ text: r.label });

		const track = row.createDiv({ cls: "fp-barchart-track" });
		const fill = track.createDiv({ cls: "fp-barchart-fill" });
		fill.style.setProperty("--fp-bar-color", r.color);
		// Percentage width, not a 2% floor: a min-width in CSS keeps a near-zero bar visible
		// without overstating it.
		fill.style.width = `${share}%`;

		row.createDiv({ cls: "fp-barchart-value fp-money", text: formatValue(r.value) });
	});
}

/* ==========================================================================
   Rule 9 — microbars replace the heat tint
   ========================================================================== */

/**
 * A 2px full-width bar under a table number, scaled to the row's own max. Reads identically in both
 * themes, doesn't fight the text, and — unlike a red→yellow→green ramp — has no hue at the midpoint
 * pretending to be a third state.
 */
export function microbar(parent: HTMLElement, ratio: number, color: string): HTMLElement {
	const bar = parent.createDiv({ cls: "fp-microbar" });
	bar.style.setProperty("--fp-microbar-w", `${Math.max(0, Math.min(1, ratio)) * 100}%`);
	bar.style.setProperty("--fp-microbar-color", color);
	return bar;
}
