import type { App } from "obsidian";
import type { Transaction } from "../types";

/**
 * The audit trail of writes made from other devices: one entry per request, appended to a note in the
 * data folder, saying when, what was asked, who asked, how it ended, and every ledger row it changed
 * with the values before and after.
 *
 * Rows are found by diffing the whole ledger rather than by trusting the route to report them, because
 * one request can change more than the row it names: setting a category teaches merchant memory, and
 * every uncategorized sibling from the same shop follows. An audit that only logged the row in the URL
 * would miss exactly the changes nobody asked for by id.
 *
 * Refused requests are logged too (with no changes), but only once the caller has shown the token — an
 * unauthenticated stranger can't grow the note. The note is written straight through the vault adapter,
 * not the store, so it never counts as a data write: it doesn't move the revision or appear in a
 * response's `written`.
 */

export const AUDIT_NOTE = "API audit log.md";

const AUDIT_HEADER = `# Local API audit log

Every write the local API accepted or refused from another device, oldest first. Written by
ManageMyFinance; editing it changes nothing in the ledger.
`;

/** Fields kept for a row that was added or removed — enough to recognise it, not the raw bank line. */
const ROW_SUMMARY: (keyof Transaction)[] = ["id", "date", "accountId", "amount", "currency", "description", "categoryId", "review", "importBatchId"];

export type LedgerSnapshot = Map<string, Transaction>;

/** A copy of the ledger to diff against later. Shallow per row — every field a route can change is a
 *  primitive — so the store mutating a row in place can't rewrite the "before". */
export function snapshotLedger(transactions: Transaction[]): LedgerSnapshot {
	return new Map(transactions.map((t) => [t.id, { ...t }]));
}

export interface RowChange {
	id: string;
	before: Record<string, unknown>;
	after: Record<string, unknown>;
}

export interface LedgerDiff {
	added: Record<string, unknown>[];
	removed: Record<string, unknown>[];
	changed: RowChange[];
}

function summary(tx: Transaction): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of ROW_SUMMARY) if (tx[key] !== undefined) out[key] = tx[key];
	return out;
}

function same(a: unknown, b: unknown): boolean {
	return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Rows added, removed and changed between two snapshots — a change lists only the fields that moved,
 *  with `null` standing for a field that was absent on that side. */
export function diffLedger(before: LedgerSnapshot, after: LedgerSnapshot): LedgerDiff {
	const diff: LedgerDiff = { added: [], removed: [], changed: [] };
	for (const [id, tx] of after) {
		const old = before.get(id);
		if (!old) {
			diff.added.push(summary(tx));
			continue;
		}
		const keys = new Set([...Object.keys(old), ...Object.keys(tx)]) as Set<keyof Transaction>;
		const change: RowChange = { id, before: {}, after: {} };
		for (const key of keys) {
			if (same(old[key], tx[key])) continue;
			change.before[key] = old[key] ?? null;
			change.after[key] = tx[key] ?? null;
		}
		if (Object.keys(change.after).length > 0) diff.changed.push(change);
	}
	for (const [id, tx] of before) if (!after.has(id)) diff.removed.push(summary(tx));
	return diff;
}

export interface AuditEntry {
	time: string;
	method: string;
	path: string;
	client: string;
	requestId?: string;
	/** "full": "Allow writes from other devices" let it through; "scoped": the remote write scopes did;
	 *  "refused": neither did. */
	access: "full" | "scoped" | "refused";
	status: number;
	/** The ids a client would look for: the row in the URL, the batch an import created or undid. */
	ids?: Record<string, string>;
	dryRun?: boolean;
	error?: string;
	diff?: LedgerDiff;
}

export function formatEntry(entry: AuditEntry): string {
	const { diff, ...head } = entry;
	const counts = diff ? ` · +${diff.added.length} −${diff.removed.length} ~${diff.changed.length}` : "";
	const body: Record<string, unknown> = { ...head };
	if (diff && (diff.added.length || diff.removed.length || diff.changed.length)) body.changes = diff;
	return `\n## ${entry.time} · ${entry.method} ${entry.path} · ${entry.status}${counts}\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\n`;
}

/** Appends run one at a time, so two requests finishing together can't each read the note, add their
 *  entry and write back over the other's. */
let queue: Promise<void> = Promise.resolve();

export function appendAudit(app: App, dataFolder: string, entry: AuditEntry): Promise<void> {
	const path = `${dataFolder.replace(/\/+$/, "")}/${AUDIT_NOTE}`;
	const run = async (): Promise<void> => {
		const adapter = app.vault.adapter;
		const existing = (await adapter.exists(path)) ? await adapter.read(path) : AUDIT_HEADER;
		await adapter.write(path, existing + formatEntry(entry));
	};
	const next = queue.then(run, run);
	queue = next.catch(() => undefined);
	return next;
}
