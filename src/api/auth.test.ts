import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { bearerToken, generateToken, tokenMatches } from "./auth";

describe("generateToken", () => {
	it("is 24 random bytes as hex", () => {
		const token = generateToken();
		expect(token).toMatch(/^[0-9a-f]{48}$/);
		expect(generateToken()).not.toBe(token);
	});
});

describe("bearerToken", () => {
	it("extracts the token from a Bearer header, case-insensitively", () => {
		expect(bearerToken("Bearer abc123")).toBe("abc123");
		expect(bearerToken("bearer   abc123 ")).toBe("abc123");
	});

	it("is undefined for anything else", () => {
		expect(bearerToken(undefined)).toBeUndefined();
		expect(bearerToken("")).toBeUndefined();
		expect(bearerToken("Basic dXNlcjpwYXNz")).toBeUndefined();
		expect(bearerToken("Bearer")).toBeUndefined();
		expect(bearerToken("Bearer a b")).toBeUndefined();
	});
});

describe("tokenMatches", () => {
	it("accepts only the exact token", () => {
		expect(tokenMatches(crypto, "secret", "secret")).toBe(true);
		expect(tokenMatches(crypto, "secreT", "secret")).toBe(false);
		expect(tokenMatches(crypto, "secret-but-longer", "secret")).toBe(false);
	});

	it("never matches when either side is missing or empty", () => {
		expect(tokenMatches(crypto, undefined, "secret")).toBe(false);
		expect(tokenMatches(crypto, "", "")).toBe(false);
		expect(tokenMatches(crypto, "secret", undefined)).toBe(false);
	});
});
