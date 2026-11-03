/**
 * Rendering Discord values for the model.
 *
 * The same speaker and mention formatting is used for a live prompt and for
 * messages read through a tool, so the agent does not have to learn two shapes
 * for the same conversation.
 */

import type { DiscordChannelRef, DiscordMessageView, DiscordUser } from "./api";
import { escapeXml } from "./context";

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
	const attributes: [string, string][] = [
		["name", user.name],
		...(user.username ? [["username", user.username] as [string, string]] : []),
		...(user.id ? [["id", user.id] as [string, string]] : []),
		...(user.bot ? [["bot", "true"] as [string, string]] : []),
	];
	return `<user ${attributes.map(([name, value]) => `${name}="${escapeXml(value)}"`).join(" ")} />`;
}

/** A self-closing channel reference. */
export function renderChannel(channel: DiscordChannelRef): string {
	const attributes: [string, string][] = [
		["id", channel.id],
		...(channel.name ? [["name", channel.name] as [string, string]] : []),
		["type", String(channel.type)],
		...(channel.parent_id ? [["parentId", channel.parent_id] as [string, string]] : []),
	];
	return `<channel ${attributes.map(([name, value]) => `${name}="${escapeXml(value)}"`).join(" ")} />`;
}

function replaceBotMentions(text: string, botUserId: string | undefined): string {
	if (!botUserId) return text;
	return text
		.replaceAll(`<@${botUserId}>`, "Eryn")
		.replaceAll(`<@!${botUserId}>`, "Eryn");
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
	const attributes: [string, string][] = [
		["id", message.id],
		...(message.timestamp ? [["timestamp", message.timestamp] as [string, string]] : []),
		...(message.edited_timestamp ? [["edited", "true"] as [string, string]] : []),
	];
	const header = `<message ${attributes.map(([name, value]) => `${name}="${escapeXml(value)}"`).join(" ")}>`;
	const files =
		attachments.length > 0
			? `\n<attachments>\n${attachments
					.map((file) => {
						const fileAttributes: [string, string][] = [
							...(file.filename ? [["name", file.filename] as [string, string]] : []),
							...(file.url ? [["url", file.url] as [string, string]] : []),
							...(file.content_type ? [["contentType", file.content_type] as [string, string]] : []),
							...(typeof file.size === "number" ? [["size", String(file.size)] as [string, string]] : []),
						];
						return `  <attachment ${fileAttributes.map(([name, value]) => `${name}="${escapeXml(value)}"`).join(" ")} />`;
					})
					.join("\n")}\n</attachments>`
			: "";
	return `${header}\n${renderUserMessage(author, mentions, text, botUserId)}${files}\n</message>`;
}
