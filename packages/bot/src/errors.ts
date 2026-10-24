/**
 * Tagged errors and a shared error formatter.
 *
 * Failures are values, not thrown strings, so a handler can decide what a
 * failure means. The formatter is for the log and for Discord messages.
 */

import { Data } from "effect";

/** A failure raised by the bot's own logic, carrying a human-readable message. */
export class BotError extends Data.TaggedError("BotError")<{
	readonly message: string;
}> {}

/** A failure parsing a request body or stored record. */
export class ParseError extends Data.TaggedError("ParseError")<{
	readonly message: string;
}> {}

/** Construct a {@link BotError} without the `new` noise. */
export function botError(message: string): BotError {
	return new BotError({ message });
}

/**
 * A one-line description of an unknown error, for logs and thread messages.
 * Tagged errors carry their tag when they have no message.
 */
export function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object") {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message.trim()) return message;
		const tag = (error as { _tag?: unknown })._tag;
		if (typeof tag === "string") return tag;
	}
	return String(error);
}
