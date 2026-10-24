/**
 * The MCP Events extension.
 *
 * The extension is a draft that sits outside the negotiated core protocol, so it
 * is served beside Effect's `McpServer` rather than through it: `events/list`,
 * `events/subscribe`, `events/unsubscribe`, `events/poll`, and the `events/stream`
 * SSE response. `subscriptions/listen` is core, and goes to the `McpServer`.
 *
 * The shape mirrors the reference implementation (`agateway`): an event is
 * `{ eventId, name, timestamp, data }`, a subscription names the event and its
 * arguments, and every occurrence is stamped with the subscription it came from.
 */

export type Delivery = "webhook" | "push" | "poll";

export interface EventDescriptor {
	name: string;
	description: string;
	delivery: Delivery[];
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties: false;
	};
}

export const DISCORD_MESSAGE_EVENT = "discord.message.created";

/** The events this deployment can produce, given what the caller has connected. */
export function descriptors(hasDiscord: boolean): EventDescriptor[] {
	if (!hasDiscord) return [];
	return [
		{
			name: DISCORD_MESSAGE_EVENT,
			description: "A new message was posted in the selected channel or thread.",
			delivery: ["webhook", "push", "poll"],
			inputSchema: {
				type: "object",
				properties: {
					channel_id: { type: "string", description: "Discord channel or thread id to monitor." },
					author_id: { type: "string", description: "Only receive messages from this Discord user." },
				},
				required: ["channel_id"],
				additionalProperties: false,
			},
		},
	];
}

export interface Occurrence {
	eventId: string;
	name: string;
	timestamp: string;
	data: Record<string, unknown>;
	/** Monotonic, and the poll cursor's unit. */
	seq: number;
}

export interface Subscription {
	id: string;
	name: string;
	args: { channel_id: string; author_id?: string };
	delivery: Delivery;
	/** Present for webhook delivery. */
	url?: string;
	secret?: string;
	expiresAt?: number;
	createdAt: number;
}

/** The frame an SSE event stream carries. */
export function sseFrame(event: { method: string; params: Record<string, unknown> }): string {
	return `data: ${JSON.stringify({ jsonrpc: "2.0", ...event })}\n\n`;
}
