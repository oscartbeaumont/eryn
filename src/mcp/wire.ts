/**
 * Shared helpers for the hand-written MCP clients.
 *
 * Both the probe and the OAuth flow read JSON from a server this deployment
 * does not control, so every field is decoded through a schema rather than
 * trusted. The rule for which URLs are safe to call lives in `http.ts`.
 */

import { Option, Schema } from "effect";

/** Decode `input` with `schema`, or `undefined` when it does not match. */
export function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S["Type"] | undefined {
	if (input === undefined) return undefined;
	const parsed = Schema.decodeUnknownOption(schema)(input);
	return Option.isSome(parsed) ? parsed.value : undefined;
}
