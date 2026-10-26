import * as crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { API_VERSION } from "./health";
import { makeTestPlugin, send } from "./testPlugin";

describe("GET /mmf/v1/health", () => {
	it("reports version, readiness, revision, counts and the portfolio", async () => {
		const t = makeTestPlugin();
		await t.store.load();
		t.store.accounts = [{ id: "acc-1", name: "Checking", type: "debit", currency: "EUR" } as never];
		await t.store.importTransactions([
			{ id: "tx-1", date: "2024-03-01", accountId: "acc-1", description: "Shop", amount: -5, currency: "EUR", source: "manual" },
			{ id: "tx-2", date: "2024-03-02", accountId: "acc-1", description: "Shop", amount: -6, currency: "EUR", source: "manual", review: "approved" },
		]);

		const res = await send(t, crypto, { path: "/health" });
		expect(res.status).toBe(200);
		expect(res.json).toEqual({
			ok: true,
			version: "0.0.0-test",
			ready: true,
			api: API_VERSION,
			revision: t.store.revision,
			counts: {
				accounts: 1,
				categories: t.store.categories.length,
				rules: 0,
				transactions: 2,
				reviewNew: 1,
			},
			portfolio: { id: "pf-test", name: "Test portfolio" },
			dataFolder: "TestFinance",
		});
		expect(res.headers["x-mmf-revision"]).toBe(String(t.store.revision));
	});

	it("answers HEAD with the same status and no body", async () => {
		const res = await send(makeTestPlugin(), crypto, { method: "HEAD", path: "/health" });
		expect(res.status).toBe(200);
	});
});
