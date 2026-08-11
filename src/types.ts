/** A fully separate set of accounts/categories/transactions/subscriptions — one per person or entity managed. */
export interface Portfolio {
	id: string;
	name: string;
	/** Vault-relative folder this portfolio's data lives under (its own data/ and reports/ subfolders). */
	folder: string;
}

export type AccountType = "debit" | "credit" | "investing" | "saving" | "cash" | "crypto";

export interface Account {
	id: string;
	name: string;
	institution?: string;
	type: AccountType;
	currency: string;
	openingBalance?: number;
	openingDate?: string;
	/** IBAN (or other bank account identifier), used to auto-attribute rows from combined multi-account exports. */
	iban?: string;
	/** Manually-entered current market value for investing/crypto accounts — the honest alternative to a live
	 *  price feed. Falls back to cost basis everywhere when unset; every derived figure shows marketValueAsOf. */
	marketValue?: number;
	/** ISO date the marketValue was last updated — surfaced next to derived figures, nagged past 90 days. */
	marketValueAsOf?: string;
	/** Credit accounts: the card's limit — drives the utilization meter. Tile hidden entirely when unset. */
	creditLimit?: number;
	/** Savings accounts: target amount for goal-progress display. */
	goalAmount?: number;
	/** Savings accounts: optional target date for the goal. */
	goalDate?: string;
	/** Credit accounts: day of month (1–28) the statement cycle starts; calendar month when unset. */
	statementDay?: number;
}

export interface Category {
	id: string;
	name: string;
	color: string;
	icon: string;
	aliases: string[];
	budget?: number;
	archived?: boolean;
	/**
	 * The top-level category this one refines, e.g. "Groceries" under "Food". Absent means this IS a
	 * top-level category — which every category was before subcategories existed, so old data and any
	 * code that ignores this field keep working unchanged.
	 *
	 * Exactly two levels: a category with a parent can never itself be a parent (enforced in the
	 * category manager). Deeper trees make every roll-up ambiguous and every picker unreadable, for a
	 * granularity nobody managing a household budget has ever actually wanted.
	 *
	 * A transaction may point at either level. Assigning to "Food" directly still means "food,
	 * unspecified" — subcategories refine, they don't force a choice.
	 */
	parentId?: string;
}

export interface CategoryRule {
	id: string;
	pattern: string;
	isRegex?: boolean;
	categoryId: string;
}

export type SubscriptionBillingCycle = "weekly" | "monthly" | "quarterly" | "yearly";
export type SubscriptionPaidVia = "private" | "business";

export interface Subscription {
	id: string;
	name: string;
	plan?: string;
	website?: string;
	category: string;
	cost: number;
	billingCycle: SubscriptionBillingCycle;
	paidVia: SubscriptionPaidVia;
	/** Free-text tag, e.g. "SaaS" / "Not SaaS" — not used for any calculation. */
	kind?: string;
	/** The Account this subscription is actually debited from (optional — unset means unknown/not tracked). */
	accountId?: string;
	nextDueDate: string;
	endDate?: string;
	cancelUrl?: string;
	notes?: string;
	archived?: boolean;
	/** Normalized ledger merchant key this subscription was detected from (see subscriptionDetect.ts) —
	 *  links a tracked subscription back to its recurring charges so detection can dedupe against it. */
	merchantKey?: string;
}

export type CardType = "debit" | "credit" | "prepaid" | "secured" | "charge";
export type CardNetwork = "visa" | "mastercard" | "amex" | "discover" | "other";

/**
 * A physical/digital payment card — always linked to exactly one Account, but counted and managed
 * completely separately: an account can have zero cards (a CD, a retirement account), one, or several
 * (a primary + a supplementary debit card on the same checking account).
 */
export interface Card {
	id: string;
	accountId: string;
	/** Your own label, e.g. "Amex Platinum" — also drives the stylized card art (tier/network lookup). */
	name: string;
	issuer?: string;
	/** Product tier, e.g. "Platinum", "Sapphire Reserve" — matched against known tiers for the card's look. */
	product?: string;
	network: CardNetwork;
	cardType: CardType;
	last4?: string;
	/** MM/YY */
	expiry?: string;
	isPrimary?: boolean;
	notes?: string;
}

export type TransactionSource = "ing" | "trade-republic" | "generic" | "manual";

export interface Transaction {
	id: string;
	date: string;
	accountId: string;
	description: string;
	counterparty?: string;
	amount: number;
	currency: string;
	categoryId?: string;
	type?: string;
	/** Bank's own transaction code (e.g. ING's "IW", "BA", "GT"). */
	code?: string;
	source: TransactionSource;
	raw?: string;
	notes?: string;
	ticker?: string;
	assetClass?: string;
	shares?: number;
	price?: number;
	fee?: number;
	tax?: number;
	action?: string;
	/** Vault-relative path to a linked receipt/invoice file, e.g. "Finance/attachments/receipt.pdf". */
	attachmentPath?: string;
}
