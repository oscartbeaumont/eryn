/**
 * The bot's own error type and a shared error formatter.
 *
 * The formatter is for logs and for Discord messages; every call site catches
 * an unknown error, so it has to work for anything that can be thrown.
 */

import { Option, Schema } from "effect";

import { stringField } from "./json.ts";

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

/**
 * A thrown value as the JSON it can be inspected through.
 *
 * A `catch` binding is `unknown` by design, and this is the one boundary that
 * turns it into something readable: an error that is not JSON is described by
 * its `Error` fields instead.
 */
export function thrownJson<Thrown>(error: Thrown): Schema.Json | undefined {
	return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Json)(error));
}

/** A one-line description of a thrown value, for logs and thread messages. */
export function describeError<Thrown>(error: Thrown): string {
	if (error instanceof Error) return error.message;
	const message = stringField(thrownJson(error), "message");

	if (message !== undefined && message.trim()) return message;

	return String(error);
}

/**
 * A coarse class for a failure, safe to send to analytics.
 *
 * The raw message can quote a provider, a URL, or part of a request, so it
 * never leaves the object. A bucket is enough to tell "the key is wrong" from
 * "the model ran out of context" in a dashboard.
 */
export function classifyError<Thrown>(error: Thrown): string {
	const message = describeError(error).toLowerCase();

	// Check quota first: an exhausted account often also arrives as a 429, and
	// "the account is out of credit" needs a different response from "slow down".
	if (
		/quota|billing|credit|payment|usage limit|out of (?:inference|usage)|extra usage|spend limit|budget limit|go-limit/.test(
			message,
		)
	)
		return "quota";

	if (/rate.?limit|too many requests|\b429\b/.test(message)) return "rate_limit";

	if (/\b401\b|\b403\b|unauthori[sz]ed|forbidden|api.?key|credential|sign.?in/.test(message)) return "auth";

	if (/context|token limit|too long|maximum.{0,20}tokens/.test(message)) return "context_length";

	if (/timeout|timed out|deadline/.test(message)) return "timeout";

	if (/network|fetch|connect|dns|socket|econn/.test(message)) return "network";

	return "other";
}
