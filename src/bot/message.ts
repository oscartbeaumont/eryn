/**
 * What a Discord message means to the bot.
 *
 * Who spoke, who else was mentioned, the files it carried, and the text left
 * once the bot's own ping is removed. These are pure translations of Discord's
 * shapes into the session's; nothing here talks to Discord or the session.
 */

import { DEFAULT_THREAD_NAME } from "../discord/api";
import type { DiscordMessage } from "../discord/socket";
import type { PromptAttachment, PromptUser } from "../session/models";

/** Discord permits 100 characters in a thread name. */
const MAX_THREAD_NAME = 100;

/** Text that interrupts the running turn when sent in an owned thread. */
const STOP_TEXT = new Set(["stop", "cancel", "!stop", "!cancel", "/stop", "/cancel", "eryn stop", "eryn cancel"]);

/** Whether a message asks to cancel the turn running in its thread. */
export function isStopText(text: string): boolean {
	return STOP_TEXT.has(text.trim().toLowerCase());
}

/** Messages that should never reach the agent: webhooks and other bots, including Eryn itself. */
export function isBotMessage(message: DiscordMessage, botUserId: string): boolean {
	return message.webhook_id !== undefined || message.author?.bot === true || message.author?.id === botUserId;
}

/** The files a message carried, in the shape the session accepts. */
export function attachmentsOf(message: DiscordMessage): PromptAttachment[] {
	return (message.attachments ?? []).flatMap((attachment) => {
		const url = attachment.url ?? attachment.proxy_url;
		if (!url) return [];
		return [
			{
				url,
				...(attachment.filename ? { name: attachment.filename } : {}),
				...(attachment.content_type ? { contentType: attachment.content_type } : {}),
				...(typeof attachment.size === "number" ? { size: attachment.size } : {}),
			},
		];
	});
}

/**
 * Everything the agent needs to identify the speaker: the guild nickname or
 * display name, the account handle, and the Discord id. Discord's name
 * precedence is server nickname, then display name, then the handle.
 */
export function authorInfo(message: DiscordMessage): PromptUser {
	const username = message.author?.username?.trim();
	return {
		name:
			message.member?.nick?.trim() ||
			message.author?.global_name?.trim() ||
			username ||
			"someone",
		...(username ? { username } : {}),
		...(message.author?.id ? { id: message.author.id } : {}),
	};
}

/**
 * Other accounts pinged by the message, so inline <@id> references are not
 * opaque. The author is already the speaker and is left out here.
 */
export function mentionInfo(message: DiscordMessage, botUserId: string | undefined): PromptUser[] {
	const seen = new Set<string>();
	const mentions: PromptUser[] = [];
	for (const user of message.mentions ?? []) {
		if (!user.id || user.id === botUserId || user.id === message.author?.id || seen.has(user.id)) continue;
		seen.add(user.id);
		const username = user.username?.trim();
		mentions.push({
			name: user.global_name?.trim() || username || user.id,
			...(username ? { username } : {}),
			id: user.id,
			...(user.bot ? { bot: true } : {}),
		});
	}
	return mentions;
}

/** The pattern matching this bot's user mention, in either of Discord's forms. */
function mentionPattern(botUserId: string): RegExp {
	return new RegExp(`<@!?${botUserId}>`, "g");
}

/** A message that is addressed to the bot, by user ping or by its managed role. */
export function isMention(message: DiscordMessage, botUserId: string | undefined, roleId?: string): boolean {
	if (!botUserId) return false;
	if (message.mentions?.some((user) => user.id === botUserId)) return true;
	const content = message.content ?? "";
	if (mentionPattern(botUserId).test(content)) return true;
	if (roleId !== undefined) {
		if (message.mention_roles?.includes(roleId)) return true;
		if (content.includes(`<@&${roleId}>`)) return true;
	}
	return false;
}

/**
 * A message's text with the bot's ping removed.
 *
 * A message that was only a ping stays empty: it should not become a one-word
 * request just because the ping is rendered as "Eryn".
 */
export function stripMention(content: string, botUserId: string | undefined, roleId?: string): string {
	const pattern = botUserId ? mentionPattern(botUserId) : undefined;
	const replace = (replacement: string): string => {
		let text = pattern ? content.replace(pattern, replacement) : content;
		if (roleId !== undefined) text = text.replaceAll(`<@&${roleId}>`, replacement);
		return text.replace(/\s+/g, " ").trim();
	};
	return replace("") ? replace("Eryn") : "";
}

/** Derive a thread name from the request, inside Discord's 100 character limit. */
export function threadName(content: string): string {
	const text = content.replace(/\s+/g, " ").trim();
	if (!text) return DEFAULT_THREAD_NAME;
	return text.length > MAX_THREAD_NAME ? text.slice(0, MAX_THREAD_NAME - 1) : text;
}
