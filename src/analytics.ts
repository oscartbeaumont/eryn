/**
 * Product analytics for the hosted deployment.
 *
 * Off unless `POSTHOG_KEY` is set. A self-hosted fork should not report to the
 * hosted project, and nothing here is needed to run the bot, so the default is
 * silence rather than a disabled client that still loads.
 *
 * Every event is keyed by a pseudonymous guild id (an HMAC of the Discord id,
 * not the id itself) and carries coarse properties. Message text, prompts,
 * replies, usernames, channel names, and tool arguments never leave the
 * object; callers pass only the values they would be happy to read in a
 * dashboard.
 */

import { log, optional } from "./config";
import { describeError } from "./errors";

/** PostHog's US ingestion endpoint, matching the project the website uses. */
const INGEST = "https://us.i.posthog.com/capture/";
/** A capture must never hold a turn open; PostHog is normally much faster. */
const TIMEOUT_MS = 3_000;

/** The value a property may carry: primitives only, so nothing can smuggle content out. */
export type AnalyticsValue = string | number | boolean | undefined;

export interface Analytics {
	readonly enabled: boolean;
	/**
	 * Send one event. Resolves once it is sent, or immediately when a
	 * `waitUntil` was supplied and the send has been handed to the runtime.
	 * Never rejects: an analytics failure must not fail a product action.
	 */
	capture(event: string, properties?: Record<string, AnalyticsValue>): Promise<void>;
}

const DISABLED: Analytics = { enabled: false, capture: async () => undefined };

/**
 * Analytics for one subject, usually a guild.
 *
 * `waitUntil` is the Durable Object's `ctx.waitUntil`. With it, a capture is
 * scheduled and the caller is not held open; without it (a route that already
 * awaits real work, or the agent's turn bookkeeping) the capture is awaited.
 */
export function analytics(
	env: Env,
	subject: string,
	waitUntil?: (promise: Promise<unknown>) => void,
): Analytics {
	const key = optional(env, "POSTHOG_KEY");
	const secret = optional(env, "ENCRYPTION_KEY");
	if (!key || !secret || !subject) return DISABLED;

	let distinctId: Promise<string> | undefined;

	return {
		enabled: true,
		capture(event, properties = {}) {
			distinctId ??= subjectId(subject, secret);
			const send = async (): Promise<void> => {
				try {
					const response = await fetch(INGEST, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							api_key: key,
							event,
							distinct_id: await distinctId,
							properties: {
								...clean(properties),
								$lib: "eryn",
								// Anonymous by design: the guild id is hashed and the
								// events describe the deployment, not a person.
								$process_person_profile: false,
								$geoip_disable: true,
							},
							timestamp: new Date().toISOString(),
						}),
						signal: AbortSignal.timeout(TIMEOUT_MS),
					});
					if (!response.ok) log("analytics", `PostHog returned HTTP ${response.status} for ${event}`);
				} catch (error) {
					log("analytics", `could not send ${event}: ${describeError(error)}`);
				}
			};
			if (waitUntil) {
				waitUntil(send());
				return Promise.resolve();
			}
			return send();
		},
	};
}

function clean(properties: Record<string, AnalyticsValue>): Record<string, string | number | boolean> {
	const cleaned: Record<string, string | number | boolean> = {};
	for (const [name, value] of Object.entries(properties)) {
		if (value !== undefined) cleaned[name] = value;
	}
	return cleaned;
}

/**
 * A stable id for a guild that cannot be read back as its Discord id.
 *
 * The HMAC key is the deployment's encryption key, so two deployments cannot
 * correlate the same guild, and an id from one project is meaningless in
 * another.
 */
async function subjectId(subject: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(`eryn-analytics:${subject}`),
	);
	const hex = [...new Uint8Array(signature)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	return `guild_${hex.slice(0, 32)}`;
}
