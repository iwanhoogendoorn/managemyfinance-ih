import { Notice } from "obsidian";
import { ACCOUNT_TYPE_META } from "../constants";
import { formatMoney } from "../format";
import type FinancePlugin from "../main";
import type { Account, AccountType } from "../types";
import { icon } from "../ui/dom";
import { openImportWizard } from "../wizards/ImportWizard";

/**
 * Flow A — first-run setup, rendered into the workspace body rather than as a modal.
 *
 * A full tab, not a dialog, for one reason: setup is abandonable. You can leave it to go find your
 * bank export and come back to exactly where you were, because the only state it holds is
 * `onboardingCompleted` plus whatever it has already written (a renamed portfolio, real accounts).
 * A modal would have to choose between trapping you and losing your place.
 *
 * Every step can be skipped, and skipping *anywhere* sets `onboardingCompleted` — a setup flow that
 * re-appears after you told it to go away is a nag, not an onboarding.
 */

const STEPS = ["welcome", "categories", "account", "import", "done"] as const;
type StepId = (typeof STEPS)[number];

const STEP_META: Record<StepId, { title: string; icon: string }> = {
	welcome: { title: "Welcome", icon: "hand" },
	categories: { title: "Categories", icon: "tags" },
	account: { title: "Accounts", icon: "landmark" },
	import: { title: "Transactions", icon: "download" },
	done: { title: "Done", icon: "check" },
};

interface SetupState {
	step: StepId;
	/**
	 * True from the moment the user commits to setup until they finish or skip it. Without it,
	 * creating the first account would flip `accounts.length === 0` to false and throw the user out
	 * of setup at exactly the moment they were making progress in it.
	 */
	inProgress: boolean;
	/** Categories installed this session — drives the confirmation line on later steps. */
	categoriesInstalled: boolean;
	useStandardCategories: boolean;
	/** Accounts created during setup, so the step can list what you just added. */
	created: Account[];
	imported?: { added: number; skipped: number };
}

/**
 * Setup state, keyed on the body element it is being rendered into — i.e. one per Finance leaf.
 *
 * Survives a re-render of the body (each nav click rebuilds it) but not a reload, which is right:
 * everything durable is already written to disk by the time it matters. It used to be a module
 * singleton, so a second Finance leaf shared one `step`/`inProgress` — only the leaf you clicked in
 * re-rendered, and the other one's Back button acted on state it wasn't showing.
 */
const stateByHost = new WeakMap<HTMLElement, SetupState>();

function stateFor(host: HTMLElement): SetupState {
	let state = stateByHost.get(host);
	if (!state) {
		state = { step: "welcome", inProgress: false, categoriesInstalled: false, useStandardCategories: true, created: [] };
		stateByHost.set(host, state);
	}
	return state;
}

/**
 * Set by the "restart setup" command and consumed by the next render. A module flag because the
 * command has no body element to key per-leaf state on — and unlike first run, a restart must also
 * show setup when accounts already exist, which `shouldShowSetup`'s normal gate would refuse.
 */
let pendingRestart = false;

/** Re-enters first-run setup on demand — Skip is no longer a one-way door. */
export async function restartSetup(plugin: FinancePlugin): Promise<void> {
	pendingRestart = true;
	plugin.settings.onboardingCompleted = false;
	await plugin.saveSettings();
	await plugin.activateView();
	plugin.refreshViews();
}

export function shouldShowSetup(plugin: FinancePlugin, host: HTMLElement): boolean {
	if (pendingRestart) return true;
	if (plugin.settings.onboardingCompleted) return false;
	return plugin.store.accounts.length === 0 || stateFor(host).inProgress;
}

/**
 * Releases the body from setup without completing it — for a user who clicked a rail tab or an
 * account instead. `inProgress` is what keeps the first created account from evicting them mid-flow,
 * and with nothing clearing it the rail became decorative: the tab went `is-active` and the body kept
 * showing the wizard. Onboarding is deliberately *not* marked complete here — they navigated away,
 * they didn't tell setup to go away.
 */
export function leaveSetup(host: HTMLElement): void {
	const state = stateByHost.get(host);
	if (state) state.inProgress = false;
}

export function renderSetupView(container: HTMLElement, plugin: FinancePlugin, onDone: () => void): void {
	container.empty();
	const state = stateFor(container);
	// A restart lands here with possibly-stale per-leaf state from an earlier run — reset to the
	// welcome step and hold the body (inProgress) so existing accounts don't evict the user.
	if (pendingRestart) {
		pendingRestart = false;
		state.step = "welcome";
		state.inProgress = true;
		state.created = [];
		state.imported = undefined;
	}
	const root = container.createDiv({ cls: "fpih-setup" });

	const rerender = (): void => renderSetupView(container, plugin, onDone);

	const finish = async (): Promise<void> => {
		plugin.settings.onboardingCompleted = true;
		await plugin.saveSettings();
		state.step = "welcome";
		state.inProgress = false;
		state.created = [];
		state.imported = undefined;
		onDone();
	};

	/** Every forward move marks setup as live, so a write that changes the world underneath it (the
	 *  first account, the first import) can't evict the user from the flow. */
	const goTo = (step: StepId): void => {
		state.step = step;
		state.inProgress = true;
		// An explicit `false` on first entry, so a reload after abandoning setup is distinguishable
		// from a pre-flag install. `migrateOnboardingFlag` only fills in an *absent* flag; without
		// this, quitting at the account step and reloading silently completed onboarding forever.
		if (plugin.settings.onboardingCompleted === undefined) {
			plugin.settings.onboardingCompleted = false;
			void plugin.saveSettings();
		}
		rerender();
	};

	renderStepper(root, state.step);

	const body = root.createDiv({ cls: "fpih-setup-body" });
	switch (state.step) {
		case "welcome":
			renderWelcome(body, plugin, goTo, finish);
			break;
		case "categories":
			renderCategories(body, plugin, state, goTo, rerender, finish);
			break;
		case "account":
			renderAccount(body, plugin, state, goTo, rerender, finish);
			break;
		case "import":
			renderImport(body, plugin, state, goTo, finish);
			break;
		case "done":
			renderDone(body, plugin, state, finish);
			break;
	}
}

function renderStepper(root: HTMLElement, current: StepId): void {
	const stepsEl = root.createDiv({ cls: "fpih-wizard-steps fpih-setup-steps" });
	const currentIdx = STEPS.indexOf(current);
	STEPS.forEach((id, i) => {
		const cls = ["fpih-wizard-step"];
		if (i === currentIdx) cls.push("is-active");
		if (i < currentIdx) cls.push("is-done");
		const dot = stepsEl.createDiv({ cls: cls.join(" ") });
		const circle = dot.createDiv({ cls: "fpih-wizard-step-circle" });
		icon(circle, i < currentIdx ? "check" : STEP_META[id].icon);
		dot.createDiv({ cls: "fpih-wizard-step-label", text: STEP_META[id].title });
		if (i < STEPS.length - 1) stepsEl.createDiv({ cls: "fpih-wizard-step-line" + (i < currentIdx ? " is-done" : "") });
	});
}

/** The footer every step shares: Skip on the left (always available), the step's own action on the right. */
function footer(
	parent: HTMLElement,
	opts: { back?: () => void; skip: () => void; skipLabel?: string; primary?: { label: string; icon?: string; onClick: () => void; disabled?: boolean } }
): void {
	const bar = parent.createDiv({ cls: "fpih-wizard-footer" });
	const left = bar.createDiv({ cls: "fpih-wizard-footer-left" });
	const right = bar.createDiv({ cls: "fpih-wizard-footer-right" });

	if (opts.back) {
		const back = left.createEl("button", { cls: "fpih-btn fpih-btn--ghost fpih-btn-ghost", text: "Back", attr: { type: "button" } });
		back.addEventListener("click", opts.back);
	}
	const skip = left.createEl("button", { cls: "fpih-btn fpih-btn--ghost fpih-btn-ghost", text: opts.skipLabel ?? "Skip setup", attr: { type: "button" } });
	skip.addEventListener("click", opts.skip);

	if (opts.primary) {
		const btn = right.createEl("button", { cls: "fpih-btn fpih-btn--primary fpih-btn-primary", attr: { type: "button" } });
		if (opts.primary.icon) icon(btn, opts.primary.icon);
		btn.createSpan({ text: opts.primary.label });
		btn.disabled = !!opts.primary.disabled;
		btn.addEventListener("click", opts.primary.onClick);
	}
}

// ---------- A1 · Welcome & portfolio name ----------

function renderWelcome(body: HTMLElement, plugin: FinancePlugin, goTo: (step: StepId) => void, finish: () => Promise<void>): void {
	const head = body.createDiv({ cls: "fpih-setup-head" });
	icon(head, "wallet", "fpih-welcome-icon");
	head.createEl("h2", { text: "Welcome to Finance" });
	head.createEl("p", {
		cls: "fpih-setup-lede",
		text: "Everything stays in your vault — plain JSON and CSV. No accounts, no network, no sync.",
	});

	const form = body.createDiv({ cls: "fpih-form fpih-setup-form" });
	const row = form.createDiv({ cls: "fpih-form-row" });
	row.createEl("label", { text: "Whose finances are these?" });
	const input = row.createEl("input", { cls: "fpih-input", type: "text", attr: { placeholder: "e.g. Alex" } });
	input.value = plugin.activePortfolio?.name ?? "";
	row.createDiv({
		cls: "fpih-setup-explainer",
		text: "A portfolio is a fully separate set of accounts, transactions and subscriptions. You can add more later.",
	});

	footer(body, {
		skip: () => void finish(),
		primary: {
			label: "Continue",
			icon: "arrow-right",
			onClick: async () => {
				const name = input.value.trim();
				const active = plugin.settings.activePortfolioId;
				if (name && active) await plugin.renamePortfolio(active, name);
				goTo("categories");
			},
		},
	});

	input.focus();
	input.select();
}

// ---------- A2 · Categories & rules ----------

function renderCategories(
	body: HTMLElement,
	plugin: FinancePlugin,
	state: SetupState,
	goTo: (step: StepId) => void,
	rerender: () => void,
	finish: () => Promise<void>
): void {
	body.createEl("h2", { text: "Start with a standard category set?" });
	body.createEl("p", {
		cls: "fpih-setup-lede",
		text: "26 categories (Food, Auto & Transport, Bills & Utilities, …) plus around 200 keyword rules that recognise common merchants automatically — so most of your first import categorizes itself.",
	});

	const choices = body.createDiv({ cls: "fpih-setup-choices" });
	const choice = (value: boolean, title: string, description: string): void => {
		const label = choices.createEl("label", { cls: "fpih-setup-choice" + (state.useStandardCategories === value ? " is-active" : "") });
		const radio = label.createEl("input", { type: "radio", attr: { name: "fpih-setup-categories" } });
		radio.checked = state.useStandardCategories === value;
		radio.addEventListener("change", () => {
			state.useStandardCategories = value;
			rerender();
		});
		const text = label.createDiv({ cls: "fpih-setup-choice-text" });
		text.createDiv({ cls: "fpih-setup-choice-title", text: title });
		text.createDiv({ cls: "fpih-setup-choice-desc", text: description });
	};
	choice(true, "Use the standard set (recommended)", "Categories and merchant rules, installed now. Nothing is overwritten — you can rename, add and remove any of them later.");
	choice(false, "Start with an empty set", "Build your own categories as you go.");

	footer(body, {
		back: () => goTo("welcome"),
		skip: () => void finish(),
		primary: {
			label: "Continue",
			icon: "arrow-right",
			onClick: async () => {
				if (state.useStandardCategories && !state.categoriesInstalled) {
					// The single most valuable thing a new user can run, and today it is buried in the
					// command palette under a vendor name nobody recognises. Here they just get it.
					await plugin.installEmoneyCategoriesAndCategorize();
					state.categoriesInstalled = true;
				}
				goTo("account");
			},
		},
	});
}

// ---------- A3 · First account ----------

function renderAccount(
	body: HTMLElement,
	plugin: FinancePlugin,
	state: SetupState,
	goTo: (step: StepId) => void,
	rerender: () => void,
	finish: () => Promise<void>
): void {
	body.createEl("h2", { text: "Add your first account" });
	body.createEl("p", {
		cls: "fpih-setup-lede",
		text: "An account is a container for one card or bank — its transactions and its balance.",
	});

	let type: AccountType = "debit";
	let name = "";
	let iban = "";
	let openingBalance = "0";

	const form = body.createDiv({ cls: "fpih-form fpih-setup-form" });

	const typeRow = form.createDiv({ cls: "fpih-form-row" });
	typeRow.createEl("label", { text: "Account type" });
	const chips = typeRow.createDiv({ cls: "fpih-setup-type-chips" });
	const chipEls = new Map<AccountType, HTMLElement>();
	(Object.keys(ACCOUNT_TYPE_META) as AccountType[]).forEach((t) => {
		const chip = chips.createEl("button", {
			cls: "fpih-btn fpih-btn--chip fpih-btn-chip" + (t === type ? " is-active" : ""),
			attr: { type: "button", "aria-pressed": String(t === type) },
		});
		icon(chip, ACCOUNT_TYPE_META[t].icon);
		chip.createSpan({ text: ACCOUNT_TYPE_META[t].label });
		chip.addEventListener("click", () => {
			type = t;
			chipEls.forEach((el, key) => {
				el.toggleClass("is-active", key === t);
				el.setAttribute("aria-pressed", String(key === t));
			});
		});
		chipEls.set(t, chip);
	});

	const nameRow = form.createDiv({ cls: "fpih-form-row" });
	nameRow.createEl("label", { text: "Name" });
	const nameInput = nameRow.createEl("input", { cls: "fpih-input", type: "text", attr: { placeholder: "e.g. ING Checking" } });
	nameInput.addEventListener("input", () => (name = nameInput.value));

	const ibanRow = form.createDiv({ cls: "fpih-form-row" });
	ibanRow.createEl("label", { text: "IBAN (optional)" });
	const ibanInput = ibanRow.createEl("input", { cls: "fpih-input", type: "text", attr: { placeholder: "NL00 INGB 0000 0000 00" } });
	ibanInput.addEventListener("input", () => (iban = ibanInput.value));
	ibanRow.createDiv({
		cls: "fpih-setup-explainer",
		text: "Set this and a combined multi-account export files its rows to the right account automatically, with no mapping step.",
	});

	const balRow = form.createDiv({ cls: "fpih-form-row" });
	balRow.createEl("label", { text: "Opening balance" });
	const balInput = balRow.createEl("input", { cls: "fpih-input", type: "number", attr: { step: "0.01" } });
	balInput.value = openingBalance;
	balInput.addEventListener("input", () => (openingBalance = balInput.value));
	balRow.createDiv({
		cls: "fpih-setup-explainer",
		text: "The balance before your first imported transaction. Leave it at 0 if your export covers the account's full history — a wrong number here shifts every net-worth figure by exactly that much.",
	});

	if (state.created.length > 0) {
		const added = body.createDiv({ cls: "fpih-setup-added" });
		state.created.forEach((account) => {
			const row = added.createDiv({ cls: "fpih-setup-added-row" });
			icon(row, "check");
			row.createSpan({ text: `${account.name} · ${ACCOUNT_TYPE_META[account.type].label}` });
			if (account.openingBalance) row.createSpan({ cls: "fpih-money", text: ` · ${formatMoney(account.openingBalance)}` });
		});
	}

	const createAccount = async (): Promise<Account | undefined> => {
		if (!name.trim()) {
			new Notice("Give the account a name first");
			return undefined;
		}
		const account: Account = {
			id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
			name: name.trim(),
			type,
			currency: "EUR",
			openingBalance: parseFloat(openingBalance) || 0,
			iban: iban.trim() || undefined,
		};
		plugin.store.accounts.push(account);
		await plugin.store.saveAccounts();
		state.created.push(account);
		plugin.refreshViews();
		return account;
	};

	const bar = body.createDiv({ cls: "fpih-wizard-footer" });
	const left = bar.createDiv({ cls: "fpih-wizard-footer-left" });
	const right = bar.createDiv({ cls: "fpih-wizard-footer-right" });

	const back = left.createEl("button", { cls: "fpih-btn fpih-btn--ghost fpih-btn-ghost", text: "Back", attr: { type: "button" } });
	back.addEventListener("click", () => goTo("categories"));
	const skip = left.createEl("button", { cls: "fpih-btn fpih-btn--ghost fpih-btn-ghost", text: "Skip setup", attr: { type: "button" } });
	skip.addEventListener("click", () => void finish());

	// "Every step can be skipped" was not true of this one: with nothing entered, Continue only ever
	// produced a Notice, and the single way out was "Skip setup" — which *completes* onboarding. This
	// skips the step without ending the flow, so the rest of setup is still reachable.
	if (state.created.length === 0) {
		const without = left.createEl("button", {
			cls: "fpih-btn fpih-btn--ghost fpih-btn-ghost",
			text: "Continue without an account",
			attr: { type: "button" },
		});
		without.addEventListener("click", () => goTo("import"));
	}

	const another = right.createEl("button", { cls: "fpih-btn fpih-btn--secondary fpih-btn-secondary", attr: { type: "button" } });
	icon(another, "plus");
	another.createSpan({ text: "Add another" });
	another.addEventListener("click", async () => {
		if (await createAccount()) rerender();
	});

	const next = right.createEl("button", { cls: "fpih-btn fpih-btn--primary fpih-btn-primary", attr: { type: "button" } });
	icon(next, "arrow-right");
	next.createSpan({ text: "Continue" });
	next.addEventListener("click", async () => {
		// A filled-in form on the way past is an account the user meant to create, not one they meant
		// to abandon — but an empty form with accounts already added is simply "I'm done adding".
		if (name.trim()) {
			if (!(await createAccount())) return;
		} else if (state.created.length === 0) {
			new Notice("Name an account to add it, or use \"Continue without an account\"");
			return;
		}
		goTo("import");
	});

	nameInput.focus();
}

// ---------- A4 · First import ----------

function renderImport(body: HTMLElement, plugin: FinancePlugin, state: SetupState, goTo: (step: StepId) => void, finish: () => Promise<void>): void {
	body.createEl("h2", { text: "Bring in your transactions" });
	body.createEl("p", {
		cls: "fpih-setup-lede",
		text: "A CSV or Excel export from your bank or broker. ING and Trade Republic are recognised automatically; anything else gets a quick column-mapping step.",
	});

	const launcher = body.createDiv({ cls: "fpih-setup-import" });
	const openBtn = launcher.createEl("button", { cls: "fpih-dropzone fpih-setup-dropzone", attr: { type: "button" } });
	icon(openBtn, "upload", "fpih-dropzone-icon");
	openBtn.createDiv({ cls: "fpih-dropzone-text", text: "Import a file" });
	openBtn.createDiv({ cls: "fpih-dropzone-subtext", text: "Opens the import wizard — drop a file or browse" });
	openBtn.addEventListener("click", () => {
		openImportWizard(plugin, {
			onDone: async (outcome) => {
				state.imported = { added: outcome.added, skipped: outcome.skipped };
				if (outcome.destination === "none") {
					goTo("done");
					return;
				}
				// The summary's other buttons go somewhere specific — the ledger, the subscriptions tab,
				// the review queue. Setup still owns the body at that point (`onboardingCompleted` is
				// false, `inProgress` is true), so without completing it first the user pressed
				// "Go to ledger" and landed on "Setup complete — your dashboard is ready".
				await finish();
			},
		});
	});

	footer(body, {
		back: () => goTo("account"),
		skip: () => void finish(),
		skipLabel: "I'll do this later",
		primary: {
			label: "Continue",
			icon: "arrow-right",
			onClick: () => goTo("done"),
		},
	});
}

// ---------- A5 · Done ----------

function renderDone(body: HTMLElement, plugin: FinancePlugin, state: SetupState, finish: () => Promise<void>): void {
	const head = body.createDiv({ cls: "fpih-setup-head" });
	icon(head, "party-popper", "fpih-welcome-icon");
	head.createEl("h2", { text: "Setup complete — your dashboard is ready" });

	const summary = body.createDiv({ cls: "fpih-setup-summary" });
	const line = (iconName: string, text: string): void => {
		const row = summary.createDiv({ cls: "fpih-setup-summary-row" });
		icon(row, iconName);
		row.createSpan({ text });
	};

	const portfolioName = plugin.activePortfolio?.name;
	if (portfolioName) line("wallet", `Portfolio "${portfolioName}"`);
	line("tags", `${plugin.store.categories.length} categories · ${plugin.store.rules.length} merchant rules`);
	line("landmark", `${plugin.store.accounts.length} account${plugin.store.accounts.length === 1 ? "" : "s"}`);
	if (state.imported) {
		line("download", `${state.imported.added} transactions imported${state.imported.skipped > 0 ? ` (${state.imported.skipped} duplicates skipped)` : ""}`);
	} else {
		line("info", "No transactions yet — use Import from the sidebar whenever you're ready.");
	}

	const bar = body.createDiv({ cls: "fpih-wizard-footer" });
	const right = bar.createDiv({ cls: "fpih-wizard-footer-right" });
	const done = right.createEl("button", { cls: "fpih-btn fpih-btn--primary fpih-btn-primary", attr: { type: "button" } });
	icon(done, "check");
	done.createSpan({ text: "Go to my dashboard" });
	done.addEventListener("click", () => void finish());
}
