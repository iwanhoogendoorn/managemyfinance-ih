import { Notice, Platform } from "obsidian";
import type * as NodeHttp from "http";
import type * as NodeOs from "os";
import type { Socket } from "net";
import type FinancePlugin from "../main";
import { DEFAULT_API_PORT } from "../store";
import { generateToken, type TokenCrypto } from "./auth";
import { pickBindHost } from "./bind";
import { handleApiRequest, MAX_BODY_BYTES, type ApiRequest, type ApiResponse, type PipelineDeps } from "./pipeline";
import { API_BASE, HttpError, Router } from "./router";
import * as routeModules from "./routes";

/**
 * The local API's socket plumbing and lifecycle: start, stop, restart, and the Node request/response
 * on either side of pipeline.ts.
 *
 * Node's http, os and crypto are required at runtime, inside start(), and only once the API is both
 * switched on and running in the desktop app. A top-level import would become a `require("http")` at
 * the top of main.js, which the mobile app — no Node, no `require` — would fail on while loading the
 * plugin, API off or not. With the API off nothing here touches Node at all.
 */

export interface NodeModules {
	http: Pick<typeof NodeHttp, "createServer">;
	os: Pick<typeof NodeOs, "networkInterfaces">;
	crypto: TokenCrypto;
}

/** Node builtins via the renderer's own `require`, the way the Claude CLI provider reaches child_process. */
export function loadNodeModules(): NodeModules {
	const req = (globalThis as unknown as { require?: (id: string) => unknown }).require;
	if (typeof req !== "function") throw new Error("Node isn't available here — the local API needs the desktop app.");
	// Bare names, not "node:http": the prefix only resolves on Node 14.18+, and an old Obsidian installer
	// can still be running an Electron that predates it.
	return {
		http: req("http") as NodeModules["http"],
		os: req("os") as NodeModules["os"],
		crypto: req("crypto") as TokenCrypto,
	};
}

/** A router with every module listed in routes.ts registered on it. */
export function buildRouter(): Router {
	const router = new Router();
	for (const register of Object.values(routeModules)) register(router);
	return router;
}

/**
 * Reads a request body up to MAX_BODY_BYTES. A declared Content-Length over the limit is refused before
 * a byte is read; a body that turns out longer than declared (or chunked) is refused the moment it
 * crosses the line, and the rest is drained rather than buffered.
 */
function readBody(req: NodeHttp.IncomingMessage): Promise<string> {
	const tooLarge = (): HttpError => new HttpError(413, "Request body is larger than 1 MB");
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		req.resume();
		return Promise.reject(tooLarge());
	}
	return new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		req.on("data", (chunk: Buffer) => {
			if (settled) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				settled = true;
				chunks.length = 0;
				reject(tooLarge());
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (settled) return;
			settled = true;
			resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", (err) => {
			if (settled) return;
			settled = true;
			reject(err);
		});
	});
}

export interface ApiServerOptions {
	/** How Node is reached. Tests pass the real modules directly; the plugin uses loadNodeModules. */
	load?: () => NodeModules;
	/** Whether this is the desktop app. Defaults to Obsidian's Platform.isDesktopApp. */
	isDesktop?: () => boolean;
	/** Where user-facing problems (port taken, no tailnet) are reported. Defaults to a Notice. */
	notify?: (message: string) => void;
	log?: (...args: unknown[]) => void;
	/** The routes to serve. Defaults to buildRouter(); tests swap in their own. */
	router?: () => Router;
}

export class ApiServer {
	private server?: NodeHttp.Server;
	private sockets = new Set<Socket>();
	/** start/stop/restart run one at a time, in order, so a burst of settings changes can't leave two
	 *  servers fighting over the port or a stop overtaking the start it was meant to undo. */
	private queue: Promise<void> = Promise.resolve();
	private host?: string;
	private port?: number;

	constructor(private plugin: FinancePlugin, private opts: ApiServerOptions = {}) {}

	get running(): boolean {
		return !!this.server;
	}

	/** Where the API can be reached right now; empty while it isn't running. */
	urls(): string[] {
		return this.server && this.host && this.port !== undefined ? [`http://${this.host}:${this.port}${API_BASE}`] : [];
	}

	start(): Promise<void> {
		return this.enqueue(() => this.doStart());
	}

	/**
	 * Closes the listener and destroys every open connection, kept-alive ones included. Without the
	 * second half a client that connected before the token was regenerated could keep sending requests
	 * down its old socket. Queued behind any start still in flight — so an unload mid-start still ends
	 * with nothing listening — and otherwise run straight away; the returned promise only waits for
	 * Node to confirm the listener has closed.
	 */
	stop(): Promise<void> {
		return this.enqueue(() => this.doStop());
	}

	/** Close then start, picking up whatever the settings now say. Called on every API setting change. */
	restart(): Promise<void> {
		return this.enqueue(async () => {
			await this.doStop();
			await this.doStart();
		});
	}

	private enqueue(task: () => Promise<void>): Promise<void> {
		const next = this.queue.then(task, task);
		this.queue = next.catch(() => undefined);
		return next;
	}

	private notify(message: string): void {
		(this.opts.notify ?? ((m: string) => new Notice(m, 10000)))(message);
	}

	private async doStart(): Promise<void> {
		const settings = this.plugin.settings;
		if (this.server || !settings.apiEnabled) return;
		if (!(this.opts.isDesktop ?? (() => Platform.isDesktopApp))()) return;

		let modules: NodeModules;
		try {
			modules = (this.opts.load ?? loadNodeModules)();
		} catch (err) {
			this.notify(`Local API couldn't start: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		// Normally generated when the switch is flipped; this covers a data.json edited by hand.
		if (!settings.apiToken) {
			settings.apiToken = generateToken();
			await this.plugin.saveSettings();
		}

		const { host, fellBack } = pickBindHost(settings.apiBind, modules.os.networkInterfaces());
		if (fellBack) this.notify("Local API: this machine has no Tailscale address, so it is listening on 127.0.0.1 only.");
		const port = settings.apiPort ?? DEFAULT_API_PORT;

		const deps: PipelineDeps = { router: (this.opts.router ?? buildRouter)(), plugin: this.plugin, crypto: modules.crypto, log: this.opts.log };
		const server = modules.http.createServer((req, res) => void this.serve(deps, req, res));
		server.on("connection", (socket: Socket) => {
			this.sockets.add(socket);
			socket.on("close", () => this.sockets.delete(socket));
		});

		const listening = await new Promise<boolean>((resolve) => {
			const onError = (err: NodeJS.ErrnoException): void => {
				server.off("listening", onListening);
				this.notify(
					err.code === "EADDRINUSE"
						? `Local API: port ${port} is already in use. Pick another port in Settings → Local API.`
						: `Local API couldn't listen on ${host}:${port}: ${err.code ?? err.message}`
				);
				resolve(false);
			};
			const onListening = (): void => {
				server.off("error", onError);
				resolve(true);
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(port, host);
		});
		if (!listening) return;

		server.on("error", (err) => (this.opts.log ?? console.error)("[mmf/api] server error:", err));
		this.server = server;
		this.host = host;
		// The port actually bound — differs from the setting only when it was 0, which tests use.
		const address = server.address();
		this.port = typeof address === "object" && address ? address.port : port;
	}

	private doStop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.host = undefined;
		this.port = undefined;
		if (!server) return Promise.resolve();
		const closed = new Promise<void>((resolve) => server.close(() => resolve()));
		// closeAllConnections is Node 18.2+; the socket set covers older Electron builds too.
		(server as { closeAllConnections?: () => void }).closeAllConnections?.();
		for (const socket of this.sockets) socket.destroy();
		this.sockets.clear();
		return closed;
	}

	private async serve(deps: PipelineDeps, req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse): Promise<void> {
		const request: ApiRequest = {
			method: req.method ?? "GET",
			url: req.url ?? "/",
			headers: req.headers,
			remoteAddress: req.socket.remoteAddress,
			readBody: () => readBody(req),
		};
		let response: ApiResponse;
		try {
			response = await handleApiRequest(deps, request);
		} catch (err) {
			// The pipeline answers handler failures itself; reaching here means the pipeline broke.
			(this.opts.log ?? console.error)("[mmf/api] pipeline failed:", err instanceof Error ? err.stack ?? err.message : err);
			response = {
				status: 500,
				headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Type": "application/json; charset=utf-8" },
				body: JSON.stringify({ error: "Internal error" }),
			};
		}
		// A body refused part-way is still arriving; closing is cheaper than draining up to who knows how much.
		if (response.status === 413) response.headers["Connection"] = "close";
		res.writeHead(response.status, { ...response.headers, "Content-Length": String(Buffer.byteLength(response.body)) });
		res.end(request.method.toUpperCase() === "HEAD" ? undefined : response.body);
	}
}
