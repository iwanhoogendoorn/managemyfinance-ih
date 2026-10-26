import { App } from "obsidian";
import type FinancePlugin from "../main";
import { DEFAULT_SETTINGS, FinanceStore, type FinanceSettings } from "../store";
import type { TokenCrypto } from "./auth";
import { handleApiRequest, type ApiRequest, type ApiResponse } from "./pipeline";
import { Router } from "./router";
import { buildRouter } from "./server";

/**
 * Test-only scaffolding for the API: a plugin-shaped object over a real FinanceStore on the in-memory
 * vault adapter, and a one-call way to push a request through the whole pipeline. Shared so every
 * endpoint module's tests exercise the same auth, gates and headers a real request goes through,
 * rather than each test faking its own slightly different plugin. Never imported by production code.
 */

export const TEST_TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef";

export interface TestPlugin {
	plugin: FinancePlugin;
	store: FinanceStore;
	settings: FinanceSettings;
	/** How many times refreshViews() has run. */
	refreshes(): number;
}

export function makeTestPlugin(settings: Partial<FinanceSettings> = {}): TestPlugin {
	const app = new App();
	const merged: FinanceSettings = {
		...DEFAULT_SETTINGS,
		dataFolder: "TestFinance",
		apiEnabled: true,
		apiToken: TEST_TOKEN,
		...settings,
	};
	const store = new FinanceStore(app as never, merged);
	let refreshes = 0;
	const plugin = {
		// The same in-memory vault the store writes to, for routes that write a note through the app.
		app,
		settings: merged,
		store,
		manifest: { version: "0.0.0-test" },
		activePortfolio: { id: "pf-test", name: "Test portfolio", folder: merged.dataFolder },
		refreshViews: () => {
			refreshes++;
		},
		saveSettings: async () => undefined,
	};
	return { plugin: plugin as unknown as FinancePlugin, store, settings: merged, refreshes: () => refreshes };
}

export interface TestRequest {
	method?: string;
	/** Path relative to the API base, e.g. "/health", or a full path starting with "/mmf". */
	path: string;
	/** An object is sent as JSON; a string is sent as-is. */
	body?: unknown;
	/** Defaults to the test token; pass null to send no Authorization header. */
	token?: string | null;
	remoteAddress?: string;
	headers?: Record<string, string>;
}

/**
 * Runs one request through handleApiRequest. `crypto` is Node's, passed in by the test (await
 * import("node:crypto")) so this file stays free of any Node import itself.
 */
export async function send(
	t: TestPlugin,
	crypto: TokenCrypto,
	req: TestRequest,
	router: Router = buildRouter(),
	log?: (...args: unknown[]) => void
): Promise<ApiResponse & { json: unknown }> {
	const headers: Record<string, string> = { ...req.headers };
	const token = req.token === undefined ? TEST_TOKEN : req.token;
	if (token !== null) headers.authorization = `Bearer ${token}`;
	const raw = req.body === undefined ? "" : typeof req.body === "string" ? req.body : JSON.stringify(req.body);
	const request: ApiRequest = {
		method: req.method ?? "GET",
		url: req.path.startsWith("/mmf") ? req.path : `/mmf/v1${req.path}`,
		headers,
		remoteAddress: req.remoteAddress ?? "127.0.0.1",
		readBody: async () => raw,
	};
	const response = await handleApiRequest({ router, plugin: t.plugin, crypto, log }, request);
	return { ...response, json: response.body ? JSON.parse(response.body) : undefined };
}
