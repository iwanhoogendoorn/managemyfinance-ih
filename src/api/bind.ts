/**
 * Which address the local API listens on, and who is treated as "this machine".
 *
 * Pure functions over plain data — the interface table comes from os.networkInterfaces() in server.ts —
 * so the network policy can be tested without a network.
 */
import type { ApiBindMode } from "../store";

export const LOOPBACK_HOST = "127.0.0.1";

/** The subset of os.networkInterfaces() this needs. */
export type InterfaceTable = Record<string, { address: string; family: string | number; internal: boolean }[] | undefined>;

function ipv4Octets(address: string): number[] | null {
	const plain = address.startsWith("::ffff:") ? address.slice(7) : address;
	const parts = plain.split(".");
	if (parts.length !== 4) return null;
	const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
	return octets.every((o) => o >= 0 && o <= 255) ? octets : null;
}

/** 127.0.0.0/8, ::1, and the IPv4-mapped form of the former. */
export function isLoopbackAddress(address: string | undefined): boolean {
	if (!address) return false;
	if (address === "::1") return true;
	const o = ipv4Octets(address);
	return !!o && o[0] === 127;
}

/**
 * The addresses Tailscale hands out: 100.64.0.0/10 (the CGNAT block it uses for IPv4) and its IPv6
 * ULA prefix fd7a:115c:a1e0::/48.
 */
export function isTailscaleAddress(address: string | undefined): boolean {
	if (!address) return false;
	if (address.toLowerCase().startsWith("fd7a:115c:a1e0:")) return true;
	const o = ipv4Octets(address);
	return !!o && o[0] === 100 && o[1] >= 64 && o[1] <= 127;
}

/** This machine's tailnet IPv4 address, if it has one. */
export function tailscaleAddress(interfaces: InterfaceTable): string | undefined {
	for (const list of Object.values(interfaces)) {
		for (const entry of list ?? []) {
			// `family` is "IPv4" on current Node and the number 4 on the Node 18.0–18.3 some Electron
			// builds shipped, so both spellings are accepted.
			const v4 = entry.family === "IPv4" || entry.family === 4;
			if (v4 && !entry.internal && isTailscaleAddress(entry.address)) return entry.address;
		}
	}
	return undefined;
}

/**
 * The host to listen on. "tailscale" binds the tailnet address only — never 0.0.0.0, which would also
 * answer on the café Wi-Fi — and falls back to loopback when this machine isn't on a tailnet, saying so
 * via `fellBack` so the caller can tell the user rather than leave them wondering why the phone can't
 * connect.
 */
export function pickBindHost(mode: ApiBindMode | undefined, interfaces: InterfaceTable): { host: string; fellBack: boolean } {
	if (mode !== "tailscale") return { host: LOOPBACK_HOST, fellBack: false };
	const host = tailscaleAddress(interfaces);
	return host ? { host, fellBack: false } : { host: LOOPBACK_HOST, fellBack: true };
}

/** Methods that can't change anything — the only ones a remote client may use while remote writes are off. */
export function isReadMethod(method: string): boolean {
	const upper = method.toUpperCase();
	return upper === "GET" || upper === "HEAD";
}

/**
 * Headers a reverse proxy adds when it forwards someone else's request.
 *
 * `tailscale serve` — the recommended way to put HTTPS in front of this — proxies from 127.0.0.1, so
 * the socket alone would make a request from your phone look local and walk straight past the
 * remote-write switch. A loopback request carrying any of these was relayed for another device and is
 * treated as remote.
 */
const FORWARDING_HEADERS = ["x-forwarded-for", "forwarded", "x-real-ip", "tailscale-user-login"];

/** Whether a request originates on this machine: a loopback socket, not relayed by a proxy. */
export function isLocalRequest(remoteAddress: string | undefined, headers: Record<string, string | string[] | undefined>): boolean {
	if (!isLoopbackAddress(remoteAddress)) return false;
	return !FORWARDING_HEADERS.some((h) => headers[h] !== undefined);
}

/**
 * Whether a client may talk to the API at all. Loopback always may; a tailnet peer may only when the
 * API is bound to the tailnet. Defence in depth — the bind address already decides who can reach the
 * socket — so a misconfigured bind still can't open the API to the whole LAN.
 */
export function isClientAllowed(remoteAddress: string | undefined, mode: ApiBindMode | undefined): boolean {
	if (isLoopbackAddress(remoteAddress)) return true;
	return mode === "tailscale" && isTailscaleAddress(remoteAddress);
}
