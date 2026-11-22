/**
 * iMessage through SendBlue.
 *
 * SendBlue is an HTTP API plus a webhook: there is no socket to keep alive.
 * That is why iMessage has no gateway object — the Worker receives a webhook
 * and hands the normalised message to Hub, just as the Discord socket does.
 */

import type { MessagingProvider, SendInput, SendResult } from "./types.ts";

const API = "https://api.sendblue.co";

interface SendBlueBody {
	number: string;
	content: string;
	from_number: string;
	media_url?: string;
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
	// SendBlue expects digits or E.164; a channel id is already the contact.
	const body: SendBlueBody = {
		number: to,
		content: text,
		from_number: credentials.fromNumber,
	};

	if (mediaUrl) body.media_url = mediaUrl;

	try {
		const response = await fetch(`${API}/api/send-message`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"sb-api-key-id": credentials.apiKeyId,
				"sb-api-secret-key": credentials.apiSecret,
			},
			body: JSON.stringify(body),
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
