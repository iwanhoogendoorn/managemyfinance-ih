/** Normalizes ING/Trade Republic/generic bank date formats (YYYYMMDD, D/M/YY, "YYYY-MM-DD HH:MM:SS",
 *  or already-ISO) to ISO yyyy-mm-dd. */
export function parseFlexibleDate(raw: string): string {
	const s = raw.trim();
	if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
	// Both ING and Trade Republic exports use the European day/month order (e.g. 27/07/2026), not US month/day.
	const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
	if (m) {
		const [, d, mo, yRaw] = m;
		const y = yRaw.length === 2 ? (Number(yRaw) > 70 ? "19" : "20") + yRaw : yRaw;
		return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
	}
	// A "YYYY-MM-DD[ HH:MM:SS]" timestamp (Revolut and similar exports) — take the date substring
	// directly, never through a Date object. `new Date("2026-08-11 00:15:00")` is parsed as LOCAL
	// time and then re-rendered as UTC below, so any completion time in the first ~1-2 hours of the
	// day silently rolls back to the previous calendar date — the transaction's own reported day,
	// which is the only thing this function should ever return, never moves for a timezone reason.
	const iso = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T]\d{2}:\d{2}(:\d{2})?)?/);
	if (iso) return iso[1];
	const parsed = new Date(s);
	if (!isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
	return s;
}
