import { describe, expect, it } from "vitest";
import {
	isClientAllowed,
	isLocalRequest,
	isLoopbackAddress,
	isReadMethod,
	isTailscaleAddress,
	pickBindHost,
	type InterfaceTable,
} from "./bind";

const WITH_TAILSCALE: InterfaceTable = {
	lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
	en0: [{ address: "192.168.1.20", family: "IPv4", internal: false }],
	utun4: [
		{ address: "fd7a:115c:a1e0::1", family: "IPv6", internal: false },
		{ address: "100.101.102.103", family: "IPv4", internal: false },
	],
};

describe("address classes", () => {
	it("knows loopback in all its spellings", () => {
		for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(a)).toBe(true);
		for (const a of [undefined, "", "10.0.0.1", "::ffff:10.0.0.1", "128.0.0.1", "localhost"]) expect(isLoopbackAddress(a)).toBe(false);
	});

	it("knows Tailscale's 100.64.0.0/10 and its IPv6 prefix, and nothing either side", () => {
		for (const a of ["100.64.0.1", "100.127.255.254", "::ffff:100.100.100.100", "fd7a:115c:a1e0::abcd"]) expect(isTailscaleAddress(a)).toBe(true);
		for (const a of ["100.63.255.255", "100.128.0.1", "192.168.1.1", "fd00::1"]) expect(isTailscaleAddress(a)).toBe(false);
	});

	it("treats only GET and HEAD as reads", () => {
		expect(isReadMethod("get")).toBe(true);
		expect(isReadMethod("HEAD")).toBe(true);
		for (const m of ["POST", "PATCH", "PUT", "DELETE", "OPTIONS"]) expect(isReadMethod(m)).toBe(false);
	});
});

describe("pickBindHost", () => {
	it("binds loopback by default", () => {
		expect(pickBindHost(undefined, WITH_TAILSCALE)).toEqual({ host: "127.0.0.1", fellBack: false });
		expect(pickBindHost("loopback", WITH_TAILSCALE)).toEqual({ host: "127.0.0.1", fellBack: false });
	});

	it("binds the tailnet IPv4 address, never the LAN one", () => {
		expect(pickBindHost("tailscale", WITH_TAILSCALE)).toEqual({ host: "100.101.102.103", fellBack: false });
	});

	it("falls back to loopback, and says so, without a tailnet address", () => {
		const { utun4: _, ...noTailscale } = WITH_TAILSCALE;
		expect(pickBindHost("tailscale", noTailscale)).toEqual({ host: "127.0.0.1", fellBack: true });
	});

	it("accepts the numeric family some Node versions report", () => {
		expect(pickBindHost("tailscale", { tun: [{ address: "100.64.1.2", family: 4, internal: false }] }).host).toBe("100.64.1.2");
	});
});

describe("who counts as this machine", () => {
	it("is a loopback socket with no proxy headers", () => {
		expect(isLocalRequest("127.0.0.1", {})).toBe(true);
		expect(isLocalRequest("100.64.0.5", {})).toBe(false);
	});

	it("treats a request relayed by tailscale serve (or any proxy) as remote", () => {
		expect(isLocalRequest("127.0.0.1", { "x-forwarded-for": "100.64.0.5" })).toBe(false);
		expect(isLocalRequest("127.0.0.1", { "tailscale-user-login": "someone@example.com" })).toBe(false);
		expect(isLocalRequest("::1", { forwarded: "for=100.64.0.5" })).toBe(false);
	});

	it("lets only loopback in, plus tailnet peers when bound to the tailnet", () => {
		expect(isClientAllowed("127.0.0.1", "loopback")).toBe(true);
		expect(isClientAllowed("100.64.0.5", "loopback")).toBe(false);
		expect(isClientAllowed("100.64.0.5", "tailscale")).toBe(true);
		expect(isClientAllowed("192.168.1.30", "tailscale")).toBe(false);
	});
});
