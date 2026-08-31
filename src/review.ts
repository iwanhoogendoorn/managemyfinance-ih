import type { Account, Transaction } from "./types";

/**
 * How far a review pass has got, per account.
 *
 * The Review page's own counters read the whole ledger, which is right for one account and misleading
 * for several: importing a second account made "3,950 approved, 0 to review" the answer no matter
 * which account was selected, so the page said the work was finished while a freshly imported account
 * sat entirely unreviewed inside the same number.
 */
export interface ReviewCounts {
	total: number;
	toReview: number;
	approved: number;
	flagged: number;
	/** Counted regardless of review state — a row can be approved and still have no category. */
	uncategorized: number;
}

export function reviewCounts(transactions: Transaction[]): ReviewCounts {
	const counts: ReviewCounts = { total: transactions.length, toReview: 0, approved: 0, flagged: 0, uncategorized: 0 };
	for (const tx of transactions) {
		if (tx.review === "approved") counts.approved++;
		else if (tx.review === "flagged") counts.flagged++;
		// Absent means "new" — the implicit state of anything that arrived from an import.
		else counts.toReview++;
		if (!tx.categoryId) counts.uncategorized++;
	}
	return counts;
}

export interface AccountReviewProgress {
	account: Account;
	counts: ReviewCounts;
}

/**
 * Per-account progress, accounts with something left to do first.
 *
 * Ordered by what still needs attention rather than alphabetically, because the question this answers
 * is "where is the work" — an account that is entirely approved can wait at the bottom, and an empty
 * account has no work at all so it sits below both.
 */
export function accountReviewProgress(transactions: Transaction[], accounts: Account[]): AccountReviewProgress[] {
	const byAccount = new Map<string, Transaction[]>();
	for (const tx of transactions) {
		const bucket = byAccount.get(tx.accountId);
		if (bucket) bucket.push(tx);
		else byAccount.set(tx.accountId, [tx]);
	}

	return accounts
		.map((account) => ({ account, counts: reviewCounts(byAccount.get(account.id) ?? []) }))
		.sort((a, b) => {
			const outstandingA = a.counts.toReview + a.counts.flagged;
			const outstandingB = b.counts.toReview + b.counts.flagged;
			if (outstandingA !== outstandingB) return outstandingB - outstandingA;
			if (a.counts.uncategorized !== b.counts.uncategorized) return b.counts.uncategorized - a.counts.uncategorized;
			return b.counts.total - a.counts.total;
		});
}
