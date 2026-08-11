import { App, Modal } from "obsidian";
import { registerOpenModal, unregisterOpenModal } from "../modalRegistry";
import { icon } from "../ui/dom";

/**
 * Handed to every step's `render`. A step that wants to drive navigation itself — a terminal summary
 * screen whose actions are "review these" / "go to the ledger" rather than "Next" — needs a way to
 * close or jump without reaching into the modal's private state.
 */
export interface WizardApi {
	close: () => void;
	next: () => void;
	back: () => void;
	/** Jump to a step by its `id`; a no-op for an unknown id. */
	goTo: (stepId: string) => void;
	/** Re-runs the current step's own `render` — for steps whose body depends on state they mutate. */
	rerender: () => void;
}

export interface WizardStep {
	id: string;
	title: string;
	icon: string;
	render: (container: HTMLElement, api: WizardApi) => void | Promise<void>;
	canGoNext?: () => boolean;
	onNext?: () => void | Promise<void>;
	nextLabel?: string;
	/** Shows a ghost "Skip" action alongside Next — bypasses canGoNext and onNext, just advances (or closes on the last step). */
	skippable?: boolean;
	/** Makes Skip leave the wizard rather than advance — for an onboarding-style "Skip for now" where
	 *  this step *is* the flow, so there is nothing to advance to that would make sense. */
	skipExits?: boolean;
	skipLabel?: string;
	onSkip?: () => void | Promise<void>;
	/** Suppresses Back/Cancel — for a step that has already committed something, where "Back" would
	 *  offer to undo work that cannot be undone. */
	hideBack?: boolean;
	/** Suppresses the Next/Finish button — for a step that renders its own terminal actions. */
	hideNext?: boolean;
	/** Kept out of the stepper header (and out of its numbering) — e.g. a post-commit summary screen,
	 *  which is a destination, not a step you are working through. */
	hidden?: boolean;
}

/**
 * Generic multi-step modal shell: numbered/iconed stepper header, swappable body, Back/Next footer.
 * Used for focused, self-contained tasks like importing a file. First-run setup lives in SetupView
 * instead, since that's a full-tab experience rather than a dialog.
 */
export class WizardModal extends Modal {
	private stepIndex = 0;
	private steps: WizardStep[];
	private stepsEl!: HTMLElement;
	private bodyEl!: HTMLElement;
	private footerEl!: HTMLElement;
	private wizTitle: string;
	private wizSubtitle: string;
	private wizIcon: string;
	/** True while a step's `onNext`/`onSkip` is in flight. A double-click on "Import" used to run the
	 *  handler twice and advance the step index twice, walking past the last step and throwing in the
	 *  stepper — after the second (idempotent) import had already overwritten the summary's numbers. */
	private busy = false;
	private nextBtn?: HTMLButtonElement;

	constructor(app: App, opts: { title: string; subtitle: string; icon: string; steps: WizardStep[] }) {
		super(app);
		this.steps = opts.steps;
		this.wizTitle = opts.title;
		this.wizSubtitle = opts.subtitle;
		this.wizIcon = opts.icon;
	}

	/** Navigation handed to step bodies — see {@link WizardApi}. */
	private get api(): WizardApi {
		return {
			close: () => this.close(),
			next: () => {
				if (this.stepIndex < this.steps.length - 1) {
					this.stepIndex++;
					void this.renderStep();
				} else {
					this.close();
				}
			},
			back: () => {
				if (this.stepIndex > 0) {
					this.stepIndex--;
					void this.renderStep();
				}
			},
			goTo: (stepId: string) => {
				const i = this.steps.findIndex((s) => s.id === stepId);
				if (i === -1) return;
				this.stepIndex = i;
				void this.renderStep();
			},
			rerender: () => void this.renderStep(),
		};
	}

	onOpen(): void {
		// Registered so a portfolio switch can close it — see modalRegistry.
		registerOpenModal(this);
		this.modalEl.addClass("fp-wizard-modal");
		// `.fp-root` is where the design tokens live; `.fp-wizard-modal` is kept as the alias every
		// existing modal rule is written against.
		this.modalEl.addClass("fp-root");
		this.contentEl.addClass("fp-wizard");

		const head = this.contentEl.createDiv({ cls: "fp-wizard-header" });
		icon(head.createDiv({ cls: "fp-wizard-header-icon" }), this.wizIcon);
		const headText = head.createDiv({ cls: "fp-wizard-header-text" });
		headText.createDiv({ cls: "fp-wizard-title", text: this.wizTitle });
		headText.createDiv({ cls: "fp-wizard-subtitle", text: this.wizSubtitle });

		this.stepsEl = this.contentEl.createDiv({ cls: "fp-wizard-steps" });
		this.bodyEl = this.contentEl.createDiv({ cls: "fp-wizard-body" });
		this.footerEl = this.contentEl.createDiv({ cls: "fp-wizard-footer" });

		// Next is disabled whenever `canGoNext` says so, and almost every `canGoNext` reads a field the
		// user is typing in or a select they just changed. Re-evaluating here — once, on the body, for
		// every step — is what keeps that from being a trap: no step has to remember to re-render its
		// footer after wiring an input, and steps in wizards that never call `rerender()` still work.
		this.bodyEl.addEventListener("input", () => this.syncNextDisabled());
		this.bodyEl.addEventListener("change", () => this.syncNextDisabled());

		void this.renderStep();
	}

	private syncNextDisabled(): void {
		if (!this.nextBtn || this.busy) return;
		const step = this.steps[this.stepIndex];
		if (!step) return;
		this.nextBtn.disabled = !!step.canGoNext && !step.canGoNext();
	}

	onClose(): void {
		unregisterOpenModal(this);
		this.contentEl.empty();
	}

	private renderStepsIndicator(): void {
		this.stepsEl.empty();
		const visible = this.steps.filter((s) => !s.hidden);
		const activeStep = this.steps[this.stepIndex];
		// A hidden step (the post-import summary) sits *after* everything in the stepper, so the
		// header reads as fully complete rather than snapping back to the last visible step.
		const activeVisibleIdx = activeStep.hidden ? visible.length : visible.indexOf(activeStep);
		visible.forEach((step, i) => {
			const cls = ["fp-wizard-step"];
			if (i === activeVisibleIdx) cls.push("is-active");
			if (i < activeVisibleIdx) cls.push("is-done");
			const dot = this.stepsEl.createDiv({ cls: cls.join(" ") });
			const circle = dot.createDiv({ cls: "fp-wizard-step-circle" });
			icon(circle, i < activeVisibleIdx ? "check" : step.icon);
			dot.createDiv({ cls: "fp-wizard-step-label", text: step.title });
			if (i < visible.length - 1) {
				this.stepsEl.createDiv({ cls: "fp-wizard-step-line" + (i < activeVisibleIdx ? " is-done" : "") });
			}
		});
	}

	private async renderStep(): Promise<void> {
		this.renderStepsIndicator();
		this.bodyEl.empty();
		const step = this.steps[this.stepIndex];
		await step.render(this.bodyEl, this.api);
		this.renderFooter();
	}

	private renderFooter(): void {
		this.footerEl.empty();
		this.nextBtn = undefined;
		const left = this.footerEl.createDiv({ cls: "fp-wizard-footer-left" });
		const right = this.footerEl.createDiv({ cls: "fp-wizard-footer-right" });

		const step = this.steps[this.stepIndex];
		const isLast = this.stepIndex === this.steps.length - 1;

		if (step.hideBack) {
			// nothing on the left — this step has already committed something
		} else if (this.stepIndex > 0) {
			const back = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Back" });
			back.addEventListener("click", () => {
				this.stepIndex--;
				void this.renderStep();
			});
		} else {
			const cancel = left.createEl("button", { cls: "fp-btn fp-btn-ghost", text: "Cancel" });
			cancel.addEventListener("click", () => this.close());
		}

		if (step.skippable) {
			const skip = right.createEl("button", { cls: "fp-btn fp-btn-ghost", text: step.skipLabel ?? "Skip" });
			skip.addEventListener("click", async () => {
				if (this.busy) return;
				this.busy = true;
				skip.disabled = true;
				try {
					if (step.onSkip) await step.onSkip();
					// Skipping is "I'm not doing this step", not "I'm leaving the wizard" — it advances,
					// exactly as this step's own doc comment promises, and only closes on the last step
					// or where the step opted into exiting.
					if (isLast || step.skipExits) this.close();
					else {
						this.stepIndex++;
						await this.renderStep();
					}
				} finally {
					this.busy = false;
				}
			});
		}

		if (step.hideNext) return;

		const next = right.createEl("button", {
			cls: "fp-btn fp-btn--primary fp-btn-primary",
			text: step.nextLabel ?? (isLast ? "Finish" : "Next"),
		});
		// A live-looking primary button that silently does nothing is worse than a disabled one.
		// Evaluated here on every render, and again on any input/change inside the step body.
		this.nextBtn = next;
		this.syncNextDisabled();
		next.addEventListener("click", async () => {
			// Backstop for a step that invalidated itself without an input/change event or a rerender.
			if (step.canGoNext && !step.canGoNext()) return;
			if (this.busy) return;
			this.busy = true;
			next.disabled = true;
			try {
				if (step.onNext) await step.onNext();
				if (isLast) {
					this.close();
				} else {
					this.stepIndex++;
					await this.renderStep();
				}
			} finally {
				this.busy = false;
			}
		});
	}
}
