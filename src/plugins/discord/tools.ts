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
	type DiscordMessageView,
	type DiscordRest,
} from "../../discord/api";
import type { DiscordAuthority } from "../../discord/authority";
import { isBotAuthored } from "../../discord/authorship";
import { actionButton, buttonRow, selectRow } from "../../discord/components";
import { Permission } from "../../discord/permissions";
import { renderChannel, renderMessage } from "../../discord/render";
import type { DiscordContext, ScheduleScope } from "../../session/models";
import {
	addChannelToScope,
	canEditScheduleScope,
	removeChannelFromScope,
	scopeAllows,
} from "../../session/schedule-scope";
import { objectSchema, toolExecute, type ToolCall, type ToolSpec } from "../tool";
import { DISCORD_METADATA_KEY, readDiscordContext } from "./context";

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

/** The JSON metadata boundary: stored scope arrays are readonly for readers. */
type SessionMetadata = NonNullable<Parameters<Plugin.Context["session"]["update"]>[0]["metadata"]>;

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
	authority: DiscordAuthority,
	onMessageSent?: (threadId: string) => void,
) {
	/** A channel or thread the bot can use, restricted to this guild. */
	const channel = async (channelId: string): Promise<DiscordChannelRef> => {
		const found = await rest.channel(channelId);
		if (!found) throw new Error(`Channel ${channelId} was not found.`);
		// A DM or group DM has no guild_id. The tools only work inside this
		// server, so anything else is refused rather than treated as local.
		if (found.guild_id !== guildId) {
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

	/**
	 * The Discord context stored on the calling session.
	 *
	 * Every authorization decision starts here: it names both the conversation
	 * the turn belongs to and the person who prompted it. A missing context
	 * cannot be authorized, so it is a refusal rather than an empty default.
	 */
	const sessionContext = async (sessionID: string): Promise<DiscordContext> => {
		if (!plugin) throw new Error("Eryn cannot verify Discord permissions right now.");
		const session = await plugin.session.get({ sessionID }).catch(() => undefined);
		const context = readDiscordContext(session?.metadata);
		if (!context) {
			throw new Error("This conversation has no Discord context, so Eryn cannot verify who is asking.");
		}
		return context;
	};

	/** Whether `channelId` is part of the conversation this turn belongs to. */
	const isCurrentConversation = (context: DiscordContext, channelId: string): boolean =>
		context.thread.id === channelId || context.channel.id === channelId;

	/**
	 * Require the speaker to have Discord permissions in a channel.
	 *
	 * A scheduled or automated turn has no speaker. It may still read and send
	 * in its own conversation, because the reply has to land somewhere, but
	 * anything else is refused: there is no person whose permissions could
	 * justify it.
	 */
	const requireChannelPermission = async (
		sessionID: string,
		channelId: string,
		required: bigint,
		label: string,
		options: { allowWithoutAuthor?: boolean } = {},
	): Promise<void> => {
		const context = await sessionContext(sessionID);
		// A schedule has a capability scope, not a person. The scope is the
		// ceiling even when the last human had more access.
		if (context.scheduleTurn && context.scheduleScope) {
			if (!scopeAllows(context.scheduleScope, channelId, required)) {
				throw new Error(
					`This schedule's Discord access does not allow Eryn to ${label} in <#${channelId}>.`,
				);
			}
			return;
		}
		if (!context.authorId) {
			if (options.allowWithoutAuthor && isCurrentConversation(context, channelId)) return;
			throw new Error(
				`This turn has no Discord user attached, so Eryn will not ${label} outside this conversation.`,
			);
		}
		if (!(await authority.can(context.authorId, channelId, required))) {
			throw new Error(
				`Your Discord permissions do not allow Eryn to ${label} in <#${channelId}>.`,
			);
		}
	};

	/** Require Manage Server, which is what server configuration asks for. */
	const requireManageGuild = async (sessionID: string, label: string): Promise<void> => {
		const context = await sessionContext(sessionID);
		if (context.scheduleTurn) {
			throw new Error(`A scheduled turn has no person to approve server configuration.`);
		}
		if (!context.authorId) {
			throw new Error(`This turn has no Discord user attached, so Eryn will not ${label}.`);
		}
		if (!(await authority.canManageGuild(context.authorId))) {
			throw new Error(`Only someone with Manage Server can ${label}.`);
		}
	};

	/**
	 * Whether the speaker may change the schedule scope.
	 *
	 * Only the scope's owner or someone with Manage Server may do it. A
	 * schedule turn has no person, so it never may.
	 */
	const canEditScope = async (context: DiscordContext): Promise<boolean> => {
		const scope = context.scheduleScope;
		if (!scope || context.scheduleTurn || !context.authorId) return false;
		if (canEditScheduleScope(scope, context.authorId, false)) return true;
		return await authority.canManageGuild(context.authorId);
	};

	/** Update the stored scope, if this conversation has one. */
	const updateScheduleScope = async (
		sessionID: string,
		update: (scope: ScheduleScope, context: DiscordContext) => ScheduleScope | undefined,
	): Promise<void> => {
		if (!plugin) return;
		const session = await plugin.session.get({ sessionID }).catch(() => undefined);
		const context = readDiscordContext(session?.metadata);
		if (!session || !context?.scheduleScope) return;
		const next = update(context.scheduleScope, context);
		if (next === context.scheduleScope) return;
		await plugin.session.update({
			sessionID,
			metadata: {
				...session.metadata,
				// Merge, do not replace: the Discord context and other plugins'
				// metadata share this session record.
				[DISCORD_METADATA_KEY]: next
					? { ...context, scheduleScope: next }
					: { ...context, scheduleScope: undefined },
			} as unknown as SessionMetadata,
		});
	};

	/** Add a channel to the schedule scope when this speaker may do so. */
	const expandScheduleScope = async (sessionID: string, channelId: string): Promise<void> => {
		const context = await sessionContext(sessionID);
		if (!context.authorId || !(await canEditScope(context))) return;
		const info = await rest.channel(channelId).catch(() => undefined);
		if (!info) return;
		// The schedule gets only what this editor can actually do here; it does
		// not inherit a broader grant from the bot or from the scope owner.
		const capabilities = await authority.scopeCapabilities(context.authorId, info);
		if (!capabilities.read && !capabilities.send) return;
		await updateScheduleScope(sessionID, (scope) =>
			addChannelToScope(scope, channelId, capabilities, Date.now()),
		);
	};

	/** Remove a channel from the schedule scope, never the conversation itself. */
	const contractScheduleScope = async (sessionID: string, channelId: string): Promise<void> => {
		const context = await sessionContext(sessionID);
		if (!(await canEditScope(context))) return;
		await updateScheduleScope(sessionID, (scope, current) =>
			removeChannelFromScope(scope, channelId, current.thread.id, Date.now()),
		);
	};

	/**
	 * Let a schedule use a thread it just created inside a channel it can use.
	 *
	 * A thread inherits its parent channel's Discord permissions, so this adds
	 * no reach the scope did not already have. It is not an arbitrary scope
	 * expansion: the capabilities are copied from the parent, never widened,
	 * and only happen on a schedule turn.
	 */
	const inheritThreadScope = async (
		sessionID: string,
		parentId: string,
		threadId: string,
	): Promise<void> => {
		const context = await sessionContext(sessionID);
		if (!context.scheduleTurn) return;
		const parent = context.scheduleScope?.channels[parentId];
		if (!parent) return;
		await updateScheduleScope(sessionID, (scope) =>
			addChannelToScope(
				scope,
				threadId,
				{
					read: parent.read,
					// A thread uses Send Messages in Threads, which the parent's
					// `send` (Send Messages) does not imply. Use the creator's
					// thread-send reach captured when the scope was written.
					send: parent.sendInThreads === true,
					sendInThreads: parent.sendInThreads === true,
					manage: parent.manage,
					createThread: false,
					react: parent.react === true,
				},
				Date.now(),
			),
		);
	};

	/**
	 * A message that may grow a thread.
	 *
	 * Watching or threading a bot's own message can make the gateway prompt
	 * Eryn from a thread on that message, which can loop. Webhooks are treated
	 * the same way: they are not a person asking for anything.
	 */
	const requireHumanMessage = async (
		channelId: string,
		messageId: string,
	): Promise<DiscordMessageView> => {
		const message = await rest.message(channelId, messageId);
		if (!message) throw new Error(`Message ${messageId} was not found in ${channelId}.`);
		if (isBotAuthored(message, botUserId)) {
			throw new Error(
				`Message ${messageId} was written by a bot or webhook, so Eryn will not start or watch a thread from it.`,
			);
		}
		return message;
	};

	/**
	 * Assert the cross-channel policy before a tool reaches another channel.
	 *
	 * This runs as a tool guard, outside `toolExecute`'s catch, so an `ask`
	 * posts a card and a `block` ends the step instead of becoming tool output.
	 * It is defense in depth: the speaker's own Discord permissions are checked
	 * again in the tool body, and an approval never widens them.
	 */
	const crossChannel = async (call: ToolCall, targetChannelId: string): Promise<void> => {
		const context = await sessionContext(call.sessionID);
		if (isCurrentConversation(context, targetChannelId)) return;
		if (!plugin) throw new Error("Eryn cannot check the cross-channel policy right now.");
		await plugin.permission.assert({
			action: "discord.cross-channel",
			resources: [targetChannelId],
			save: ["*"],
			sessionID: call.sessionID,
			metadata: { targetChannelId },
		});
	};

	/** A guard for a tool whose target is named by one input field. */
	const guardChannel =
		(key: "channelId" | "threadId") =>
		async (input: Record<string, unknown>, call: ToolCall): Promise<void> => {
			const channelId = input[key];
			if (typeof channelId === "string") await crossChannel(call, channelId);
		};

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
			async run(_rawInput, call) {
				const context = await sessionContext(call.sessionID);
				if (context.scheduleTurn) {
					// A schedule has no view of the server beyond its scope. Return
					// only those channels, even if the bot can see more.
					const allowed = new Set(Object.keys(context.scheduleScope?.channels ?? {}));
					const [channels, threads] = await Promise.all([
						rest.guildChannels(guildId),
						rest.activeThreads(guildId),
					]);
					return [...channels, ...threads].filter((entry) => allowed.has(entry.id)).map(channelSummary);
				}
				// Without a speaker there is nobody whose view of the server could
				// be shown. The conversation's own ids are already in the prompt,
				// so an empty list is the safe answer.
				if (!context.authorId) return [];
				const [channels, threads] = await Promise.all([
					rest.guildChannels(guildId),
					rest.activeThreads(guildId),
				]);
				const visible = await authority.filterVisible(context.authorId, [...channels, ...threads]);
				return visible.map(channelSummary);
			},
		},

		{
			name: "discord_list_threads",
			description: "List the active threads in this Discord server.",
			input: objectSchema({}),
			async run(_rawInput, call) {
				const context = await sessionContext(call.sessionID);
				const threads = await rest.activeThreads(guildId);
				if (context.scheduleTurn) {
					const allowed = new Set(Object.keys(context.scheduleScope?.channels ?? {}));
					return threads.filter((entry) => allowed.has(entry.id)).map(channelSummary);
				}
				if (!context.authorId) return [];
				return (await authority.filterVisible(context.authorId, threads)).map(channelSummary);
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
			guard: guardChannel("channelId"),
			async run(rawInput, call) {
				const { channelId, limit, before } = rawInput as ChannelInput & { limit?: number; before?: string };
				const channelInfo = await channel(channelId);
				await requireChannelPermission(
					call.sessionID,
					channelId,
					Permission.ViewChannel | Permission.ReadMessageHistory,
					"read messages",
					{ allowWithoutAuthor: true },
				);
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
			guard: guardChannel("channelId"),
			async run(rawInput, call) {
				const { channelId, content, replyTo } = rawInput as ChannelInput & { content: string; replyTo?: string };
				const found = await channel(channelId);
				await requireChannelPermission(
					call.sessionID,
					channelId,
					Permission.ViewChannel |
						(THREAD_TYPES.has(found.type)
							? Permission.SendMessagesInThreads
							: Permission.SendMessages),
					"send messages",
					{ allowWithoutAuthor: true },
				);
				if (!content.trim()) throw new Error("Message content is required.");
				if (content.length > MAX_CONTENT) throw new Error("Discord messages are limited to 2000 characters.");
				const sent = await rest.sendMessage(channelId, content, replyTo ? { replyTo } : {});
				// A successful send is the usage signal: the turn either replied
				// in its conversation or it did not. Content is not involved.
				onMessageSent?.(channelId);
				return sent;
			},
		},

		{
			name: "discord_ask",
			description:
				"Ask the person in this conversation a question. Pass options to show them as buttons (up to five) or, for longer lists, a select menu. The question is posted in the conversation and this tool returns immediately: end your turn after calling it. The answer arrives as a new message and starts the next turn.",
			input: objectSchema(
				{
					question: { type: "string", description: "The question to ask" },
					options: {
						type: "array",
						items: { type: "string" },
						description: "Optional choices, up to 25",
					},
					multiple: {
						type: "boolean",
						description: "Allow more than one choice (default false)",
					},
				},
				["question"],
			),
			async run(rawInput, call) {
				const { question, options: rawOptions, multiple } = rawInput as {
					question: string;
					options?: string[];
					multiple?: boolean;
				};
				const context = await sessionContext(call.sessionID);
				if (context.scheduleTurn) {
					throw new Error("A scheduled turn has no one to answer a question.");
				}
				const authorId = context.authorId;
				if (!authorId) throw new Error("This turn has no Discord user to answer.");
				const asked = question.trim().slice(0, 2_000);
				if (!asked) throw new Error("A question is required.");

				const options = [
					...new Set((rawOptions ?? []).map((option) => option.trim()).filter(Boolean)),
				].slice(0, 25);
				const components = options.length
					? [
							options.length <= 5 && multiple !== true
								? buttonRow(
										options.map((option, index) =>
											actionButton(option, `ask:b:${authorId}:${index}`, 2),
										),
									)
								: selectRow({
										type: 3,
										custom_id: `ask:s:${authorId}`,
										placeholder: "Choose an answer",
										options: options.map((option, index) => ({
											label: option.slice(0, 100),
											value: String(index),
										})),
										min_values: 1,
										max_values: multiple === true ? options.length : 1,
									}),
						]
					: undefined;

				const content = [
					"❓ **Eryn has a question**",
					asked,
					options.length
						? "_Choose an answer below._"
						: "_Reply in this conversation with your answer._",
				].join("\n");
				await rest.sendMessage(
					context.thread.id,
					content.length > MAX_CONTENT ? `${content.slice(0, MAX_CONTENT - 10)}…` : content,
					components ? { components } : {},
				);

				return {
					posted: true,
					question: asked,
					...(options.length ? { options } : {}),
					note: "The question is now in the conversation. End your turn; the answer will arrive as a new message.",
				};
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
			guard: guardChannel("channelId"),
			async run(rawInput, call) {
				const { channelId, name: rawName, messageId } = rawInput as ChannelInput & { name: string; messageId?: string };
				await channel(channelId);
				await requireChannelPermission(
					call.sessionID,
					channelId,
					Permission.ViewChannel | Permission.CreatePublicThreads,
					"create a thread",
				);
				const name = rawName.trim().slice(0, 100);
				if (!name) throw new Error("A thread name is required.");
				// Threading a bot's message is another way to make a bot-authored
				// thread, so refuse it here as well as in the message watch.
				if (messageId) await requireHumanMessage(channelId, messageId);
				const created = messageId
					? await rest.createThread(channelId, messageId, name)
					: await rest.startThread(channelId, name);
				// A schedule may then post in the thread it made, under the same
				// capabilities it had in the parent channel.
				await inheritThreadScope(call.sessionID, channelId, created.id);
				return created;
			},
		},

		{
			name: "discord_subscribe_message",
			description:
				"Watch a message in this server. If a thread is created from it, you will be told the new thread's id in this conversation, and Eryn will automatically join and subscribe to that thread so its messages start a turn. Discord gives a thread created from a message the same id as the message.",
			input: objectSchema({ channelId: CHANNEL_ID, messageId: MESSAGE_ID }, ["channelId", "messageId"]),
			guard: guardChannel("channelId"),
			async run(rawInput, call) {
				const { channelId, messageId } = rawInput as MessageInput;
				if (THREAD_TYPES.has((await channel(channelId)).type)) {
					throw new Error(`A thread cannot be created from a message inside ${channelId}.`);
				}
				await requireChannelPermission(
					call.sessionID,
					channelId,
					Permission.ViewChannel | Permission.ReadMessageHistory,
					"watch that message",
				);
				await requireHumanMessage(channelId, messageId);
				await setMessageSubscription(
					{ channelId, messageId, ...(await notifyTarget(call.sessionID)) },
					true,
				);
				await expandScheduleScope(call.sessionID, channelId);
				return { ok: true, channelId, messageId, subscribed: true };
			},
		},

		{
			name: "discord_unsubscribe_message",
			description: "Stop watching a message for a thread being created from it. Existing thread subscriptions are unchanged.",
			input: objectSchema({ channelId: CHANNEL_ID, messageId: MESSAGE_ID }, ["channelId", "messageId"]),
			guard: guardChannel("channelId"),
			async run(rawInput, call) {
				const { channelId, messageId } = rawInput as MessageInput;
				await channel(channelId);
				await requireChannelPermission(
					call.sessionID,
					channelId,
					Permission.ViewChannel | Permission.ReadMessageHistory,
					"stop watching that message",
				);
				await setMessageSubscription({ channelId, messageId }, false);
				await contractScheduleScope(call.sessionID, channelId);
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
			guard: guardChannel("threadId"),
			async run(rawInput, call) {
				const { threadId, locked } = rawInput as ThreadInput & { locked?: boolean };
				await thread(threadId);
				await requireChannelPermission(
					call.sessionID,
					threadId,
					Permission.ManageThreads,
					"archive that thread",
				);
				await rest.setThreadArchived(threadId, true, locked ?? false);
				return { ok: true, threadId };
			},
		},

		{
			name: "discord_join_thread",
			description:
				"Join a thread and subscribe Eryn to its messages. New messages in the thread will start a turn without needing a mention.",
			input: objectSchema({ threadId: THREAD_ID }, ["threadId"]),
			guard: guardChannel("threadId"),
			async run(rawInput, call) {
				const { threadId } = rawInput as ThreadInput;
				await thread(threadId);
				// A private thread additionally requires membership (or manager
				// rights); the resolver enforces that as part of ViewChannel.
				await requireChannelPermission(call.sessionID, threadId, Permission.ViewChannel, "join that thread");
				await rest.joinThread(threadId);
				await setSubscription("thread", threadId, true);
				return { ok: true, threadId, subscribed: true };
			},
		},

		{
			name: "discord_leave_thread",
			description: "Leave a thread and stop Eryn from responding to its messages.",
			input: objectSchema({ threadId: THREAD_ID }, ["threadId"]),
			guard: guardChannel("threadId"),
			async run(rawInput, call) {
				const { threadId } = rawInput as ThreadInput;
				await thread(threadId);
				await requireChannelPermission(call.sessionID, threadId, Permission.ViewChannel, "leave that thread");
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
			guard: guardChannel("channelId"),
			async run(rawInput, call) {
				const { channelId } = rawInput as ChannelInput;
				await subscribableChannel(channelId);
				await requireManageGuild(call.sessionID, "subscribe Eryn to a channel");
				await setSubscription("channel", channelId, true);
				await expandScheduleScope(call.sessionID, channelId);
				return { ok: true, channelId, subscribed: true };
			},
		},

		{
			name: "discord_leave_channel",
			description: "Unsubscribe Eryn from a channel and stop responding to its messages.",
			input: objectSchema({ channelId: CHANNEL_ID }, ["channelId"]),
			guard: guardChannel("channelId"),
			async run(rawInput, call) {
				const { channelId } = rawInput as ChannelInput;
				await subscribableChannel(channelId);
				await requireManageGuild(call.sessionID, "unsubscribe Eryn from a channel");
				await setSubscription("channel", channelId, false);
				await contractScheduleScope(call.sessionID, channelId);
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
			guard: guardChannel("channelId"),
			async run(rawInput, call) {
				const { channelId, messageId, emoji, remove } = rawInput as MessageInput & { emoji: string; remove?: boolean };
				await channel(channelId);
				await requireChannelPermission(
					call.sessionID,
					channelId,
					Permission.ViewChannel | Permission.AddReactions,
					"react to messages",
				);
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
			guard: guardChannel("channelId"),
			async run(rawInput, call) {
				const { channelId, messageId, content } = rawInput as MessageInput & { content: string };
				await channel(channelId);
				const message = await rest.message(channelId, messageId);
				if (!message) throw new Error(`Message ${messageId} was not found in ${channelId}.`);
				// Editing Eryn's own message only needs visibility; editing anyone
				// else's is a moderation action.
				const own = botUserId !== undefined && message.author?.id === botUserId;
				await requireChannelPermission(
					call.sessionID,
					channelId,
					own ? Permission.ViewChannel : Permission.ViewChannel | Permission.ManageMessages,
					own ? "edit its own message" : "edit messages",
				);
				if (content.length > MAX_CONTENT) throw new Error("Discord messages are limited to 2000 characters.");
				await rest.editMessage(channelId, messageId, content);
				return { ok: true };
			},
		},

		{
			name: "discord_delete_message",
			description: "Delete a message the bot is allowed to delete.",
			input: objectSchema({ channelId: CHANNEL_ID, messageId: MESSAGE_ID }, ["channelId", "messageId"]),
			guard: guardChannel("channelId"),
			async run(rawInput, call) {
				const { channelId, messageId } = rawInput as MessageInput;
				await channel(channelId);
				const message = await rest.message(channelId, messageId);
				if (!message) throw new Error(`Message ${messageId} was not found in ${channelId}.`);
				// Deleting Eryn's own message only needs visibility; deleting anyone
				// else's is a moderation action, matching the edit policy.
				const own = botUserId !== undefined && message.author?.id === botUserId;
				await requireChannelPermission(
					call.sessionID,
					channelId,
					own ? Permission.ViewChannel : Permission.ViewChannel | Permission.ManageMessages,
					own ? "delete its own message" : "delete messages",
				);
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
			guard: guardChannel("channelId"),
			async run(rawInput, call) {
				const { channelId, messageId, remove } = rawInput as MessageInput & { remove?: boolean };
				await channel(channelId);
				await requireChannelPermission(
					call.sessionID,
					channelId,
					Permission.ViewChannel | Permission.ManageMessages,
					"pin or unpin messages",
				);
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
