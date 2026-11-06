/**
 * Rendering Discord values for the model.
 *
 * The same speaker and mention formatting is used for a live prompt and for
 * messages read through a tool, so the agent does not have to learn two shapes
 * for the same conversation.
 */

import type { DiscordChannelRef, DiscordMessageView } from "./api";
import { openingTag, selfClosing } from "./xml";

type Attachment = NonNullable<DiscordMessageView["attachments"]>[number];

export interface RenderUser {
	name: string;
	username?: string;
	id?: string;
	bot?: boolean;
}

function account(
	user: { id?: string; username?: string; global_name?: string; bot?: boolean } | undefined,
): RenderUser | undefined {
	if (!user) return undefined;
	const username = user.username?.trim();
	return {
		name: user.global_name?.trim() || username || user.id || "unknown",
		...(username ? { username } : {}),
		...(user.id ? { id: user.id } : {}),
		...(user.bot ? { bot: true } : {}),
	};
}

/** A self-closing account reference. */
export function renderUser(user: RenderUser): string {
	const entries: [string, string][] = [["name", user.name]];
	if (user.username) entries.push(["username", user.username]);
	if (user.id) entries.push(["id", user.id]);
	if (user.bot) entries.push(["bot", "true"]);
	return selfClosing("user", entries);
}

/** A self-closing channel reference. */
export function renderChannel(channel: DiscordChannelRef): string {
	const entries: [string, string][] = [["id", channel.id]];
	if (channel.name) entries.push(["name", channel.name]);
	entries.push(["type", String(channel.type)]);
	if (channel.parent_id) entries.push(["parentId", channel.parent_id]);
	return selfClosing("channel", entries);
}

function replaceBotMentions(text: string, botUserId: string | undefined): string {
	if (!botUserId) return text;
	return text.replaceAll(`<@${botUserId}>`, "Eryn").replaceAll(`<@!${botUserId}>`, "Eryn");
}

/**
 * Render one message as a speaker reference, optional mentions, and text.
 * Kept separate from {@link renderMessage} because a live prompt already has
 * the Discord channel context in the system prompt.
 */
export function renderUserMessage(
	author: RenderUser | undefined,
	mentions: readonly RenderUser[],
	text: string,
	botUserId?: string,
): string {
	const blocks: string[] = [];
	if (author) blocks.push(renderUser(author));
	const seen = new Set<string>();
	const references = mentions.filter((user) => {
		if (!user.id || user.id === author?.id || user.id === botUserId || seen.has(user.id)) return false;
		seen.add(user.id);
		return true;
	});
	if (references.length > 0) {
		blocks.push(`<mentions>\n${references.map((user) => `  ${renderUser(user)}`).join("\n")}\n</mentions>`);
	}
	return blocks.length > 0 ? `${blocks.join("\n")}\n\n${text}` : text;
}

/** One message read through a tool, with its channel-independent references. */
export function renderMessage(message: DiscordMessageView, botUserId?: string): string {
	const author = account(message.author);
	const mentions = (message.mentions ?? []).map(account).filter((user): user is RenderUser => user !== undefined);
	const attachments = message.attachments ?? [];
	const text =
		replaceBotMentions(message.content?.trim() ?? "", botUserId) ||
		(attachments.length > 0 ? "(attached files)" : "(no text)");

	const header: [string, string][] = [["id", message.id]];
	if (message.timestamp) header.push(["timestamp", message.timestamp]);
	if (message.edited_timestamp) header.push(["edited", "true"]);

	const files =
		attachments.length > 0
			? `\n<attachments>\n${attachments.map(renderAttachment).join("\n")}\n</attachments>`
			: "";
	return `${openingTag("message", header)}\n${renderUserMessage(author, mentions, text, botUserId)}${files}\n</message>`;
}

function renderAttachment(file: Attachment): string {
	const entries: [string, string][] = [];
	if (file.filename) entries.push(["name", file.filename]);
	if (file.url) entries.push(["url", file.url]);
	if (file.content_type) entries.push(["contentType", file.content_type]);
	if (typeof file.size === "number") entries.push(["size", String(file.size)]);
	return `  ${selfClosing("attachment", entries)}`;
}
