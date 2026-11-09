/**
 * Discord tools for the agent.
 *
 * The agent runs inside a guild, so every tool is scoped to that guild: a
 * channel id from another server is rejected before a request is made. The
 * tools use the bot's own REST client, so Discord permissions still apply.
 *
 * The tools are a declarative table rather than a series of registrations: each
 * entry names its schema and returns a value, and {@link toolExecute} turns
 * that value (or a thrown refusal) into the result the model reads. They cover
 * what the agent needs to participate in a conversation — look around, read,
 * post elsewhere, manage threads, subscribe to channels, watch a message for a
 * new thread, and react — and never touch server administration. The agent's
 * output is not posted, so `discord_send_message` is the only way it can speak
 * to users.
 *
 * This module is wired up by {@link discordPlugin}, which also owns the
 * per-session context: the two only make sense together, because the tools are
 * how the agent acts in the conversation the context describes.
 */

import type { Plugin } from "@opencode/plugin";

import {
	MAX_CONTENT,
	THREAD_TYPES,
	type DiscordChannelRef,
	type DiscordRest,
} from "../../discord/api";
import { renderChannel, renderMessage } from "../../discord/render";
import type { DiscordContext } from "../../session/models";
import { objectSchema, toolExecute, type ToolSpec } from "../tool";
import { readDiscordContext } from "./context";

function channelSummary(channel: DiscordChannelRef) {
	return {
		id: channel.id,
		name: channel.name ?? null,
		type: channel.type,
		parentId: channel.parent_id ?? null,
		archived: channel.thread_metadata?.archived ?? false,
		thread: THREAD_TYPES.has(channel.type),
	};
}

/** The input fields several tools share. */
const CHANNEL_ID = { type: "string", description: "Channel or thread id" };
const MESSAGE_ID = { type: "string", description: "Message id" };
const THREAD_ID = { type: "string", description: "Thread id" };

/** The arguments the schemas above describe, so each tool casts once. */
type ChannelInput = { channelId: string };
type MessageInput = ChannelInput & { messageId: string };
type ThreadInput = { threadId: string };

/** A message to watch for a thread being created from it. */
export interface MessageWatch {
	readonly channelId: string;
	readonly messageId: string;
	/** The conversation the agent should be told in; the caller's own, when it has one. */
	readonly notifyThreadId?: string;
	readonly notifyTitle?: string;
	readonly notifyDiscord?: DiscordContext;
}

export type SetMessageSubscription = (watch: MessageWatch, subscribed: boolean) => Promise<void>;

export function discordTools(
	rest: DiscordRest,
	guildId: string,
	setSubscription: (kind: "thread" | "channel", id: string, subscribed: boolean) => Promise<void>,
	setMessageSubscription: SetMessageSubscription,
) {
	/** A channel or thread the bot can use, restricted to this guild. */
	const channel = async (channelId: string): Promise<DiscordChannelRef> => {
		const found = await rest.channel(channelId);
		if (!found) throw new Error(`Channel ${channelId} was not found.`);
		if (found.guild_id !== undefined && found.guild_id !== guildId) {
			throw new Error(`Channel ${channelId} is not in this server.`);
		}
		return found;
	};

	const thread = async (threadId: string): Promise<DiscordChannelRef> => {
		const found = await channel(threadId);
		if (!THREAD_TYPES.has(found.type)) throw new Error(`${threadId} is not a thread.`);
		return found;
	};

	/** A channel that can hold a subscribed conversation, which a thread cannot. */
	const subscribableChannel = async (channelId: string): Promise<DiscordChannelRef> => {
		const found = await channel(channelId);
		if (found.guild_id !== guildId) throw new Error(`Channel ${channelId} is not in this server.`);
		if (THREAD_TYPES.has(found.type)) {
			throw new Error(`${channelId} is a thread. Use discord_join_thread and discord_leave_thread for threads.`);
		}
		return found;
	};

	// Filled in by `setup`: a tool may render a message, and the bot's own id is
	// what turns its mentions into "Eryn" rather than a raw `<@…>` token.
	let botUserId: string | undefined;
	// Also filled in by `setup`: the notice for a fired watch is sent to the
	// conversation that asked for the watch, which is read from the session.
	let plugin: Plugin.Context | undefined;

	/** The conversation a watch should notify, from the calling session's metadata. */
	const notifyTarget = async (sessionID: string) => {
		const session = plugin
			? await plugin.session.get({ sessionID }).catch(() => undefined)
			: undefined;
		const discord = readDiscordContext(session?.metadata);
		if (!discord) return {};
		return {
			notifyThreadId: discord.thread.id,
			...(discord.thread.name ? { notifyTitle: discord.thread.name } : {}),
			notifyDiscord: discord,
		};
	};

	const tools: ToolSpec[] = [
		{
			name: "discord_list_channels",
			description:
				"List the channels and active threads in this Discord server, with their ids, names, parent ids, and whether they are threads.",
			input: objectSchema({}),
			async run() {
				const [channels, threads] = await Promise.all([
					rest.guildChannels(guildId),
					rest.activeThreads(guildId),
				]);
				return [...channels.map(channelSummary), ...threads.map(channelSummary)];
			},
		},

		{
			name: "discord_list_threads",
			description: "List the active threads in this Discord server.",
			input: objectSchema({}),
			async run() {
				return (await rest.activeThreads(guildId)).map(channelSummary);
			},
		},

		{
			name: "discord_read_messages",
			description:
				"Read recent messages from a channel or thread in this server. Messages are returned newest first with author and attachment details.",
			input: objectSchema(
				{
					channelId: CHANNEL_ID,
					limit: { type: "number", description: "Number of messages, 1–50 (default 20)" },
					before: { type: "string", description: "Only messages before this message id" },
				},
				["channelId"],
			),
			async run(rawInput) {
				const { channelId, limit, before } = rawInput as ChannelInput & { limit?: number; before?: string };
				const channelInfo = await channel(channelId);
				const messages = await rest.channelMessages(channelId, {
					limit: Math.min(Math.max(Math.trunc(limit ?? 20), 1), 50),
					...(before ? { before } : {}),
				});
				return [renderChannel(channelInfo), ...messages.map((message) => renderMessage(message, botUserId))].join("\n\n");
			},
		},

		{
			name: "discord_send_message",
			description:
				"Send a message to a channel or thread in this server. This is how you reply: your own output is not posted to Discord. Pass the thread id from the message's <thread> element, or the channel id from its <channel> element, as channelId. Mentions are suppressed; replyTo attaches the message as a reply.",
			input: objectSchema(
				{
					channelId: CHANNEL_ID,
					content: { type: "string", description: "Message text, up to 2000 characters" },
					replyTo: { type: "string", description: "Optional message id to reply to" },
				},
				["channelId", "content"],
			),
			async run(rawInput) {
				const { channelId, content, replyTo } = rawInput as ChannelInput & { content: string; replyTo?: string };
				await channel(channelId);
				if (!content.trim()) throw new Error("Message content is required.");
				if (content.length > MAX_CONTENT) throw new Error("Discord messages are limited to 2000 characters.");
				return await rest.sendMessage(channelId, content, replyTo ? { replyTo } : {});
			},
		},

		{
			name: "discord_create_thread",
			description:
				"Create a public thread in a text channel, optionally attached to a message. Returns the new thread id.",
			input: objectSchema(
				{
					channelId: { type: "string", description: "Text channel id" },
					name: { type: "string", description: "Thread name, up to 100 characters" },
					messageId: { type: "string", description: "Optional message to start the thread from" },
				},
				["channelId", "name"],
			),
			async run(rawInput) {
				const { channelId, name: rawName, messageId } = rawInput as ChannelInput & { name: string; messageId?: string };
				await channel(channelId);
				const name = rawName.trim().slice(0, 100);
				if (!name) throw new Error("A thread name is required.");
				return messageId
					? await rest.createThread(channelId, messageId, name)
					: await rest.startThread(channelId, name);
			},
		},

		{
			name: "discord_subscribe_message",
			description:
				"Watch a message in this server. If a thread is created from it, you will be told the new thread's id in this conversation, and Eryn will automatically join and subscribe to that thread so its messages start a turn. Discord gives a thread created from a message the same id as the message.",
			input: objectSchema({ channelId: CHANNEL_ID, messageId: MESSAGE_ID }, ["channelId", "messageId"]),
			async run(rawInput, call) {
				const { channelId, messageId } = rawInput as MessageInput;
				if (THREAD_TYPES.has((await channel(channelId)).type)) {
					throw new Error(`A thread cannot be created from a message inside ${channelId}.`);
				}
				if (!(await rest.message(channelId, messageId))) {
					throw new Error(`Message ${messageId} was not found in ${channelId}.`);
				}
				await setMessageSubscription(
					{ channelId, messageId, ...(await notifyTarget(call.sessionID)) },
					true,
				);
				return { ok: true, channelId, messageId, subscribed: true };
			},
		},

		{
			name: "discord_unsubscribe_message",
			description: "Stop watching a message for a thread being created from it. Existing thread subscriptions are unchanged.",
			input: objectSchema({ channelId: CHANNEL_ID, messageId: MESSAGE_ID }, ["channelId", "messageId"]),
			async run(rawInput) {
				const { channelId, messageId } = rawInput as MessageInput;
				await channel(channelId);
				await setMessageSubscription({ channelId, messageId }, false);
				return { ok: true, channelId, messageId, subscribed: false };
			},
		},

		{
			name: "discord_archive_thread",
			description: "Archive or close a thread. Set locked to also prevent new messages.",
			input: objectSchema(
				{
					threadId: THREAD_ID,
					locked: { type: "boolean", description: "Also lock the thread (default false)" },
				},
				["threadId"],
			),
			async run(rawInput) {
				const { threadId, locked } = rawInput as ThreadInput & { locked?: boolean };
				await thread(threadId);
				await rest.setThreadArchived(threadId, true, locked ?? false);
				return { ok: true, threadId };
			},
		},

		{
			name: "discord_join_thread",
			description:
				"Join a thread and subscribe Eryn to its messages. New messages in the thread will start a turn without needing a mention.",
			input: objectSchema({ threadId: THREAD_ID }, ["threadId"]),
			async run(rawInput) {
				const { threadId } = rawInput as ThreadInput;
				await thread(threadId);
				await rest.joinThread(threadId);
				await setSubscription("thread", threadId, true);
				return { ok: true, threadId, subscribed: true };
			},
		},

		{
			name: "discord_leave_thread",
			description: "Leave a thread and stop Eryn from responding to its messages.",
			input: objectSchema({ threadId: THREAD_ID }, ["threadId"]),
			async run(rawInput) {
				const { threadId } = rawInput as ThreadInput;
				await thread(threadId);
				await rest.leaveThread(threadId);
				await setSubscription("thread", threadId, false);
				return { ok: true, threadId, subscribed: false };
			},
		},

		{
			name: "discord_join_channel",
			description:
				"Subscribe Eryn to a channel. New messages in the channel will start a turn without needing a mention, and replies are posted in the channel. Use this for channels, not threads.",
			input: objectSchema({ channelId: CHANNEL_ID }, ["channelId"]),
			async run(rawInput) {
				const { channelId } = rawInput as ChannelInput;
				await subscribableChannel(channelId);
				await setSubscription("channel", channelId, true);
				return { ok: true, channelId, subscribed: true };
			},
		},

		{
			name: "discord_leave_channel",
			description: "Unsubscribe Eryn from a channel and stop responding to its messages.",
			input: objectSchema({ channelId: CHANNEL_ID }, ["channelId"]),
			async run(rawInput) {
				const { channelId } = rawInput as ChannelInput;
				await subscribableChannel(channelId);
				await setSubscription("channel", channelId, false);
				return { ok: true, channelId, subscribed: false };
			},
		},

		{
			name: "discord_react",
			description: "Add or remove an emoji reaction on a message.",
			input: objectSchema(
				{
					channelId: CHANNEL_ID,
					messageId: MESSAGE_ID,
					emoji: { type: "string", description: "Unicode emoji or custom emoji as name:id" },
					remove: { type: "boolean", description: "Remove the reaction instead of adding it" },
				},
				["channelId", "messageId", "emoji"],
			),
			async run(rawInput) {
				const { channelId, messageId, emoji, remove } = rawInput as MessageInput & { emoji: string; remove?: boolean };
				await channel(channelId);
				if (remove) await rest.removeReaction(channelId, messageId, emoji);
				else await rest.addReaction(channelId, messageId, emoji);
				return { ok: true };
			},
		},

		{
			name: "discord_edit_message",
			description: "Edit a message the bot is allowed to edit.",
			input: objectSchema(
				{
					channelId: CHANNEL_ID,
					messageId: MESSAGE_ID,
					content: { type: "string", description: "New message text, up to 2000 characters" },
				},
				["channelId", "messageId", "content"],
			),
			async run(rawInput) {
				const { channelId, messageId, content } = rawInput as MessageInput & { content: string };
				await channel(channelId);
				if (content.length > MAX_CONTENT) throw new Error("Discord messages are limited to 2000 characters.");
				await rest.editMessage(channelId, messageId, content);
				return { ok: true };
			},
		},

		{
			name: "discord_delete_message",
			description: "Delete a message the bot is allowed to delete.",
			input: objectSchema({ channelId: CHANNEL_ID, messageId: MESSAGE_ID }, ["channelId", "messageId"]),
			async run(rawInput) {
				const { channelId, messageId } = rawInput as MessageInput;
				await channel(channelId);
				await rest.deleteMessage(channelId, messageId);
				return { ok: true };
			},
		},

		{
			name: "discord_pin_message",
			description: "Pin or unpin a message in a channel or thread.",
			input: objectSchema(
				{
					channelId: CHANNEL_ID,
					messageId: MESSAGE_ID,
					remove: { type: "boolean", description: "Unpin instead of pinning" },
				},
				["channelId", "messageId"],
			),
			async run(rawInput) {
				const { channelId, messageId, remove } = rawInput as MessageInput & { remove?: boolean };
				await channel(channelId);
				if (remove) await rest.unpinMessage(channelId, messageId);
				else await rest.pinMessage(channelId, messageId);
				return { ok: true };
			},
		},
	];

	return {
		/** Register the tools on the plugin context, after resolving the bot's id. */
		async setup(ctx: Plugin.Context): Promise<void> {
			plugin = ctx;
			botUserId = await rest.me().then((me) => me.id).catch(() => undefined);
			await ctx.tool.transform((editor) => {
				for (const spec of tools) {
					editor.add({
						name: spec.name,
						description: spec.description,
						input: spec.input,
						execute: toolExecute(spec, ctx),
					});
				}
			});
		},
	};
}
