export type DateOrder = "dmy" | "mdy";

/**
 * Works out whether a batch of slash-separated dates is day-first or month-first, decided once for
 * the whole batch rather than guessed per row.
 *
 * A component above 12 can only be a day, so a single unambiguous date in the batch settles every
 * row — including the ones that looked fine misread the other way. That's the exact shape of bug
 * this exists to catch: a US-formatted export's "08/12/2026" (12 August) silently misreads as 8
 * December under a hardcoded day-first assumption, and nothing about that one row looks wrong on its
 * own — only a sibling row like "08/18/2026" (an impossible month) gives the mismatch away, and by
 * then every row in the file needs the same correction, not just the visibly-broken ones.
 *
 * Falls back to day-first — this plugin's long-standing default for ING/European exports — when
 * every date in the batch happens to fall in the first twelve days of a month, where the ambiguity
 * genuinely can't be resolved from the dates alone.
 */
export function detectDateOrder(dates: string[]): DateOrder {
	for (const raw of dates) {
		const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(raw.trim());
		if (!m) continue;
		const first = parseInt(m[1], 10);
		const second = parseInt(m[2], 10);
		if (first > 12 && second <= 12) return "dmy";
		if (second > 12 && first <= 12) return "mdy";
	}
	return "dmy";
}

/** Normalizes ING/Trade Republic date formats (YYYYMMDD, D/M/YY, or already-ISO) to ISO yyyy-mm-dd.
 *  `order` defaults to day-first, matching ING and Trade Republic's own real exports (e.g.
 *  27/07/2026) — pass the result of `detectDateOrder` run over the whole column for a source (like a
 *  manually column-mapped or US-issued CSV) that isn't guaranteed to be day-first. */
export function parseFlexibleDate(raw: string, order: DateOrder = "dmy"): string {
	const s = raw.trim();
	if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
	const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
	if (m) {
		const [, a, b, yRaw] = m;
		const day = order === "dmy" ? a : b;
		const month = order === "dmy" ? b : a;
		const y = yRaw.length === 2 ? (Number(yRaw) > 70 ? "19" : "20") + yRaw : yRaw;
		return `${y}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
	}
	const parsed = new Date(s);
	if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
	return s;
}
