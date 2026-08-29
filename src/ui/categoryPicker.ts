import { categoryChain, primaryCategories, secondaryCategoriesOf } from "../categories";
import { UNCATEGORIZED } from "../reports/query";
import type { Category } from "../types";
import { badge, categoryChip, icon } from "./dom";

/**
 * The chips-plus-two-selects category picker used by every `ReportQuery.categoryIds`-shaped filter —
 * the ad-hoc Reports page and the scheduled-report editor both build the same kind of list, so the
 * widget lives here once rather than being hand-rolled twice and drifting apart.
 *
 * Adds rather than replaces: picking a second category alongside the first is the normal case ("Fuel
 * and Restaurants together"), not an edge case a single-value select would make unaskable.
 */
export interface CategoryPickerOptions {
	categories: Category[];
	/** The currently chosen category ids — owned by the caller; this widget never mutates it, only
	 *  calls `onChange` with the next value. */
	chosen: string[];
	/** Shown in the chip row when `chosen` is empty. */
	emptyText: string;
	/** "Remove Restaurants from the report" vs "Stop excluding Restaurants" — read by a screen reader
	 *  on the chip's own remove button. */
	removeLabel: string;
	/** Renders a chip with a warning-toned border instead of the plain default — used for an exclude
	 *  list, so it reads as "kept out" rather than "included" at a glance. */
	tone?: "include" | "exclude";
	onChange: (next: string[]) => void;
}

export function renderCategoryPicker(container: HTMLElement, opts: CategoryPickerOptions): void {
	const { categories, chosen, onChange } = opts;

	const chips = container.createDiv({ cls: "fp-report-chips" });
	if (chosen.length === 0) chips.createSpan({ cls: "fp-report-chips-empty", text: opts.emptyText });
	for (const id of chosen) {
		const chip = chips.createDiv({ cls: "fp-report-chip" + (opts.tone === "exclude" ? " fp-report-chip-exclude" : "") });
		if (id === UNCATEGORIZED) {
			badge(chip, "Uncategorized", "warn");
		} else {
			const chain = categoryChain(categories, id);
			const cat = chain.secondary ?? chain.primary;
			if (cat) categoryChip(chip, chain.secondary ? `${chain.primary?.name} › ${cat.name}` : cat.name, cat.color, cat.icon);
			else chip.createSpan({ text: id });
		}
		const remove = chip.createEl("button", { cls: "fp-report-chip-x" });
		icon(remove, "x");
		remove.setAttribute("aria-label", opts.removeLabel);
		remove.addEventListener("click", () => onChange(chosen.filter((c) => c !== id)));
	}

	const adder = container.createDiv({ cls: "fp-report-adder" });
	const primarySelect = adder.createEl("select", { cls: "fp-filter-select" });
	primarySelect.createEl("option", { text: "Add a category…", value: "" });
	primarySelect.createEl("option", { text: "Uncategorized", value: UNCATEGORIZED });
	const primaries = primaryCategories(categories);
	primaries.forEach((c) => primarySelect.createEl("option", { text: c.name, value: c.id }));

	const secondarySelect = adder.createEl("select", { cls: "fp-filter-select" });
	secondarySelect.disabled = true;
	secondarySelect.createEl("option", { text: "All subcategories", value: "" });

	function add(id: string): void {
		if (!id || chosen.includes(id)) return;
		onChange([...chosen, id]);
	}

	primarySelect.addEventListener("change", () => {
		const value = primarySelect.value;
		if (!value) return;
		if (value === UNCATEGORIZED) {
			add(value);
			return;
		}
		const secondaries = secondaryCategoriesOf(categories, value);
		if (secondaries.length === 0) {
			add(value);
			return;
		}
		// A primary with children gets a second beat: "all of Transport" and "just Fuel" are different
		// questions and the picker shouldn't guess which one was meant.
		secondarySelect.empty();
		secondarySelect.disabled = false;
		secondarySelect.createEl("option", { text: `All of ${primaries.find((c) => c.id === value)?.name ?? "it"}`, value });
		secondaries.forEach((c) => secondarySelect.createEl("option", { text: c.name, value: c.id }));
		secondarySelect.focus();
	});
	secondarySelect.addEventListener("change", () => add(secondarySelect.value));
}
