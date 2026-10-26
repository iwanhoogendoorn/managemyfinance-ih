import { HttpError } from "./router";

/**
 * Reading a POST or PATCH body into a record's fields, with one set of rules for every resource.
 *
 * The rules are the API's contract for writes, so they live in one place rather than once per route
 * file, where four hand-written copies would drift into four slightly different APIs:
 *
 *   - the body is a JSON object, and a key the resource doesn't know is a 400 — a typo such as
 *     "categoryID" would otherwise be accepted and ignored, and the caller told it had worked;
 *   - PATCH sends only what changes, so a key that is absent is left alone;
 *   - `null` clears an optional field (the key is removed from the record, not written as null, so a
 *     cleared field serialises exactly as one that was never set), and is a 400 on a required one;
 *   - a value of the wrong type or shape is a 400 naming the field, never coerced.
 *
 * What comes back is a change set: the parsed value for every key that was sent, and `undefined` for
 * every key that was cleared. The resource then applies it — or, for the fields with rules of their own
 * (a category's parent, a rule's match mode), takes those out and applies them its own way first.
 */

export interface Field {
	/** Turns a non-null JSON value into what is stored, or throws a 400 naming `name`. */
	parse(value: unknown, name: string): unknown;
	/** Has to be sent on create, and can't be cleared with null. */
	required?: boolean;
}

export type Fields = Record<string, Field>;

/** Parsed values by field name; a key present with `undefined` means "clear this field". */
export type Changes = Record<string, unknown>;

function bad(message: string): HttpError {
	return new HttpError(400, message);
}

/** The body as a plain object, or a 400 saying what was expected instead. */
export function objectBody(body: unknown): Record<string, unknown> {
	if (!body || typeof body !== "object" || Array.isArray(body)) throw bad("Expected a JSON object as the request body");
	return body as Record<string, unknown>;
}

/**
 * Parses a create (`mode: "create"`) or update (`"patch"`) body against a resource's fields.
 *
 * On create every required field must be present; on patch nothing is required, but an empty body is
 * still a 400 rather than a write that changes nothing and reports success.
 */
export function readFields(body: unknown, fields: Fields, mode: "create" | "patch"): Changes {
	const input = objectBody(body);
	for (const key of Object.keys(input)) {
		if (!Object.prototype.hasOwnProperty.call(fields, key)) throw bad(`Unknown field "${key}"`);
	}
	if (mode === "patch" && Object.keys(input).length === 0) throw bad("Nothing to change — send at least one field");

	const changes: Changes = {};
	for (const [name, field] of Object.entries(fields)) {
		if (!Object.prototype.hasOwnProperty.call(input, name)) {
			if (mode === "create" && field.required) throw bad(`${name} is required`);
			continue;
		}
		const value = input[name];
		if (value === null) {
			if (field.required) throw bad(`${name} can't be cleared`);
			changes[name] = undefined;
			continue;
		}
		changes[name] = field.parse(value, name);
	}
	return changes;
}

/** Writes a change set onto a record: a value sets the field, `undefined` removes it. */
export function applyChanges<T extends object>(target: T, changes: Changes): T {
	const record = target as Record<string, unknown>;
	for (const [name, value] of Object.entries(changes)) {
		if (value === undefined) delete record[name];
		else record[name] = value;
	}
	return target;
}

/** Takes one field out of a change set, for a resource that applies it by its own rules. */
export function takeChange(changes: Changes, name: string): { sent: boolean; value: unknown } {
	if (!Object.prototype.hasOwnProperty.call(changes, name)) return { sent: false, value: undefined };
	const value = changes[name];
	delete changes[name];
	return { sent: true, value };
}

/** A string, trimmed. Empty after trimming is a 400 when required and a clear otherwise. */
export function text(opts: { required?: boolean } = {}): Field {
	return {
		required: opts.required,
		parse(value, name) {
			if (typeof value !== "string") throw bad(`${name} must be a string`);
			const trimmed = value.trim();
			if (trimmed === "" && opts.required) throw bad(`${name} can't be empty`);
			return trimmed === "" ? undefined : trimmed;
		},
	};
}

/** A finite number, optionally bounded and/or whole. */
export function number(opts: { required?: boolean; min?: number; max?: number; integer?: boolean } = {}): Field {
	return {
		required: opts.required,
		parse(value, name) {
			if (typeof value !== "number" || !Number.isFinite(value)) throw bad(`${name} must be a number`);
			if (opts.integer && !Number.isInteger(value)) throw bad(`${name} must be a whole number`);
			if (opts.min !== undefined && value < opts.min) throw bad(`${name} must be at least ${opts.min}`);
			if (opts.max !== undefined && value > opts.max) throw bad(`${name} must be at most ${opts.max}`);
			return value;
		},
	};
}

export function boolean(): Field {
	return {
		parse(value, name) {
			if (typeof value !== "boolean") throw bad(`${name} must be true or false`);
			return value;
		},
	};
}

/** One of a fixed set of strings, named in the 400 so a caller can see the choices without the docs. */
export function oneOf(options: readonly string[], opts: { required?: boolean } = {}): Field {
	return {
		required: opts.required,
		parse(value, name) {
			if (typeof value !== "string" || !options.includes(value)) {
				throw bad(`${name} must be one of ${options.join(", ")}`);
			}
			return value;
		},
	};
}

/** A real calendar day as "YYYY-MM-DD" — "2024-02-30" is refused, not rolled into March. */
export function isoDate(): Field {
	return {
		parse(value, name) {
			if (typeof value !== "string" || !isCalendarDate(value)) throw bad(`${name} must be a date as YYYY-MM-DD`);
			return value;
		},
	};
}

export function isCalendarDate(value: string): boolean {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
	const d = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** A list of strings, each trimmed, empties dropped. */
export function stringList(): Field {
	return {
		parse(value, name) {
			if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw bad(`${name} must be a list of strings`);
			return (value as string[]).map((v) => v.trim()).filter((v) => v !== "");
		},
	};
}

/** An object of key → finite number, every key matching `key` — budgets keyed by month or year. */
export function numberRecord(key: RegExp, keyDescription: string): Field {
	return {
		parse(value, name) {
			if (!value || typeof value !== "object" || Array.isArray(value)) {
				throw bad(`${name} must be an object of ${keyDescription} → number`);
			}
			const out: Record<string, number> = {};
			for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
				if (!key.test(k)) throw bad(`${name} keys must be ${keyDescription}, got "${k}"`);
				if (typeof v !== "number" || !Number.isFinite(v)) throw bad(`${name}.${k} must be a number`);
				out[k] = v;
			}
			return out;
		},
	};
}

/** The same shape of id the UI mints for the same kind of record, so neither can tell who made it. */
export function newId(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}
