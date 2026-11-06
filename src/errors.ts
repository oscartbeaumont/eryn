/**
 * The bot's own error type and a shared error formatter.
 *
 * The formatter is for logs and for Discord messages; every call site catches
 * an unknown error, so it has to work for anything that can be thrown.
 */

/** A failure raised by the bot's own logic, carrying a human-readable message. */
export class BotError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BotError";
	}
}

/** Construct a {@link BotError} without the `new` noise. */
export function botError(message: string): BotError {
	return new BotError(message);
}

/** A one-line description of an unknown error, for logs and thread messages. */
export function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (error && typeof error === "object") {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message.trim()) return message;
	}
	return String(error);
}
