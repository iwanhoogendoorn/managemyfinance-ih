import { normalizePath, type App } from "obsidian";
import { timestampSlug } from "./backup";

/** Vault-unsafe filename characters, replaced so the write never fails on a stray "/", ":" etc. carried over from the OS file picker. */
function sanitizeFilename(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "_");
}

/** MIME type by (lowercased) file extension, for every attachment format this plugin will read back
 *  out and show — the invoice/receipt matcher's own upload list, and a report export's embedded
 *  receipts, both key off this one map rather than each keeping their own copy. */
export const ATTACHMENT_MEDIA_TYPES: Record<string, string> = {
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	avif: "image/avif",
	heic: "image/heic",
};

/** Raw bytes → base64, chunked because `String.fromCharCode.apply` blows the argument limit somewhere
 *  north of 100k bytes in one call. */
export function base64Of(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 8192) {
		binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)));
	}
	return btoa(binary);
}

function extensionOf(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
}

/**
 * An attachment already in the vault, read back out as a `data:` URI ready to embed directly in an
 * HTML export — undefined for anything that isn't a recognised image type, or that can no longer be
 * read (moved, deleted since it was linked — quietly skipped rather than failing the whole export
 * over one missing receipt). A PDF attachment reads through `readAttachmentBytes` instead, since its
 * consumer (the report PDF export) merges its actual pages rather than embedding a data URI.
 */
export async function readAttachmentDataUri(app: App, path: string): Promise<string | undefined> {
	const ext = extensionOf(path);
	const mediaType = ext === "pdf" ? undefined : ATTACHMENT_MEDIA_TYPES[ext];
	if (!mediaType) return undefined;
	try {
		const bytes = await app.vault.adapter.readBinary(path);
		return `data:${mediaType};base64,${base64Of(bytes)}`;
	} catch {
		return undefined;
	}
}

/** An attachment's raw bytes, straight off disk — undefined if it can no longer be read (moved,
 *  deleted since it was linked). Used where a caller needs the actual file rather than a rendered
 *  form of it, e.g. merging a receipt PDF's own pages into an exported report PDF. */
export async function readAttachmentBytes(app: App, path: string): Promise<Uint8Array | undefined> {
	try {
		return new Uint8Array(await app.vault.adapter.readBinary(path));
	} catch {
		return undefined;
	}
}

/**
 * Where receipts and invoices are written, vault-relative.
 *
 * Defaults to `<dataFolder>/attachments` so the plugin keeps everything it owns in one place, but a
 * vault that already has an attachments convention can point this anywhere — receipts are the one
 * thing here a person also opens outside the plugin, so forcing them into our folder is our
 * preference, not theirs.
 *
 * Only ever consulted when writing something new. A transaction stores the full vault path it was
 * given, so moving this setting later leaves every existing attachment exactly where it is and still
 * linked; it does not relocate anything, and nothing breaks.
 */
export function attachmentFolderOf(settings: { dataFolder: string; attachmentFolder?: string }): string {
	const custom = settings.attachmentFolder?.trim();
	return normalizePath(custom ? custom : `${settings.dataFolder}/attachments`);
}

/**
 * Copies a file picked from outside the vault (drag-and-drop or the OS file browser) into the
 * attachment folder, timestamped so two receipts both named "receipt.pdf" never collide.
 * Returns the vault-relative path written — ready to use as a transaction's attachmentPath.
 */
export async function writeAttachment(app: App, settings: { dataFolder: string; attachmentFolder?: string }, file: File): Promise<string> {
	const folder = attachmentFolderOf(settings);
	const adapter = app.vault.adapter;
	// A custom folder can be nested several levels deep and mkdir does not create parents, so walk it.
	let built = "";
	for (const part of folder.split("/")) {
		built = built ? `${built}/${part}` : part;
		if (!(await adapter.exists(built))) await adapter.mkdir(built);
	}
	const path = normalizePath(`${folder}/${timestampSlug()}-${sanitizeFilename(file.name)}`);
	await adapter.writeBinary(path, await file.arrayBuffer());
	return path;
}
