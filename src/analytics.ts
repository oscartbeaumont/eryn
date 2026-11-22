/**
 * Product analytics for the hosted deployment.
 *
 * Off unless `POSTHOG_KEY` is set. A self-hosted fork should not report to the
 * hosted project, and nothing here is needed to run Eryn, so the default is
 * silence rather than a disabled client that still loads.
 *
 * Every event is addressed by a pseudonymous subject: a server id for anything
 * about one server, a user id for sign-in. Callers pass coarse values only.
 * Message text, prompts, replies, attachments, email addresses, phone numbers,
 * usernames, channel names, URLs, tokens, plugin code, tool arguments, and raw
 * Discord identifiers never leave the object.
 */

import { log, optional } from "./config.ts";
import { describeError } from "./errors.ts";

/** PostHog's US ingestion endpoint, matching the project the website uses. */
const INGEST = "https://us.i.posthog.com/capture/";

/** A capture must never hold a request open; PostHog is normally much faster. */
const TIMEOUT_MS = 3_000;

/** The value a property may carry: primitives only, so nothing can smuggle content out. */
export type AnalyticsValue = string | number | boolean | undefined;

/** Who an event is about. Server-scoped events should always name the server. */
export interface CaptureSubject {
	readonly serverId?: string;
	/** An Eryn user id, or a keyed pseudonym for a user who has no account yet. */
	readonly userId?: string;
}

/**
 * Send one event, or do nothing when analytics is off or the subject is unknown.
 *
 * Never rejects: an analytics failure must not fail a product action. Callers
 * with an `ExecutionContext` should hand the returned promise to
 * `ctx.waitUntil` so the send never delays the response.
 */
export async function capture(
	env: Env,
	event: string,
	properties: Record<string, AnalyticsValue> = {},
	subject: CaptureSubject = {},
): Promise<void> {
	try {
		const key = optional(env, "POSTHOG_KEY");
		const distinctId = subject.serverId
			? `server:${subject.serverId}`
			: subject.userId
				? `user:${subject.userId}`
				: undefined;

		if (!key || !distinctId) return;

		const eventProperties: Record<string, string | number | boolean | { readonly server: string }> =
			clean(properties);

		eventProperties.$lib = "eryn";
		// Anonymous by design: the subject is pseudonymous and the events
		// describe usage, not a person.
		eventProperties.$process_person_profile = false;
		eventProperties.$geoip_disable = true;

		if (subject.serverId) eventProperties.$groups = { server: subject.serverId };

		const response = await fetch(INGEST, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				api_key: key,
				event,
				distinct_id: distinctId,
				properties: eventProperties,
				timestamp: new Date().toISOString(),
			}),
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});

		if (!response.ok) log("analytics", `PostHog returned HTTP ${response.status} for ${event}`);
	} catch (error) {
		log("analytics", `could not send ${event}: ${describeError(error)}`);
	}
}

function clean(properties: Record<string, AnalyticsValue>): Record<string, string | number | boolean> {
	return Object.fromEntries(
		Object.entries(properties).filter(
			(entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
		),
	);
}

/**
 * A stable pseudonym for a value that must never be sent, such as an email
 * address.
 *
 * The HMAC key is the deployment's encryption key, so a list of candidate
 * addresses cannot confirm a match the way a plain hash can, and the same
 * deployment derives the same id for the same address. Returns undefined when
 * the deployment has no encryption key, in which case the caller should skip
 * the event rather than fall back to the raw value.
 */
export async function pseudonym(env: Env, value: string): Promise<string | undefined> {
	const secret = optional(env, "ENCRYPTION_KEY");

	if (!secret) return undefined;

	try {
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(secret),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`eryn-analytics:${value}`));

		return [...new Uint8Array(signature)]
			.map((byte) => byte.toString(16).padStart(2, "0"))
			.join("")
			.slice(0, 32);
	} catch (error) {
		log("analytics", `could not derive a pseudonym: ${describeError(error)}`);

		return undefined;
	}
}
