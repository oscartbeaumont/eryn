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
import type { Schema } from "effect";

import {
	MAX_CONTENT,
	MAX_FILE_BYTES,
	MAX_FILES,
	THREAD_TYPES,
	type DiscordAttachment,
	type DiscordChannelRef,
	type DiscordMessageView,
	type DiscordRest,
	type DiscordUpload,
} from "../../discord/api";
import type { DiscordAuthority } from "../../discord/authority";
import { isBotAuthored } from "../../discord/authorship";
import { stringField } from "../../json.ts";
import { type Mutable } from "../../mutable.ts";
import { actionButton, buttonRow, selectRow } from "../../discord/components";
import { formatMessage, type FormattedMessage } from "../../discord/markdown";
import { Permission } from "../../discord/permissions";
import { renderChannel, renderMessage } from "../../discord/render";
import { uploadNames } from "../../discord/uploads";
import { fetchAttachmentFiles, type AttachmentFile } from "../../session/attachments";
import { WORKSPACE_ROOT } from "../../session/locations";
import type { DiscordContext, PromptAttachment, ScheduleScope } from "../../session/models";
import {
	addChannelToScope,
	canEditScheduleScope,
	removeChannelFromScope,
	scopeAllows,
} from "../../session/schedule-scope";
import { base64ToBytes } from "../workspace/bytes";
import { resolvePath } from "../workspace/paths.ts";
import type { FileStore } from "../workspace/store";
import { declaredInput, objectSchema, toolExecute, ToolOutput, type ToolCall, type ToolSpec } from "../tool";
import { DISCORD_METADATA_KEY, readDiscordContext, withDiscordMetadataLock } from "./context";

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

/**
 * Lay a message out for Discord and check its text still fits.
 *
 * A wide table moves into an embed, so the text limit applies to what is left
 * in the message rather than to the Markdown the model wrote.
 */
function forDiscord(content: string): FormattedMessage {
	const formatted = formatMessage(content);

	if (formatted.content.length > MAX_CONTENT) {
		throw new Error(
			`Discord messages are limited to ${MAX_CONTENT} characters; this one is ${formatted.content.length}. Split it into smaller messages.`,
		);
	}

	return formatted;
}

/** The arguments the schemas above describe, so each tool casts once. */
type ChannelInput = { channelId: string };

type MessageInput = ChannelInput & { messageId: string };

type ThreadInput = { threadId: string };

/** A byte count as a person would read it. */
function formatBytes(bytes: number): string {
	const megabytes = bytes / (1024 * 1024);

	if (megabytes >= 1) return `${Number(megabytes.toFixed(1))} MB`;

	return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** How many pictures one read may carry, so history cannot flood the prompt. */
const MAX_READ_IMAGES = 8;

/** Discord does not always declare a content type, so fall back to the name. */
const IMAGE_NAME = /\.(?:png|jpe?g|gif|webp)$/i;

/**
 * Whether an attachment looks like an image this bot can show the model.
 *
 * The declared type wins; the filename is only consulted when Discord left it
 * out, because an extension is a weaker claim than a MIME type.
 */
function isImageAttachment(attachment: DiscordAttachment): boolean {
	if (attachment.content_type) return attachment.content_type.startsWith("image/");

	return IMAGE_NAME.test(attachment.filename ?? "");
}

/** What `discord_ask` reports once the question is posted. */
interface AskOutcome {
	readonly posted: boolean;
	readonly question: string;
	readonly options?: readonly string[];
	readonly note: string;
}

/** The pictures a read carried, and why anything was left out. */
interface ReadImages {
	files: AttachmentFile[];
	note?: string;
}

/**
 * The image attachments of read messages, as prompt files.
 *
 * `renderMessage` can only describe an attachment, and a URL is not something
 * the model can look at. These are fetched and embedded so a screenshot read
 * from history reaches the model as pixels; anything left out is reported, for
 * the same reason a live prompt reports it.
 */
async function readMessageImages(messages: readonly DiscordMessageView[]): Promise<ReadImages> {
	const images = messages.flatMap((message) =>
		(message.attachments ?? []).flatMap((attachment) => {
			const url = attachment.url ?? attachment.proxy_url;

			return url && isImageAttachment(attachment) ? [{ attachment, url }] : [];
		}),
	);

	const selected = images.slice(0, MAX_READ_IMAGES);

	const attached = await fetchAttachmentFiles(selected.map(imageRequest));

	const notes = [...attached.notes];
	const omitted = images.length - selected.length;

	if (omitted > 0) notes.push(`${omitted} more image${omitted === 1 ? "" : "s"} not attached`);

	const result: Mutable<ReadImages> = { files: attached.files };

	if (notes.length > 0) result.note = `[Images not attached: ${notes.join("; ")}]`;

	return result;
}

/** One selected image as the fetch step's request. */
function imageRequest(image: { attachment: DiscordAttachment; url: string }): PromptAttachment {
	const request: Mutable<PromptAttachment> = { url: image.url };

	if (image.attachment.filename) request.name = image.attachment.filename;

	if (image.attachment.content_type) request.contentType = image.attachment.content_type;

	if (image.attachment.size !== undefined) request.size = image.attachment.size;

	return request;
}

/**
 * Turn workspace paths into uploads.
 *
 * Only the shared workspace is eligible. That is where the agent writes, and
 * allowing any stored path would let it post a file from `/eryn` — its own
 * configuration — into a channel. The bytes come from the same store the file
 * tools use, so a document just written by `write` or `bash` is attachable.
 */
async function readUploads(store: FileStore, paths: readonly string[]): Promise<DiscordUpload[]> {
	const resolved = paths.map((path) => resolvePath(WORKSPACE_ROOT, path));
	const names = uploadNames(resolved);

	return await Promise.all(
		resolved.map((path, index) => uploadFor(store, path, paths[index], names[index])),
	);
}

/** One workspace file as an upload, or the reason it cannot be attached. */
async function uploadFor(
	store: FileStore,
	path: string,
	requested: string,
	filename: string,
): Promise<DiscordUpload> {
	if (!path.startsWith(`${WORKSPACE_ROOT}/`)) {
		throw new Error(`Eryn can only attach files from ${WORKSPACE_ROOT}; ${requested} is outside it.`);
	}

	const stored = await store.get(path);

	if (!stored) throw new Error(`Attachment ${requested} was not found in the workspace.`);
	const data = base64ToBytes(stored.b);

	if (data.byteLength > MAX_FILE_BYTES) {
		throw new Error(
			`Attachment ${requested} is ${formatBytes(data.byteLength)}; Discord accepts at most ${formatBytes(MAX_FILE_BYTES)} per file.`,
		);
	}

	return { filename, data };
}

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

/** What a permission check needs: who asks, where, which bit, and how a refusal reads. */
interface ChannelPermissionRequest {
	readonly sessionID: string;
	readonly channelId: string;
	readonly required: bigint;
	readonly label: string;
	/** Allow a turn with no speaker to act in its own conversation. */
	readonly allowWithoutAuthor?: boolean;
}

/**
 * State one host's tools share, filled in once `setup` has run.
 *
 * A tool may render a message, so it needs the bot's own id, and the notice a
 * fired watch posts is read from the session, so it needs the plugin context.
 */
interface ToolSetupState {
	botUserId?: string;
	plugin?: Plugin.Context;
}

/** Where a fired watch should announce the new thread. */
interface WatchTarget {
	readonly notifyThreadId?: string;
	readonly notifyTitle?: string;
	readonly notifyDiscord?: DiscordContext;
}

/** Everything one guild's tool set needs, from the host that builds it. */
export interface DiscordToolsInput {
	readonly rest: DiscordRest;
	readonly guildId: string;
	readonly store: FileStore;
	readonly setSubscription: (kind: "thread" | "channel", id: string, subscribed: boolean) => Promise<void>;
	readonly setMessageSubscription: SetMessageSubscription;
	readonly authority: DiscordAuthority;
	readonly onMessageSent?: (threadId: string) => void;
}

/**
 * A message that may grow a thread.
 *
 * Watching or threading a bot's own message can make the gateway prompt Eryn
 * from a thread on that message, which can loop. Webhooks are treated the same
 * way: they are not a person asking for anything.
 */
async function requireHumanMessage(
	rest: DiscordRest,
	botUserId: string | undefined,
	channelId: string,
	messageId: string,
): Promise<DiscordMessageView> {
	const message = await rest.message(channelId, messageId);

	if (!message) throw new Error(`Message ${messageId} was not found in ${channelId}.`);

	if (isBotAuthored(message, botUserId)) {
		throw new Error(
			`Message ${messageId} was written by a bot or webhook, so Eryn will not start or watch a thread from it.`,
		);
	}

	return message;
}

/** Whether `channelId` is part of the conversation this turn belongs to. */
function isCurrentConversation(context: DiscordContext, channelId: string): boolean {
	return context.thread.id === channelId || context.channel.id === channelId;
}

/** The cross-channel policy guard, used by every tool that names another channel. */
function crossChannelGuard(
	sessionContext: (sessionID: string) => Promise<DiscordContext>,
	state: ToolSetupState,
) {
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

		if (!state.plugin) throw new Error("Eryn cannot check the cross-channel policy right now.");
		await state.plugin.permission.assert({
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
		async (input: Schema.JsonObject, call: ToolCall): Promise<void> => {
			const channelId = stringField(input, key);

			if (channelId !== undefined) await crossChannel(call, channelId);
		};

	return { crossChannel, guardChannel };
}

/** The channel lookups every tool shares, all restricted to this guild. */
function channelLookups(rest: DiscordRest, guildId: string) {
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

		if (THREAD_TYPES.has(found.type)) {
			throw new Error(`${channelId} is a thread. Use discord_join_thread and discord_leave_thread for threads.`);
		}

		return found;
	};

	return { channel, thread, subscribableChannel };
}

/** The lookups and permission checks every tool shares. */
function toolHelpers(input: DiscordToolsInput, state: ToolSetupState) {
	const { rest, guildId, authority } = input;
	const { channel, thread, subscribableChannel } = channelLookups(rest, guildId);

	/**
	 * The Discord context stored on the calling session.
	 *
	 * Every authorization decision starts here: it names both the conversation
	 * the turn belongs to and the person who prompted it. A missing context
	 * cannot be authorized, so it is a refusal rather than an empty default.
	 */
	const sessionContext = async (sessionID: string): Promise<DiscordContext> => {
		if (!state.plugin) throw new Error("Eryn cannot verify Discord permissions right now.");
		const session = await state.plugin.session.get({ sessionID }).catch(() => undefined);
		const context = readDiscordContext(session?.metadata);

		if (!context) {
			throw new Error("This conversation has no Discord context, so Eryn cannot verify who is asking.");
		}

		return context;
	};

	/**
	 * Require the speaker to have Discord permissions in a channel.
	 *
	 * A scheduled or automated turn has no speaker. It may still read and send
	 * in its own conversation, because the reply has to land somewhere, but
	 * anything else is refused: there is no person whose permissions could
	 * justify it.
	 */
	const requireChannelPermission = async (request: ChannelPermissionRequest): Promise<DiscordContext> => {
		const { sessionID, channelId, required, label } = request;
		const context = await sessionContext(sessionID);

		// A schedule has a capability scope, not a person. The scope is the
		// ceiling even when the last human had more access.
		if (context.scheduleTurn && context.scheduleScope) {
			if (!scopeAllows(context.scheduleScope, channelId, required)) {
				throw new Error(
					`This schedule's Discord access does not allow Eryn to ${label} in <#${channelId}>.`,
				);
			}

			return context;
		}

		if (!context.authorId) {
			if (request.allowWithoutAuthor && isCurrentConversation(context, channelId)) return context;
			throw new Error(
				`This turn has no Discord user attached, so Eryn will not ${label} outside this conversation.`,
			);
		}

		if (!(await authority.can(context.authorId, channelId, required))) {
			throw new Error(
				`Your Discord permissions do not allow Eryn to ${label} in <#${channelId}>.`,
			);
		}

		return context;
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
		const ctx = state.plugin;

		if (!ctx) return;
		await withDiscordMetadataLock(sessionID, async () => {
			const session = await ctx.session.get({ sessionID }).catch(() => undefined);
			const context = readDiscordContext(session?.metadata);

			if (!session || !context?.scheduleScope) return;
			const next = update(context.scheduleScope, context);

			if (next === context.scheduleScope) return;
			// SAFETY: OpenCode spells metadata JSON with mutable arrays, while a
			// decoded `DiscordContext` holds readonly ones; it is the same JSON.
			await ctx.session.update({
				sessionID,
				metadata: {
					...session.metadata,
					// Merge, do not replace: the Discord context and other plugins'
					// metadata share this session record.
					[DISCORD_METADATA_KEY]: next
						? { ...context, scheduleScope: next }
						: { ...context, scheduleScope: undefined },
				} as never,
			});
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

	const { guardChannel } = crossChannelGuard(sessionContext, state);

	/** The conversation a watch should notify, from the calling session's metadata. */
	const notifyTarget = async (sessionID: string): Promise<WatchTarget> => {
		const session = state.plugin
			? await state.plugin.session.get({ sessionID }).catch(() => undefined)
			: undefined;

		const discord = readDiscordContext(session?.metadata);

		if (!discord) return {};

		const target: Mutable<WatchTarget> = {
			notifyThreadId: discord.thread.id,
			notifyDiscord: discord,
		};

		if (discord.thread.name) target.notifyTitle = discord.thread.name;

		return target;
	};

	return {
		channel,
		thread,
		subscribableChannel,
		sessionContext,
		requireChannelPermission,
		requireManageGuild,
		canEditScope,
		updateScheduleScope,
		expandScheduleScope,
		contractScheduleScope,
		guardChannel,
		notifyTarget,
		inheritThreadScope,
	};
}

export function discordTools(input: DiscordToolsInput) {
	const { rest, guildId, store, authority, setSubscription, setMessageSubscription, onMessageSent } = input;
	const state: ToolSetupState = {};

	const {
		channel,
		thread,
		subscribableChannel,
		sessionContext,
		requireChannelPermission,
		requireManageGuild,
		expandScheduleScope,
		contractScheduleScope,
		guardChannel,
		notifyTarget,
		inheritThreadScope,
	} = toolHelpers(input, state);

	/** Tools that only read from the server or the conversation. */
	const inspectTools = (): ToolSpec[] => [
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

					return [...channels, ...threads].flatMap((entry) =>
						allowed.has(entry.id) ? [channelSummary(entry)] : [],
					);
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
				"Read recent messages from a channel or thread in this server. Messages are returned newest first with author and attachment details. Image attachments are included as pictures you can see.",
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
				const { channelId, limit, before } = declaredInput<ChannelInput & { limit?: number; before?: string }>(rawInput);
				const channelInfo = await channel(channelId);
				await requireChannelPermission({
					sessionID: call.sessionID,
					channelId,
					required: Permission.ViewChannel | Permission.ReadMessageHistory,
					label: "read messages",
					allowWithoutAuthor: true,
				});

				const query: Mutable<NonNullable<Parameters<DiscordRest["channelMessages"]>[1]>> = {
					limit: Math.min(Math.max(Math.trunc(limit ?? 20), 1), 50),
				};

				if (before) query.before = before;

				const messages = await rest.channelMessages(channelId, query);

				const text = [
					renderChannel(channelInfo),
					...messages.map((message) => renderMessage(message, state.botUserId)),
				].join("\n\n");

				const images = await readMessageImages(messages);

				return new ToolOutput(
					images.note ? `${text}\n\n${images.note}` : text,
					images.files,
				);
			},
		},
	];

	/** Tools that speak in the conversation or ask it a question. */
	const conversationTools = (): ToolSpec[] => [

		{
			name: "discord_send_message",
			description:
				"Send a message to a channel or thread in this server. This is how you reply: your own output is not posted to Discord. Pass the thread id from the message's <thread> element, or the channel id from its <channel> element, as channelId. Mentions are suppressed; replyTo attaches the message as a reply. Add workspace files with `files` to upload them as attachments, which is how to share something too long to paste: write it with the write tool first.",
			input: objectSchema(
				{
					channelId: CHANNEL_ID,
					content: {
						type: "string",
						description:
							"Message text, up to 2000 characters; optional when files are attached. Markdown tables are laid out for Discord.",
					},
					replyTo: { type: "string", description: "Optional message id to reply to" },
					files: {
						type: "array",
						items: { type: "string" },
						description: `Workspace paths to attach, such as /workspace/report.md or report.md (up to ${MAX_FILES} files, ${formatBytes(MAX_FILE_BYTES)} each)`,
					},
				},
				["channelId"],
			),
			guard: guardChannel("channelId"),
			async run(rawInput, call) {
				const { channelId, content, replyTo, files: rawFiles } = declaredInput<ChannelInput & {
					content?: string;
					replyTo?: string;
					files?: string[];
				}>(rawInput);

				const found = await channel(channelId);

				const context = await requireChannelPermission({
					sessionID: call.sessionID,
					channelId,
					required:
						Permission.ViewChannel |
						(THREAD_TYPES.has(found.type)
							? Permission.SendMessagesInThreads
							: Permission.SendMessages),
					label: "send messages",
					allowWithoutAuthor: true,
				});

				const files = [...new Set((rawFiles ?? []).map((file) => file.trim()).filter(Boolean))];

				if (files.length > MAX_FILES) {
					throw new Error(`A message can carry at most ${MAX_FILES} files; this one has ${files.length}.`);
				}

				const text = content ?? "";

				if (!text.trim() && files.length === 0) throw new Error("Message content or a file is required.");
				const formatted = forDiscord(text);
				const uploads = await readUploads(store, files);

				const options: Mutable<NonNullable<Parameters<DiscordRest["sendMessage"]>[2]>> = {};

				if (replyTo) options.replyTo = replyTo;

				if (formatted.embeds.length > 0) options.embeds = formatted.embeds;

				if (uploads.length > 0) options.files = uploads;

				const sent = await rest.sendMessage(channelId, formatted.content, options);

				// A successful send is the usage signal: the turn either replied
				// in its conversation or it did not. Content is not involved, and
				// the id is the conversation's even when the reply went elsewhere.
				onMessageSent?.(context.thread.id);

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
				const { question, options: rawOptions, multiple } = declaredInput<{
					question: string;
					options?: string[];
					multiple?: boolean;
				}>(rawInput);

				const context = await sessionContext(call.sessionID);

				if (context.scheduleTurn) {
					throw new Error("A scheduled turn has no one to answer a question.");
				}

				const authorId = context.authorId;

				if (!authorId) throw new Error("This turn has no Discord user to answer.");
				const asked = formatMessage(question.trim()).content.slice(0, 2_000);

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

				const outcome: Mutable<AskOutcome> = {
					posted: true,
					question: asked,
					note: "The question is now in the conversation. End your turn; the answer will arrive as a new message.",
				};

				if (options.length) outcome.options = options;

				return outcome;
			},
		},
	];

	/** Tools that create, watch, archive, and join threads. */
	const threadTools = (): ToolSpec[] => [

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
				const { channelId, name: rawName, messageId } = declaredInput<ChannelInput & { name: string; messageId?: string }>(rawInput);
				await channel(channelId);
				await requireChannelPermission({
					sessionID: call.sessionID,
					channelId,
					required: Permission.ViewChannel | Permission.CreatePublicThreads,
					label: "create a thread",
				});
				const name = rawName.trim().slice(0, 100);

				if (!name) throw new Error("A thread name is required.");

				// Threading a bot's message is another way to make a bot-authored
				// thread, so refuse it here as well as in the message watch.
				if (messageId) await requireHumanMessage(rest, state.botUserId, channelId, messageId);

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
				const { channelId, messageId } = declaredInput<MessageInput>(rawInput);

				if (THREAD_TYPES.has((await channel(channelId)).type)) {
					throw new Error(`A thread cannot be created from a message inside ${channelId}.`);
				}

				await requireChannelPermission({
					sessionID: call.sessionID,
					channelId,
					required: Permission.ViewChannel | Permission.ReadMessageHistory,
					label: "watch that message",
				});
				await requireHumanMessage(rest, state.botUserId, channelId, messageId);
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
				const { channelId, messageId } = declaredInput<MessageInput>(rawInput);
				await channel(channelId);
				await requireChannelPermission({
					sessionID: call.sessionID,
					channelId,
					required: Permission.ViewChannel | Permission.ReadMessageHistory,
					label: "stop watching that message",
				});
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
				const { threadId, locked } = declaredInput<ThreadInput & { locked?: boolean }>(rawInput);
				await thread(threadId);
				await requireChannelPermission({
					sessionID: call.sessionID,
					channelId: threadId,
					required: Permission.ManageThreads,
					label: "archive that thread",
				});
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
				const { threadId } = declaredInput<ThreadInput>(rawInput);
				await thread(threadId);
				// A private thread additionally requires membership (or manager
				// rights); the resolver enforces that as part of ViewChannel.
				await requireChannelPermission({
					sessionID: call.sessionID,
					channelId: threadId,
					required: Permission.ViewChannel,
					label: "join that thread",
				});
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
				const { threadId } = declaredInput<ThreadInput>(rawInput);
				await thread(threadId);
				await requireChannelPermission({
					sessionID: call.sessionID,
					channelId: threadId,
					required: Permission.ViewChannel,
					label: "leave that thread",
				});
				await rest.leaveThread(threadId);
				await setSubscription("thread", threadId, false);

				return { ok: true, threadId, subscribed: false };
			},
		},
	];

	/** Tools that subscribe the bot to a whole channel. */
	const channelTools = (): ToolSpec[] => [

		{
			name: "discord_join_channel",
			description:
				"Subscribe Eryn to a channel. New messages in the channel will start a turn without needing a mention, and replies are posted in the channel. Use this for channels, not threads.",
			input: objectSchema({ channelId: CHANNEL_ID }, ["channelId"]),
			guard: guardChannel("channelId"),
			async run(rawInput, call) {
				const { channelId } = declaredInput<ChannelInput>(rawInput);
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
				const { channelId } = declaredInput<ChannelInput>(rawInput);
				await subscribableChannel(channelId);
				await requireManageGuild(call.sessionID, "unsubscribe Eryn from a channel");
				await setSubscription("channel", channelId, false);
				await contractScheduleScope(call.sessionID, channelId);

				return { ok: true, channelId, subscribed: false };
			},
		},
	];

	/** Tools that act on an existing message. */
	const messageTools = (): ToolSpec[] => [

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
				const { channelId, messageId, emoji, remove } = declaredInput<MessageInput & { emoji: string; remove?: boolean }>(rawInput);
				await channel(channelId);
				await requireChannelPermission({
					sessionID: call.sessionID,
					channelId,
					required: Permission.ViewChannel | Permission.AddReactions,
					label: "react to messages",
				});

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
				const { channelId, messageId, content } = declaredInput<MessageInput & { content: string }>(rawInput);
				await channel(channelId);
				const message = await rest.message(channelId, messageId);

				if (!message) throw new Error(`Message ${messageId} was not found in ${channelId}.`);
				// Editing Eryn's own message only needs visibility; editing anyone
				// else's is a moderation action.
				const own = state.botUserId !== undefined && message.author?.id === state.botUserId;
				await requireChannelPermission({
					sessionID: call.sessionID,
					channelId,
					required: own ? Permission.ViewChannel : Permission.ViewChannel | Permission.ManageMessages,
					label: own ? "edit its own message" : "edit messages",
				});
				const formatted = forDiscord(content);
				await rest.editMessage(
					channelId,
					messageId,
					formatted.content,
					// Editing Eryn's own message replaces its layout, including
					// removing an embed when the table is gone. Another author's
					// embeds are left alone.
					own ? { embeds: formatted.embeds } : {},
				);

				return { ok: true };
			},
		},

		{
			name: "discord_delete_message",
			description: "Delete a message the bot is allowed to delete.",
			input: objectSchema({ channelId: CHANNEL_ID, messageId: MESSAGE_ID }, ["channelId", "messageId"]),
			guard: guardChannel("channelId"),
			async run(rawInput, call) {
				const { channelId, messageId } = declaredInput<MessageInput>(rawInput);
				await channel(channelId);
				const message = await rest.message(channelId, messageId);

				if (!message) throw new Error(`Message ${messageId} was not found in ${channelId}.`);
				// Deleting Eryn's own message only needs visibility; deleting anyone
				// else's is a moderation action, matching the edit policy.
				const own = state.botUserId !== undefined && message.author?.id === state.botUserId;
				await requireChannelPermission({
					sessionID: call.sessionID,
					channelId,
					required: own ? Permission.ViewChannel : Permission.ViewChannel | Permission.ManageMessages,
					label: own ? "delete its own message" : "delete messages",
				});
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
				const { channelId, messageId, remove } = declaredInput<MessageInput & { remove?: boolean }>(rawInput);
				await channel(channelId);
				await requireChannelPermission({
					sessionID: call.sessionID,
					channelId,
					required: Permission.ViewChannel | Permission.ManageMessages,
					label: "pin or unpin messages",
				});

				if (remove) await rest.unpinMessage(channelId, messageId);
				else await rest.pinMessage(channelId, messageId);

				return { ok: true };
			},
		},
	];

	/** Every tool this plugin registers, grouped by what it acts on. */
	const tools: ToolSpec[] = [
		...inspectTools(),
		...conversationTools(),
		...threadTools(),
		...channelTools(),
		...messageTools(),
	];

	return {
		/** Register the tools on the plugin context, after resolving the bot's id. */
		async setup(ctx: Plugin.Context): Promise<void> {
			state.plugin = ctx;
			state.botUserId = await rest.me().then((me) => me.id).catch(() => undefined);
			await ctx.tool.transform((editor) => {
				tools.forEach((spec) => {
					editor.add({
						name: spec.name,
						description: spec.description,
						input: spec.input,
						// SAFETY: the editor validates a call against `spec.input` before it
						// reaches `execute`, so the object matches the declared schema.
						execute: (input, context) => toolExecute(spec, ctx)(input as Schema.JsonObject, context),
					});
				});
			});
		},
	};
}
