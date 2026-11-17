/**
 * Narrowing helpers for JSON that arrives from outside this program.
 *
 * A gateway frame, an event payload, and a session metadata block are all
 * `Schema.Json` until a field is read. These guards make that read explicit:
 * the value stays `Json`, and only the field that passed a check becomes a
 * domain value. They are the boundary counterpart of the Effect schemas that
 * decode stored records.
 */

import type { Schema } from "effect";

/**
 * The wire form of a JSON body that this program builds.
 *
 * Outgoing bodies are plain objects whose optional members are absent or
 * `undefined`; `JSON.stringify` omits the latter, so what reaches the wire is
 * exactly the JSON tree the source shape cannot name directly.
 */
export function jsonBody<T>(body: T): Schema.Json {
	// SAFETY: every caller passes data `JSON.stringify` serialises losslessly; the
	// optional members it omits are the ones JSON has no value for.
	return body as Schema.Json;
}

/** A JSON object, when the value is one. */
export function isJsonObject(value: Schema.Json | undefined): value is Schema.JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON object, or `undefined` for every other JSON value. */
export function toJsonObject(value: Schema.Json | undefined): Schema.JsonObject | undefined {
	return isJsonObject(value) ? value : undefined;
}

/** A member of a JSON object, or `undefined` when the value is not an object. */
export function jsonField(value: Schema.Json | undefined, key: string): Schema.Json | undefined {
	return isJsonObject(value) ? value[key] : undefined;
}

/** A string, when the value is one. */
export function isString(value: Schema.Json | undefined): value is string {
	return typeof value === "string";
}

/** A number, when the value is one. */
export function isNumber(value: Schema.Json | undefined): value is number {
	return typeof value === "number";
}

/** A string member of a JSON object, or `undefined`. */
export function stringField(value: Schema.Json | undefined, key: string): string | undefined {
	const field = jsonField(value, key);

	return isString(field) ? field : undefined;
}

/** A number member of a JSON object, or `undefined`. */
export function numberField(value: Schema.Json | undefined, key: string): number | undefined {
	const field = jsonField(value, key);

	return isNumber(field) ? field : undefined;
}

/** A boolean member of a JSON object, or `undefined`. */
export function booleanField(value: Schema.Json | undefined, key: string): boolean | undefined {
	const field = jsonField(value, key);

	return field === true || field === false ? field : undefined;
}
