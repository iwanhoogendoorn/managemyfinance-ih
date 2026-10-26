import * as crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Router } from "./router";
import { ApiServer, type NodeModules } from "./server";
import { makeTestPlugin, TEST_TOKEN, type TestPlugin } from "./testPlugin";

/**
 * The server over a real socket on 127.0.0.1: lifecycle, the body limit, connection teardown, and the
 * promise that with the API off nothing here touches Node at all.
 */

const NODE: NodeModules = { http, os, crypto };

interface Harness {
	t: TestPlugin;
	server: ApiServer;
	loads: () => number;
	notices: string[];
}

const running: ApiServer[] = [];
afterEach(async () => {
	await Promise.all(running.splice(0).map((s) => s.stop()));
});

function harness(
	settings: Parameters<typeof makeTestPlugin>[0] = {},
	desktop = true,
	modules: NodeModules = NODE,
	router?: () => Router
): Harness {
	// Port 0 lets the OS pick a free one, so parallel test files never collide.
	const t = makeTestPlugin({ apiPort: 0, ...settings });
	let loads = 0;
	const notices: string[] = [];
	const server = new ApiServer(t.plugin, {
		load: () => {
			loads++;
			return modules;
		},
		isDesktop: () => desktop,
		notify: (m) => notices.push(m),
		log: () => undefined,
		router,
	});
	running.push(server);
	return { t, server, loads: () => loads, notices };
}

function portOf(server: ApiServer): number {
	return Number(new URL(server.urls()[0]).port);
}

interface Result {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
	socket: import("net").Socket;
}

function request(
	port: number,
	o: { method?: string; path?: string; token?: string | null; body?: string; headers?: Record<string, string>; agent?: http.Agent } = {}
): Promise<Result> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = { ...o.headers };
		const token = o.token === undefined ? TEST_TOKEN : o.token;
		if (token !== null) headers.authorization = `Bearer ${token}`;
		const req = http.request(
			{ host: "127.0.0.1", port, method: o.method ?? "GET", path: o.path ?? "/mmf/v1/health", headers, agent: o.agent },
			(res) => {
				// Captured now: a kept-alive socket is handed back to the agent by the time "end" fires.
				const socket = res.socket;
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (c: string) => (body += c));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body, socket }));
			}
		);
		req.on("error", reject);
		if (o.body !== undefined) req.write(o.body);
		req.end();
	});
}

describe("ApiServer while the API is off", () => {
	it("doesn't start, and never loads Node, when apiEnabled is false (the default)", async () => {
		const h = harness({ apiEnabled: false });
		await h.server.start();
		await h.server.restart();
		expect(h.loads()).toBe(0);
		expect(h.server.running).toBe(false);
		expect(h.server.urls()).toEqual([]);
	});

	it("doesn't start, and never loads Node, outside the desktop app even when enabled", async () => {
		const h = harness({}, false);
		await h.server.start();
		expect(h.loads()).toBe(0);
		expect(h.server.running).toBe(false);
	});

	it("keeps every Node builtin out of the API layer's top-level imports, so main.js still loads on mobile", () => {
		// A value import of a builtin becomes a require() at the top of the bundle, which the mobile app
		// can't satisfy. Type-only imports are erased. Tests are exempt — they never ship.
		const dir = join(__dirname);
		const files = readdirSync(dir)
			.filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
			.map((f) => join(dir, f))
			.concat([join(dir, "..", "main.ts"), join(dir, "..", "store.ts"), join(dir, "..", "settings", "SettingsTab.ts")]);
		const builtin = /^import\s+(?!type\b)[^;]*?from\s+"(node:)?(http|https|net|os|crypto|fs|child_process)"/m;
		for (const file of files) expect(builtin.test(readFileSync(file, "utf8")), file).toBe(false);
	});
});

describe("ApiServer over a real socket", () => {
	it("serves /health with the standard headers", async () => {
		const h = harness();
		await h.server.start();
		expect(h.server.running).toBe(true);
		expect(h.server.urls()[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mmf\/v1$/);

		const res = await request(portOf(h.server));
		expect(res.status).toBe(200);
		expect(JSON.parse(res.body)).toMatchObject({ ok: true, api: 1 });
		expect(res.headers["cache-control"]).toBe("no-store");
		expect(res.headers["x-content-type-options"]).toBe("nosniff");
		expect(res.headers["content-type"]).toBe("application/json; charset=utf-8");
		expect(res.headers["x-mmf-revision"]).toMatch(/^\d+$/);
	});

	it("401s without the token over the wire too", async () => {
		const h = harness();
		await h.server.start();
		const res = await request(portOf(h.server), { token: null });
		expect(res.status).toBe(401);
		expect(JSON.parse(res.body)).toEqual({ error: "Missing or invalid bearer token" });
	});

	it("413s a body declared larger than 1 MB without reading it, and closes the connection", async () => {
		const router = new Router();
		let handled = false;
		router.post("/echo", (ctx) => {
			handled = true;
			return ctx.body;
		});
		const h = harness({}, true, NODE, () => router);
		await h.server.start();
		const res = await new Promise<{ status: number; body: string; connection?: string }>((resolve, reject) => {
			const req = http.request(
				{
					host: "127.0.0.1",
					port: portOf(h.server),
					method: "POST",
					path: "/mmf/v1/echo",
					headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-length": String(1024 * 1024 + 1) },
				},
				(r) => {
					let body = "";
					r.on("data", (c: Buffer) => (body += c.toString("utf8")));
					r.on("end", () => {
						req.destroy();
						resolve({ status: r.statusCode ?? 0, body, connection: r.headers.connection });
					});
				}
			);
			req.on("error", reject);
			// Headers only, no body: the server has to answer from the declared length alone.
			req.flushHeaders();
		});
		expect(res.status).toBe(413);
		expect(JSON.parse(res.body)).toEqual({ error: "Request body is larger than 1 MB" });
		expect(res.connection).toBe("close");
		expect(handled).toBe(false);
	});

	it("accepts a body right up to the limit, and 400s one that isn't JSON", async () => {
		const router = new Router();
		router.post("/echo", (ctx) => ({ length: (ctx.body as string).length }));
		const h = harness({}, true, NODE, () => router);
		await h.server.start();
		const port = portOf(h.server);
		// A JSON string literal: two quote characters plus the payload, landing exactly on 1 MB.
		const atLimit = JSON.stringify("x".repeat(1024 * 1024 - 2));
		const ok = await request(port, { method: "POST", path: "/mmf/v1/echo", body: atLimit, headers: { "content-type": "application/json" } });
		expect(ok.status).toBe(200);
		expect(JSON.parse(ok.body)).toEqual({ length: 1024 * 1024 - 2 });
		const bad = await request(port, { method: "POST", path: "/mmf/v1/echo", body: "{nope" });
		expect(bad.status).toBe(400);
		expect(JSON.parse(bad.body)).toEqual({ error: "Request body is not valid JSON" });
	});

	it("closes kept-alive connections on stop, so an old socket can't keep talking", async () => {
		const h = harness();
		await h.server.start();
		const port = portOf(h.server);
		const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
		try {
			const first = await request(port, { agent });
			expect(first.status).toBe(200);
			const closed = new Promise<void>((resolve) => first.socket.once("close", () => resolve()));
			await h.server.stop();
			await closed;
			expect(h.server.running).toBe(false);
			await expect(request(port, { agent })).rejects.toThrow();
		} finally {
			agent.destroy();
		}
	});

	it("restart picks up the new settings, and stops for good once disabled", async () => {
		const h = harness();
		await h.server.start();
		expect(h.server.running).toBe(true);
		h.t.settings.apiEnabled = false;
		await h.server.restart();
		expect(h.server.running).toBe(false);
		h.t.settings.apiEnabled = true;
		await h.server.restart();
		expect(h.server.running).toBe(true);
		expect((await request(portOf(h.server))).status).toBe(200);
	});

	it("reports a port already in use as a notice instead of throwing", async () => {
		const squatter = http.createServer();
		await new Promise<void>((resolve) => squatter.listen(0, "127.0.0.1", () => resolve()));
		const taken = (squatter.address() as { port: number }).port;
		try {
			const h = harness({ apiPort: taken });
			await expect(h.server.start()).resolves.toBeUndefined();
			expect(h.server.running).toBe(false);
			expect(h.notices.join("\n")).toMatch(new RegExp(`port ${taken} is already in use`));
		} finally {
			await new Promise<void>((resolve) => squatter.close(() => resolve()));
		}
	});

	it("generates a token on start when none is stored", async () => {
		const h = harness({ apiToken: undefined });
		await h.server.start();
		expect(h.t.settings.apiToken).toMatch(/^[0-9a-f]{48}$/);
	});

	it("falls back to loopback with a notice when bound to Tailscale on a machine without it", async () => {
		const h = harness({ apiBind: "tailscale" }, true, { http, crypto, os: { networkInterfaces: () => ({}) } });
		await h.server.start();
		expect(h.server.urls()[0]).toMatch(/^http:\/\/127\.0\.0\.1:/);
		expect(h.notices.join("\n")).toMatch(/no Tailscale address/);
	});
});
