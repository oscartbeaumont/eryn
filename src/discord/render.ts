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

/**
 * An automated notice that a thread was created from a message the agent
 * subscribed to. The reference carries the ids the agent needs to act there.
 */
export function renderThreadCreated(
	thread: { id: string; name?: string; parent_id?: string },
	messageId: string,
): string {
	const entries: [string, string][] = [
		["type", "thread_created"],
		["messageId", messageId],
		["threadId", thread.id],
	];
	if (thread.name) entries.push(["name", thread.name]);
	if (thread.parent_id) entries.push(["channelId", thread.parent_id]);
	return [
		selfClosing("discord-event", entries),
		"Automated notice: a thread was created on the message you subscribed to. Eryn has joined it and is now subscribed, so its messages will reach you automatically.",
	].join("\n\n");
}

/**
 * An automated notice that the conversation was renamed.
 *
 * Kept until the next message so the agent learns the change without spending
 * a turn on it and without a second bot message appearing in the channel. The
 * id is the part that matters; it never changes.
 */
export function renderChannelRenamed(notice: {
	id: string;
	kind: "thread" | "channel";
	name: string;
	previousName?: string;
}): string {
	const entries: [string, string][] = [
		["type", "channel_renamed"],
		[notice.kind === "thread" ? "threadId" : "channelId", notice.id],
		["name", notice.name],
	];
	if (notice.previousName) entries.push(["previousName", notice.previousName]);
	const what = notice.kind === "thread" ? "thread" : "channel";
	return [
		selfClosing("discord-event", entries),
		`Automated notice: this ${what} was renamed${notice.previousName ? ` from "${notice.previousName}"` : ""}. Its id is unchanged, so keep using it.`,
	].join("\n\n");
}

/**
 * The channel a live prompt came from, and the thread when it came from one.
 *
 * The agent needs this in the message itself so it knows which conversation a
 * reply belongs to; its own output is not posted, so the ids are the only way
 * to address the reply.
 */
export function renderConversation(context: {
	channel: { id: string; name?: string };
	thread?: { id: string; name?: string };
	kind?: "thread" | "channel";
}): string {
	const channel: [string, string][] = [["id", context.channel.id]];
	if (context.channel.name) channel.push(["name", context.channel.name]);
	const blocks = [selfClosing("channel", channel)];
	if ((context.kind ?? "thread") === "thread" && context.thread) {
		const thread: [string, string][] = [["id", context.thread.id]];
		if (context.thread.name) thread.push(["name", context.thread.name]);
		blocks.push(selfClosing("thread", thread));
	}
	return blocks.join("\n");
}

/**
 * A message that reports a failed turn. It is deliberately distinct from
 * anything the agent wrote, so a reader can tell the turn stopped rather than
 * the agent choosing to say this.
 */
export function renderFailure(error: string): string {
	const hint = /deprecat|unavailable|not found/i.test(error)
		? "\n\nThe model for this server is no longer available — pick another with `/eryn setup`."
		: /credential|unauthor|401|403/i.test(error)
			? "\n\nThe key for this server was rejected — check or replace it with `/eryn setup`."
			: "";
	const quoted = (error.trim() || "Unknown error.")
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
	return `⚠️ **Eryn could not finish that turn.**\n${quoted}${hint}`;
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
