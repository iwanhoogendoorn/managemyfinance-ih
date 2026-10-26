/**
 * Bearer-token handling for the local API.
 *
 * Node's crypto is passed in rather than imported, because a top-level import of a Node builtin would
 * turn into a `require("crypto")` at the top of main.js — and the mobile app, which has no `require`,
 * would then fail to load the plugin at all, API on or off. The server loads it at runtime (desktop
 * only) and hands it here; the type import below is erased from the build.
 */
import type * as NodeCrypto from "crypto";

export type TokenCrypto = Pick<typeof NodeCrypto, "createHash" | "timingSafeEqual">;

/** Bytes of randomness in a generated token; hex-encoded it is twice as many characters. */
export const TOKEN_BYTES = 24;

/**
 * A fresh token: 24 random bytes as hex. Web Crypto rather than Node's so it works wherever the
 * settings tab does — it is generated the moment the API is switched on, before any server exists.
 */
export function generateToken(): string {
	const bytes = new Uint8Array(TOKEN_BYTES);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The token from an `Authorization: Bearer <token>` header, or undefined if there isn't one. */
export function bearerToken(header: string | string[] | undefined): string | undefined {
	const value = Array.isArray(header) ? header[0] : header;
	if (!value) return undefined;
	const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(value);
	return m ? m[1] : undefined;
}

/**
 * Whether the presented token is the expected one, in time that doesn't depend on how much of it was
 * right.
 *
 * Both sides are hashed first so the comparison is always between two 32-byte digests: timingSafeEqual
 * insists on equal lengths, and checking the lengths first would itself leak the token's length. An
 * empty expected token never matches — an API somehow enabled without one must refuse everything, not
 * accept a bare "Bearer ".
 */
export function tokenMatches(crypto: TokenCrypto, presented: string | undefined, expected: string | undefined): boolean {
	if (!presented || !expected) return false;
	const a = crypto.createHash("sha256").update(presented, "utf8").digest();
	const b = crypto.createHash("sha256").update(expected, "utf8").digest();
	return crypto.timingSafeEqual(a, b);
}
