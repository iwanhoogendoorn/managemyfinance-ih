/**
 * The one place money, percentages and compact figures are turned into strings.
 *
 * Before this module there were four `formatEUR` implementations with two different rounding rules, so
 * €1,234.56 rendered as both "€1,235" and "€1,234.56" on the same screen. Views still carry their local
 * copies until each is migrated here deliberately — centralizing changes displayed values in the metrics
 * tables, which is a visual change, not a refactor.
 *
 * The currency argument is honoured rather than hardcoded to EUR. That is the honest minimum for a data
 * model that already carries `Account.currency` / `Transaction.currency`: it does NOT make aggregation
 * multi-currency-safe (summing a USD row into a EUR total is still 1:1 everywhere), it only stops us
 * *labelling* a dollar amount with a euro sign.
 */

/** Matches the locale the plugin already used everywhere (`en-IE`): "€1,234.56", symbol first, comma groups. */
const DEFAULT_LOCALE = "en-IE";

/** What every formatter returns for NaN/Infinity — an em dash reads as "no value", "€NaN" reads as a bug. */
const NO_VALUE = "—";

export interface MoneyFormatOptions {
	/** Decimal places. Defaults to 2 — full precision is the honest default for a ledger figure. */
	decimals?: number;
	/** Force a leading "+" on positive amounts. For deltas, where direction is the point. */
	signed?: boolean;
	locale?: string;
}

/**
 * Intl throws a RangeError on an unrecognized currency code, and currency codes here come from imported
 * CSVs — one malformed row must not take down a whole dashboard render, so an unusable code degrades to
 * a plain number with the raw code in front of it.
 */
interface Formatter {
	format: (n: number) => string;
	/** Only present on the real Intl path — the malformed-currency fallback below can't provide it. */
	formatToParts?: (n: number) => Intl.NumberFormatPart[];
}

function currencyFormat(
	locale: string,
	currency: string,
	options: Intl.NumberFormatOptions
): Formatter {
	try {
		return new Intl.NumberFormat(locale, { style: "currency", currency, ...options });
	} catch {
		const plain = new Intl.NumberFormat(locale, options);
		return { format: (n: number) => `${currency} ${plain.format(n)}` };
	}
}

export function formatMoney(n: number, currency = "EUR", opts: MoneyFormatOptions = {}): string {
	if (!Number.isFinite(n)) return NO_VALUE;
	const decimals = opts.decimals ?? 2;
	// -0 formats as "-€0.00", which reads as a tiny loss rather than nothing at all.
	const value = n === 0 ? 0 : n;
	return currencyFormat(opts.locale ?? DEFAULT_LOCALE, currency, {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
		signDisplay: opts.signed ? "exceptZero" : "auto",
	}).format(value);
}

/**
 * A ratio as a percentage: 0.42 → "42%". Takes the raw ratio, not an already-multiplied number, because
 * every ratio in `kpi.ts` (savings rate, budget pace, utilization) is produced in [0,1] terms.
 */
export function formatPct(n: number, digits = 0): string {
	if (!Number.isFinite(n)) return NO_VALUE;
	return new Intl.NumberFormat(DEFAULT_LOCALE, {
		style: "percent",
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
	}).format(n === 0 ? 0 : n);
}

/** Same as `formatPct` but always carries its sign — for deltas, where "+3%" and "3%" mean different things. */
export function formatSignedPct(n: number, digits = 0): string {
	if (!Number.isFinite(n)) return NO_VALUE;
	return new Intl.NumberFormat(DEFAULT_LOCALE, {
		style: "percent",
		minimumFractionDigits: digits,
		maximumFractionDigits: digits,
		signDisplay: "exceptZero",
	}).format(n === 0 ? 0 : n);
}

/**
 * Abbreviated money for tight spaces — "€1.2M", "€48K". Chart axes and sparkline end-labels have a fixed
 * pixel budget, so a six-figure net worth spelled out in full either clips or shrinks the whole axis.
 */
export function formatCompact(n: number, currency = "EUR", opts: { locale?: string } = {}): string {
	if (!Number.isFinite(n)) return NO_VALUE;
	const value = n === 0 ? 0 : n;
	const formatter = currencyFormat(opts.locale ?? DEFAULT_LOCALE, currency, {
		notation: "compact",
		maximumFractionDigits: 1,
	});

	// ICU builds disagree about whether compact notation keeps a redundant zero fraction: Node 20
	// renders 950 as "€950.0" where Node 25 gives "€950", so the same chart axis reads differently
	// on two machines. Dropping an all-zero fraction via parts (rather than string surgery) is exact
	// — the zeros aren't at the end of the string in "48.0K", and the separator is locale-dependent.
	const parts = formatter.formatToParts?.(value);
	if (!parts) return formatter.format(value);
	const fractionIsZero = parts.some((p) => p.type === "fraction") && parts.every((p) => p.type !== "fraction" || /^0+$/.test(p.value));
	if (!fractionIsZero) return parts.map((p) => p.value).join("");
	return parts.filter((p) => p.type !== "fraction" && p.type !== "decimal").map((p) => p.value).join("");
}

/**
 * Parses a user-typed amount, tolerant of both decimal conventions: "30,27" and "30.27" both come
 * back as 30.27, "1.234,56" and "1,234.56" both as 1234.56. Needed because `parseFloat("30,27")`
 * silently returns 30 — a Dutch user typing their comma decimal into a bare parseFloat loses the
 * cents with no error, which is exactly how an opening balance of €30.27 became €30.
 *
 * Disambiguation when only ONE separator is present: a dot is always decimal (the app renders dot
 * decimals, so a pasted-back value round-trips); a comma is decimal when followed by 1–2 digits and
 * a thousands separator when followed by exactly 3 ("1,234" → 1234). When both are present, the
 * last one wins as the decimal separator. Returns undefined for input with no parseable number.
 */
export function parseAmount(raw: string): number | undefined {
	// Strip currency symbols, spaces (incl. narrow no-break used by some locales), and sign noise.
	let s = raw.replace(/[^\d.,\-]/g, "").trim();
	if (!s || s === "-" || s === "." || s === ",") return undefined;

	const lastDot = s.lastIndexOf(".");
	const lastComma = s.lastIndexOf(",");
	if (lastDot !== -1 && lastComma !== -1) {
		// Both present: the later one is the decimal separator, the other is grouping.
		const dec = Math.max(lastDot, lastComma);
		const decChar = s[dec];
		const groupChar = decChar === "." ? "," : ".";
		s = s.split(groupChar).join("");
		// A decimal separator that appears more than once (e.g. "1.2.3,4,5") is garbage, not grouping.
		if (s.split(decChar).length > 2) return undefined;
		s = s.replace(decChar, ".");
	} else if (lastComma !== -1) {
		const after = s.length - lastComma - 1;
		const commas = (s.match(/,/g) ?? []).length;
		if (commas === 1 && after !== 3) s = s.replace(",", ".");
		else s = s.split(",").join(""); // "1,234" / "1,234,567" — grouping
	}
	// Dot-only input is already canonical; multiple dots ("1.234.567") are EU grouping.
	else if (lastDot !== -1 && (s.match(/\./g) ?? []).length > 1) {
		s = s.split(".").join("");
	}

	const n = parseFloat(s);
	return Number.isFinite(n) ? n : undefined;
}
