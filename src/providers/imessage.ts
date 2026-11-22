/**
 * iMessage through SendBlue.
 *
 * SendBlue is an HTTP API plus a webhook: there is no socket to keep alive.
 * That is why iMessage has no gateway object — the Worker receives a webhook
 * and hands the normalised message to Hub, just as the Discord socket does.
 */

import type { MessagingProvider, SendInput, SendResult } from "./types.ts";

const API = "https://api.sendblue.co";

/**
 * The marker for a group conversation on a channel id.
 *
 * SendBlue addresses a direct message by phone number and a group by its own
 * `group_id`, so a group channel id is that id as received (the webhook stores
 * it unchanged), or a `group:` prefix when a caller wants to be explicit.
 */
const GROUP_PREFIX = "group:";

interface SendBlueBody {
	number: string;
	content: string;
	from_number: string;
	media_url?: string;
}

interface SendBlueGroupBody {
	group_id: string;
	from_number: string;
	content: string;
	media_url?: string;
}

/**
 * The SendBlue group id behind a conversation, or undefined for a direct
 * message. A direct message is an E.164 number or an Apple ID email; SendBlue's
 * group ids (for example `iMessage;+;chat…`) look like neither.
 */
function groupIdOf(channel: string): string | undefined {
	if (channel.startsWith(GROUP_PREFIX)) return channel.slice(GROUP_PREFIX.length) || undefined;

	if (/^\+?[0-9()\-.\s]+$/.test(channel) || channel.includes("@")) return undefined;

	return channel;
}

export interface SendBlueCredentials {
	readonly apiKeyId: string;
	readonly apiSecret: string;
	readonly fromNumber: string;
}

async function sendOne(
	credentials: SendBlueCredentials,
	to: string,
	text: string,
	mediaUrl?: string,
): Promise<{ id?: string; error?: string }> {
	// SendBlue expects digits or E.164 for a direct message, and a group id for
	// a group; a channel id is already whichever the conversation is.
	const group = groupIdOf(to);
	const body: SendBlueBody | SendBlueGroupBody = group === undefined
		? {
				number: to,
				content: text,
				from_number: credentials.fromNumber,
			}
		: {
				group_id: group,
				content: text,
				from_number: credentials.fromNumber,
			};
	const requestBody: SendBlueBody | SendBlueGroupBody = mediaUrl ? { ...body, media_url: mediaUrl } : body;
	// The same endpoint pair answers with the same shape either way.
	const path = group === undefined ? "/api/send-message" : "/api/send-group-message";

	try {
		const response = await fetch(`${API}${path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"sb-api-key-id": credentials.apiKeyId,
				"sb-api-secret-key": credentials.apiSecret,
			},
			body: JSON.stringify(requestBody),
			signal: AbortSignal.timeout(30_000),
		});

		const payload = (await response.json().catch(() => undefined)) as
			| { message_handle?: string; error_message?: string }
			| undefined;

		if (!response.ok) {
			return { error: payload?.error_message ?? `SendBlue returned HTTP ${response.status}` };
		}

		return { id: payload?.message_handle };
	} catch (error) {
		return { error: String(error) };
	}
}

export function imessageProvider(credentials: SendBlueCredentials): MessagingProvider {
	return {
		kind: "imessage",
		async send(input: SendInput): Promise<SendResult> {
			const attachments = [...(input.attachments ?? [])];
			// SendBlue takes one media URL per message. Send the text with the first
			// attachment, then each remaining attachment as its own message.
			const first = attachments.shift();
			const result = await sendOne(credentials, input.channel, input.text, first?.url);

			if (result.error) throw new Error(result.error);

			for (const attachment of attachments) {
				await sendOne(credentials, input.channel, "", attachment.url);
			}

			return { id: result.id };
		},
	};
}
