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

/**
 * A coarse class for a failure, safe to send to analytics.
 *
 * The raw message can quote a provider, a URL, or part of a request, so it
 * never leaves the object. A bucket is enough to tell "the key is wrong" from
 * "the model ran out of context" in a dashboard.
 */
export function classifyError(error: unknown): string {
	const message = describeError(error).toLowerCase();
	if (/rate.?limit|too many requests|\b429\b/.test(message)) return "rate_limit";
	if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|api.?key|credential|sign.?in/.test(message)) return "auth";
	if (/context|token limit|too long|maximum.{0,20}tokens/.test(message)) return "context_length";
	if (/timeout|timed out|deadline/.test(message)) return "timeout";
	if (/network|fetch|connect|dns|socket|econn/.test(message)) return "network";
	if (/quota|billing|credit|payment/.test(message)) return "quota";
	return "other";
}
