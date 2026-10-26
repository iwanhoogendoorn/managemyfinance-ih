import { reviewCounts } from "../review";
import type { Router } from "./router";

/** Bumped only when a change would break an existing client; additions to a response don't count. */
export const API_VERSION = 1;

/**
 * GET /health — "is it up, and is it the vault I think it is".
 *
 * The counts are there so a client can sanity-check it is talking to the right portfolio before it
 * writes anything, and `revision` so it can tell whether anything changed since it last looked.
 */
export function register(router: Router): void {
	router.get("/health", (ctx) => {
		const store = ctx.store();
		const portfolio = ctx.plugin.activePortfolio;
		return {
			ok: true,
			version: ctx.plugin.manifest.version,
			ready: !!store,
			api: API_VERSION,
			revision: store?.revision ?? 0,
			counts: {
				accounts: store?.accounts.length ?? 0,
				categories: store?.categories.length ?? 0,
				rules: store?.rules.length ?? 0,
				transactions: store?.transactions.length ?? 0,
				reviewNew: store ? reviewCounts(store.transactions).toReview : 0,
			},
			portfolio: portfolio ? { id: portfolio.id, name: portfolio.name } : null,
			dataFolder: ctx.plugin.settings.dataFolder,
		};
	});
}
