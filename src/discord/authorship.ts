/**
 * Whether a Discord message was written by a bot or webhook.
 *
 * Watching a bot's message for a new thread, or starting a thread from one,
 * can make the gateway prompt Eryn from a thread on that message. That is an
 * internal loop with no human behind it, so those messages are refused before
 * a watch or thread is created.
 */

import type { DiscordMessageView } from "./api";

export function isBotAuthored(
	message: Pick<DiscordMessageView, "author" | "webhook_id">,
	botUserId?: string,
): boolean {
	return (
		message.author?.bot === true ||
		(botUserId !== undefined && message.author?.id === botUserId) ||
		message.webhook_id !== undefined
	);
}
