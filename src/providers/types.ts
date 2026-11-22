/**
 * The one interface a messaging surface has to implement.
 *
 * Inbound is normalised by the provider's webhook or socket and handed to Hub
 * as an {@link InboundMessage}. Outbound is this: send text to an external
 * channel id. Everything above this line — the agent, its tools, MCP events —
 * sees the same shape regardless of whether the conversation is Discord or
 * iMessage.
 */

import type { Attachment, ProviderKind } from "../core/schema.ts";

export interface SendInput {
	readonly channel: string;
	readonly text: string;
	readonly attachments?: readonly Attachment[];
	readonly replyTo?: string;
}

export interface SendResult {
	readonly id?: string;
}

export interface MessagingProvider {
	readonly kind: ProviderKind;
	send(input: SendInput): Promise<SendResult>;
}
