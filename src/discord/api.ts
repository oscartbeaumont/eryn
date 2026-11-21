/**
 * The deterministic Discord REST surface used by Eryn's bot.
 *
 * This module owns channel configuration, sending and editing messages,
 * starting threads, typing indicators, interaction replies, command
 * registration, and the install audit lookup. It never logs the
 * bot token or a Discord response body, which can contain user messages.
 *
 * The client is created once by the object that owns the token and passed to
 * every subsystem that needs it.
 */

import { Cause, Duration, Effect, Option, Schedule, Schema } from "effect";

import { booleanField, isJsonObject, jsonBody, jsonField, numberField, stringField } from "../json.ts";
import type { Mutable } from '../mutable.ts';
import type { DiscordComponent, DiscordModal } from "./components";

const API = "https://discord.com/api/v10";

/** Discord channel types that are already threads. */
export const THREAD_TYPES = new Set([10, 11, 12]);

/** Discord rejects message content longer than this. */
export const MAX_CONTENT = 2_000;

/** The most files one message may carry. */
export const MAX_FILES = 10;

/** The largest file a guild without boosts can upload, in bytes. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Fallback thread name when a request is empty. */
export const DEFAULT_THREAD_NAME = "eryn";

/** Discord's audit-log action type for `BOT_ADD`. */
export const AUDIT_BOT_ADD = 28;

/** One guild the bot is in, as Discord lists it for a bot user. */
export interface DiscordGuildSummary {
	id: string;
	name: string;
	/** The bot's own permissions in that guild, as a decimal bitmask string. */
	permissions?: string;
}

export interface DiscordUser {
	id: string;
	username?: string;
	/** The user's display name, when they have one. Preferred over the handle. */
	global_name?: string;
	bot?: boolean;
}

/**
 * One channel permission overwrite.
 *
 * `allow` and `deny` are decimal permission bitmasks encoded as strings, which
 * is how Discord sends them. They are kept raw rather than parsed here so the
 * pure resolver can decide what a malformed value means.
 */
export interface PermissionOverwrite {
	id: string;
	type: number;
	allow: string;
	deny: string;
}

export interface DiscordChannelRef {
	id: string;
	type: number;
	guild_id?: string;
	parent_id?: string;
	name?: string;
	topic?: string;
	position?: number;
	permission_overwrites?: readonly PermissionOverwrite[];
	thread_metadata?: { archived?: boolean; auto_archive_duration?: number };
}

/** A file attached to a message, shared by the REST and gateway shapes. */
export interface DiscordAttachment {
	id?: string;
	filename?: string;
	content_type?: string;
	size?: number;
	url?: string;
	proxy_url?: string;
}

/** One field of a rich embed. */
export interface DiscordEmbedField {
	name: string;
	value: string;
	inline?: boolean;
}

/** The subset of a rich embed Eryn builds, used to lay out a wide table. */
export interface DiscordEmbed {
	title?: string;
	description?: string;
	color?: number;
	fields?: readonly DiscordEmbedField[];
}

/** One file to upload with a message. */
export interface DiscordUpload {
	filename: string;
	/** The file's bytes, which are sent as a multipart part rather than base64. */
	data: Uint8Array;
}

/** A message as a tool needs to see it. */
export interface DiscordMessageView {
	id: string;
	channel_id: string;
	content?: string;
	timestamp?: string;
	edited_timestamp?: string | null;
	author?: DiscordUser;
	/** Present when a webhook posted the message, even though `author.bot` may be unset. */
	webhook_id?: string;
	mentions?: DiscordUser[];
	attachments?: DiscordAttachment[];
	referenced_message?: { id?: string } | null;
	/** The action rows still attached to the message, when it has any. */
	components?: readonly DiscordComponent[];
}

/** The subset of a role this bot reads. Managed bot roles carry `tags.bot_id`. */
export interface DiscordRole {
	id: string;
	name: string;
	managed: boolean;
	/** A decimal permission bitmask, as Discord sends it. */
	permissions?: string;
	/** The role's place in the hierarchy; higher roles override lower ones. */
	position?: number;
	tags?: { bot_id?: string };
}

/** One entry of a guild's audit log, as far as the bot reads it. */
export interface DiscordAuditEntry {
	/** A snowflake, whose timestamp is the entry's creation time. */
	id: string;
	action_type: number;
	user_id?: string;
	target_id?: string;
}

/** An error raised by a non-retryable Discord response. */
export class DiscordError extends Error {
	readonly status: number | undefined;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "DiscordError";
		this.status = status;
	}
}

const DiscordAuditEntrySchema = Schema.Struct({
	id: Schema.String,
	action_type: Schema.Finite,
	user_id: Schema.optional(Schema.String),
	target_id: Schema.optional(Schema.String),
});

const AuditLogSchema = Schema.Struct({
	audit_log_entries: Schema.optional(Schema.Array(DiscordAuditEntrySchema)),
});

/** Seconds Discord asked us to wait, from a 429 body. Defaults to one second. */
function retryDelay(body: Schema.Json | undefined): number {
	const value = numberField(body, "retry_after");

	if (value !== undefined && Number.isFinite(value) && value > 0) return Math.min(value, 60) * 1_000 + 250;

	return 1_000;
}

/** How many times a rate-limited request is retried before its 429 is reported. */
const MAX_RATE_LIMIT_RETRIES = 3;

/** One attempt at a request: the response, and what a 429 asked us to wait. */
interface Attempt {
	readonly response: Response;
	readonly retryAfter?: number;
}

/**
 * Repeat while Discord is rate limiting us, waiting what its 429 asked for.
 *
 * A response that is not a 429 ends the loop, and `upTo` caps how many retries
 * follow.
 */
const retryRateLimits = Schedule.fromStep(
	Effect.succeed((_now: number, attempt: Attempt) => {
		if (attempt.response.status !== 429) return Cause.done(attempt);

		return Effect.succeed([
			attempt,
			Duration.millis(attempt.retryAfter ?? 1_000),
		] satisfies [Attempt, Duration.Duration]);
	}),
).pipe(Schedule.upTo({ times: MAX_RATE_LIMIT_RETRIES }));

/** A slash-command registration entry. `options` makes it a command group. */
export interface DiscordCommandOption {
	name: string;
	description: string;
	type: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 10 | 11;
	required?: boolean;
	options?: readonly DiscordCommandOption[];
}

export interface DiscordCommand {
	name: string;
	description: string;
	type: 1;
	options?: readonly DiscordCommandOption[];
}

/** A command as Discord stores it, which is what the bot compares against. */
export interface DiscordRegisteredCommand extends DiscordCommand {
	id: string;
	version?: string;
}

/** The callback body that posts or updates the message an interaction shows. */
interface InteractionMessageBody {
	readonly type: 4 | 7;
	readonly data: {
		readonly content: string;
		readonly allowed_mentions: { readonly parse: readonly string[] };
		readonly flags?: number;
		readonly components?: readonly DiscordComponent[];
	};
}

/** How to acknowledge an interaction that produced a message. */
export interface InteractionMessageOptions {
	ephemeral?: boolean;
	components?: readonly DiscordComponent[];
}

function permissionOverwrites(value: Schema.Json | undefined): readonly PermissionOverwrite[] | undefined {
	if (!Array.isArray(value)) return undefined;

	return value.flatMap((entry: Schema.Json): PermissionOverwrite[] => {
		const id = stringField(entry, "id");
		const type = numberField(entry, "type");

		if (id === undefined || type === undefined) return [];

		return [
			{
				id,
				type,
				allow: stringField(entry, "allow") ?? "0",
				deny: stringField(entry, "deny") ?? "0",
			},
		];
	});
}

function channelRef(value: Schema.Json | undefined): DiscordChannelRef | undefined {
	const id = stringField(value, "id");
	const type = numberField(value, "type");

	if (id === undefined || type === undefined) return undefined;
	const overwrites = permissionOverwrites(jsonField(value, "permission_overwrites"));
	const guildId = stringField(value, "guild_id");
	const parentId = stringField(value, "parent_id");
	const name = stringField(value, "name");
	const topic = stringField(value, "topic");
	const position = numberField(value, "position");
	const threadMetadata = threadMetadataOf(jsonField(value, "thread_metadata"));

	const channel: DiscordChannelRef = { id, type };

	if (guildId !== undefined) channel.guild_id = guildId;

	if (parentId !== undefined) channel.parent_id = parentId;

	if (name !== undefined) channel.name = name;

	if (topic !== undefined) channel.topic = topic;

	if (position !== undefined) channel.position = position;

	if (overwrites) channel.permission_overwrites = overwrites;

	if (threadMetadata) channel.thread_metadata = threadMetadata;

	return channel;
}

/** The archive settings Discord reports for a thread channel. */
function threadMetadataOf(value: Schema.Json | undefined): DiscordChannelRef["thread_metadata"] {
	if (!isJsonObject(value)) return undefined;
	const metadata: NonNullable<DiscordChannelRef["thread_metadata"]> = {};
	const archived = booleanField(value, "archived");
	const autoArchiveDuration = numberField(value, "auto_archive_duration");

	if (archived !== undefined) metadata.archived = archived;

	if (autoArchiveDuration !== undefined) metadata.auto_archive_duration = autoArchiveDuration;

	return metadata;
}

/** Decode a list of channels, dropping entries that are not one. */
function channelRefs(value: Schema.Json | undefined): DiscordChannelRef[] {
	if (!Array.isArray(value)) return [];

	return value.flatMap((entry: Schema.Json) => channelRef(entry) ?? []);
}

/** The path of one message, which most message operations extend. */
function messagePath(channelId: string, messageId: string): string {
	return `/channels/${channelId}/messages/${messageId}`;
}

/** The id a create-style response must carry. */
function idOf(result: Schema.Json | undefined, failure: string): string {
	const id = stringField(result, "id");

	if (id === undefined) throw new DiscordError(failure);

	return id;
}

/** The JSON body of a message create or edit. */
interface MessageBody {
	content: string;
	allowed_mentions: { readonly parse: readonly string[]; readonly users?: readonly string[] };
	message_reference?: { readonly message_id: string; readonly fail_if_not_exists: boolean };
	components?: readonly DiscordComponent[];
	embeds?: readonly DiscordEmbed[];
	attachments?: readonly { readonly id: string; readonly filename: string }[];
}

/**
 * A minimal Discord REST client. Responses are never echoed back in errors and
 * rate limits are retried a few times.
 */
export function discordRest(token: string) {
	async function request<T>(
		method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
		path: string,
		body?: Schema.Json | FormData,
	): Promise<T | undefined> {
		const headers = new Headers({ Authorization: `Bot ${token}` });
		// A multipart request must set its own boundary, so its Content-Type is
		// left to fetch rather than overwritten with JSON.
		const multipart = body instanceof FormData;

		if (body !== undefined && !multipart) headers.set("Content-Type", "application/json");
		const encoded = multipart || body === undefined ? body : JSON.stringify(body);

		const fetchOnce = Effect.promise(async (): Promise<Attempt> => {
			const init: RequestInit = { method, headers };

			// SAFETY: the body is either already a `FormData` (a valid `BodyInit`) or
			// the string `JSON.stringify` produced from a JSON value.
			const encodedBody = encoded as BodyInit | undefined;

			if (encodedBody !== undefined) init.body = encodedBody;

			const response = await fetch(`${API}${path}`, init);

			// The 429 body is JSON by contract; decode it before reading `retry_after`.
			const rateLimitBody =
				response.status === 429
					? Option.getOrUndefined(
							Schema.decodeUnknownOption(Schema.Json)(await response.json().catch(() => undefined)),
						)
					: undefined;

			const retryAfter = rateLimitBody === undefined ? undefined : retryDelay(rateLimitBody);
			const attempt: Mutable<Attempt> = { response };

			if (retryAfter !== undefined) attempt.retryAfter = retryAfter;

			return attempt;
		});

		const { response } = await Effect.runPromise(Effect.repeat(fetchOnce, retryRateLimits));

		if (response.status === 404 && method === "GET") return undefined;

		if (response.status === 204) return undefined;

		if (!response.ok) {
			throw new DiscordError(`Discord returned HTTP ${response.status} for ${method} ${path}`, response.status);
		}

		// SAFETY: the caller's `T` describes the response body it asked Discord for;
		// the decoders at each call site turn the JSON into the domain type.
		return (await response.json()) as T;
	}

	/** POST a body and return the id of the resource Discord created. */
	async function create(path: string, body: Schema.Json | FormData, failure: string): Promise<{ id: string }> {
		return { id: idOf(await request<Schema.Json>("POST", path, body), failure) };
	}

	async function interactionCallback(interactionId: string, interactionToken: string, payload: Schema.Json): Promise<void> {
		await request<void>("POST", `/interactions/${interactionId}/${interactionToken}/callback`, payload);
	}

	const http: DiscordTransport = { request, create, interactionCallback };

	return {
		...readMethods(http),
		...messageMethods(http),
		...guildMethods(http),
		...interactionMethods(http),
		...applicationMethods(http),
	};
}

/** The low-level transport every Discord method is written over. */
interface DiscordTransport {
	request<T>(method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: Schema.Json | FormData): Promise<T | undefined>;
	create(path: string, body: Schema.Json | FormData, failure: string): Promise<{ id: string }>;
	interactionCallback(interactionId: string, interactionToken: string, payload: Schema.Json): Promise<void>;
}

/** Methods that read users, channels, and messages. */
function readMethods(http: DiscordTransport) {
	return {
				/** The bot's own user, which also serves as the application id. */
		async me(): Promise<DiscordUser> {
			const result = await http.request<Schema.Json>("GET", "/users/@me");
			const username = stringField(result, "username");
			const user: DiscordUser = { id: idOf(result, "Discord did not return a bot user") };

			if (username !== undefined) user.username = username;

			return user;
		},

		/** A channel or thread, or undefined when the id does not exist. */
		async channel(channelId: string): Promise<DiscordChannelRef | undefined> {
			return channelRef(await http.request<Schema.Json>("GET", `/channels/${channelId}`));
		},

		/** Every channel the bot can see in a guild, excluding threads. */
		async guildChannels(guildId: string): Promise<DiscordChannelRef[]> {
			return channelRefs(await http.request<Schema.Json>("GET", `/guilds/${guildId}/channels`));
		},

		/** Active threads in a guild, which Discord lists separately from channels. */
		async activeThreads(guildId: string): Promise<DiscordChannelRef[]> {
			const result = await http.request<Schema.Json>("GET", `/guilds/${guildId}/threads/active`);

			return channelRefs(jsonField(result, "threads"));
		},

		/** One message in a channel or thread, or undefined when it does not exist. */
		async message(channelId: string, messageId: string): Promise<DiscordMessageView | undefined> {
			return await http.request<DiscordMessageView>("GET", messagePath(channelId, messageId));
		},

		/** Recent messages in a channel or thread, newest first. */
		async channelMessages(
			channelId: string,
			options: { limit?: number; before?: string } = {},
		): Promise<DiscordMessageView[]> {
			const query = new URLSearchParams({ limit: String(Math.min(Math.max(options.limit ?? 20, 1), 100)) });

			if (options.before) query.set("before", options.before);
			const result = await http.request<DiscordMessageView[]>("GET", `/channels/${channelId}/messages?${query}`);

			return Array.isArray(result) ? result : [];
		},
	};
}

/** Methods that write to a channel or a message. */
function messageMethods(http: DiscordTransport) {
	return {
		async sendMessage(
			channelId: string,
			content: string,
			options: {
				users?: readonly string[];
				replyTo?: string;
				components?: readonly DiscordComponent[];
				embeds?: readonly DiscordEmbed[];
				files?: readonly DiscordUpload[];
			} = {},
		): Promise<{ id: string }> {
			const body: MessageBody = {
				content,
				// Suppress every ping unless a caller names the users to notify.
				allowed_mentions: { parse: [], users: options.users ?? [] },
			};

			if (options.replyTo) body.message_reference = { message_id: options.replyTo, fail_if_not_exists: false };

			if (options.components?.length) body.components = options.components;

			if (options.embeds?.length) body.embeds = options.embeds;
			const path = `/channels/${channelId}/messages`;

			const files = options.files ?? [];

			if (files.length === 0) {
				return await http.create(path, jsonBody(body), "Discord did not accept the message");
			}

			// Files are uploaded as multipart/form-data: the message itself goes in
			// `payload_json` and each file in `files[n]`. The `attachments` entries
			// are what tie part n to the filename Discord should show.
			body.attachments = files.map((file, index) => ({ id: String(index), filename: file.filename }));
			const form = new FormData();
			form.append("payload_json", JSON.stringify(body));
			files.forEach((file, index) => {
				form.append(`files[${index}]`, new Blob([file.data]), file.filename);
			});

			return await http.create(path, form, "Discord did not accept the message");
		},

		/** Add a user to a thread so they follow it. This does not notify them. */
		async addThreadMember(channelId: string, userId: string): Promise<void> {
			await http.request<void>("PUT", `/channels/${channelId}/thread-members/${userId}`);
		},

		async editMessage(
			channelId: string,
			messageId: string,
			content: string,
			options: { components?: readonly DiscordComponent[]; embeds?: readonly DiscordEmbed[] } = {},
		): Promise<void> {
			const body: MessageBody = { content, allowed_mentions: { parse: [] } };

			if (options.components) body.components = options.components;

			if (options.embeds !== undefined) body.embeds = options.embeds;

			await http.request<void>("PATCH", messagePath(channelId, messageId), jsonBody(body));
		},

		async createThread(channelId: string, messageId: string, name: string): Promise<{ id: string }> {
			const path = `${messagePath(channelId, messageId)}/threads`;

			return await http.create(path, jsonBody({ name, auto_archive_duration: 1_440 }), "Discord did not create the thread");
		},

		/** Start a public thread in a channel, not attached to a message. */
		async startThread(channelId: string, name: string): Promise<{ id: string }> {
			return await http.create(
				`/channels/${channelId}/threads`,
				jsonBody({ name, auto_archive_duration: 1_440 }),
				"Discord did not create the thread",
			);
		},

		/** Archive or unarchive a thread. */
		async setThreadArchived(threadId: string, archived: boolean, locked = false): Promise<void> {
			await http.request<void>("PATCH", `/channels/${threadId}`, jsonBody({ archived, locked }));
		},

		/** Follow a thread, so its messages stay available to the bot. */
		async joinThread(threadId: string): Promise<void> {
			await http.request<void>("PUT", `/channels/${threadId}/thread-members/@me`);
		},

		/** Stop following a thread. */
		async leaveThread(threadId: string): Promise<void> {
			await http.request<void>("DELETE", `/channels/${threadId}/thread-members/@me`);
		},

		async deleteMessage(channelId: string, messageId: string): Promise<void> {
			await http.request<void>("DELETE", messagePath(channelId, messageId));
		},

		async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
			await http.request<void>("PUT", `${messagePath(channelId, messageId)}/reactions/${encodeURIComponent(emoji)}/@me`);
		},

		async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
			await http.request<void>("DELETE", `${messagePath(channelId, messageId)}/reactions/${encodeURIComponent(emoji)}/@me`);
		},

		async pinMessage(channelId: string, messageId: string): Promise<void> {
			await http.request<void>("PUT", `/channels/${channelId}/pins/${messageId}`);
		},

		async unpinMessage(channelId: string, messageId: string): Promise<void> {
			await http.request<void>("DELETE", `/channels/${channelId}/pins/${messageId}`);
		},

		async triggerTyping(channelId: string): Promise<void> {
			await http.request<void>("POST", `/channels/${channelId}/typing`);
		},
	};
}

/** Methods that read a guild's roles, members, and audit log. */
function guildMethods(http: DiscordTransport) {
	return {
		/** The guild's roles, used to find the bot's managed role. */
		async guildRoles(guildId: string): Promise<DiscordRole[]> {
			const result = await http.request<DiscordRole[]>("GET", `/guilds/${guildId}/roles`);

			return Array.isArray(result) ? result : [];
		},

		/**
		 * One guild member's role ids, or undefined when they are not a member.
		 *
		 * Permissions are computed from these ids; a member who has left has no
		 * permissions to lend to a tool call.
		 */
		async guildMember(guildId: string, userId: string): Promise<{ roles: string[] } | undefined> {
			const result = await http.request<Schema.Json>("GET", `/guilds/${guildId}/members/${userId}`);
			const roles = jsonField(result, "roles");

			if (result === undefined || !Array.isArray(roles)) return undefined;

			return { roles: roles.filter((role): role is string => typeof role === "string") };
		},

		/** A guild's owner, which the permission resolver needs to grant everything. */
		async guildInfo(guildId: string): Promise<{ ownerId?: string } | undefined> {
			const result = await http.request<Schema.Json>("GET", `/guilds/${guildId}`);

			if (result === undefined) return undefined;
			const ownerId = stringField(result, "owner_id");

			return ownerId === undefined ? {} : { ownerId };
		},

		/**
		 * Whether a user is a member of a thread.
		 *
		 * A private thread is only readable by its members (or managers), so this
		 * is part of resolving the speaker's permissions there. Discord answering
		 * 404 is a definite "not a member". `undefined` means the question could
		 * not be answered right now: callers must deny the attempt but must not
		 * remember it, because a transient REST failure is not evidence that
		 * someone lost thread membership.
		 */
		async isThreadMember(threadId: string, userId: string): Promise<boolean | undefined> {
			try {
				const result = await http.request<Schema.Json>("GET", `/channels/${threadId}/thread-members/${userId}`);

				return result !== undefined;
			} catch {
				return undefined;
			}
		},

		/** The guilds the bot is a member of, with its own permissions in each. */
		async guilds(): Promise<DiscordGuildSummary[]> {
			const result = await http.request<Schema.Json>("GET", "/users/@me/guilds");

			if (!Array.isArray(result)) return [];

			return result.flatMap((guild: Schema.Json): DiscordGuildSummary[] => {
				const id = stringField(guild, "id");
				const name = stringField(guild, "name");

				if (id === undefined || name === undefined) return [];
				const permissions = stringField(guild, "permissions");
				const summary: DiscordGuildSummary = { id, name };

				if (permissions !== undefined) summary.permissions = permissions;

				return [summary];
			});
		},

		/**
		 * The most recent `BOT_ADD` audit entry for a guild, which is how the bot
		 * learns *who* installed it. `target_id` is the bot user id.
		 */
		async botAddEntry(guildId: string): Promise<DiscordAuditEntry | undefined> {
			const result = await http.request<Schema.Json>(
				"GET",
				`/guilds/${guildId}/audit-logs?action_type=${AUDIT_BOT_ADD}&limit=1`,
			);

			return Option.getOrUndefined(Schema.decodeUnknownOption(AuditLogSchema)(result))?.audit_log_entries?.[0];
		},
	};
}

/** Methods that answer or edit an interaction. */
function interactionMethods(http: DiscordTransport) {
	return {
		/** Acknowledge an interaction with a message (ephemeral by default). */
		async interactionReply(
			interactionId: string,
			interactionToken: string,
			content: string,
			options: InteractionMessageOptions = {},
		): Promise<void> {
			const data: Mutable<InteractionMessageBody["data"]> = {
				content,
				// Error strings and MCP text are untrusted: never let a mention
				// token in them ping a user, role, or another bot.
				allowed_mentions: { parse: [] },
				flags: options.ephemeral === false ? 0 : 64,
			};

			if (options.components?.length) data.components = options.components;

			await http.interactionCallback(interactionId, interactionToken, jsonBody({ type: 4, data }));
		},

		/** Acknowledge an interaction without content, so slow work can finish later. */
		async interactionDefer(interactionId: string, interactionToken: string, ephemeral = true): Promise<void> {
			await http.interactionCallback(
				interactionId,
				interactionToken,
				jsonBody({ type: 5, data: { flags: ephemeral ? 64 : 0 } }),
			);
		},

		/**
		 * Edit the message a deferred (or already acknowledged) interaction shows.
		 *
		 * `components` is sent whenever the caller names it, including as an empty
		 * array: Discord keeps the message's existing components when the field is
		 * missing, so leaving it out would leave a finished flow's buttons on
		 * screen. Only `undefined` means "leave them alone".
		 */
		async interactionEditOriginal(
			applicationId: string,
			interactionToken: string,
			content: string,
			options: { components?: readonly DiscordComponent[] } = {},
		): Promise<void> {
			const body: MessageBody = { content, allowed_mentions: { parse: [] } };

			if (options.components) body.components = options.components;

			await http.request<void>(
				"PATCH",
				`/webhooks/${applicationId}/${interactionToken}/messages/@original`,
				jsonBody(body),
			);
		},

		/** Replace the message a component interaction came from. Same rule applies. */
		async interactionUpdate(
			interactionId: string,
			interactionToken: string,
			content: string,
			options: { components?: readonly DiscordComponent[] } = {},
		): Promise<void> {
			const data: Mutable<InteractionMessageBody["data"]> = { content, allowed_mentions: { parse: [] } };

			if (options.components) data.components = options.components;

			await http.interactionCallback(interactionId, interactionToken, jsonBody({ type: 7, data }));
		},

		/** Acknowledge a component interaction without touching its message, so it can be deleted. */
		async interactionDeferUpdate(interactionId: string, interactionToken: string): Promise<void> {
			await http.interactionCallback(interactionId, interactionToken, { type: 6 });
		},

		/** Delete the message an interaction responded with, including an ephemeral menu. */
		async interactionDeleteOriginal(applicationId: string, interactionToken: string): Promise<void> {
			await http.request<void>("DELETE", `/webhooks/${applicationId}/${interactionToken}/messages/@original`);
		},

		/** Open a modal in response to a component or command interaction. */
		async interactionModal(interactionId: string, interactionToken: string, modal: DiscordModal): Promise<void> {
			await http.interactionCallback(interactionId, interactionToken, jsonBody({ type: 9, data: modal }));
		},
	};
}

/** Methods that read or write this application's commands and endpoint. */
function applicationMethods(http: DiscordTransport) {
	return {
		/** The application's current global commands. */
		async listCommands(applicationId: string): Promise<readonly DiscordRegisteredCommand[] | undefined> {
			return await http.request<DiscordRegisteredCommand[]>("GET", `/applications/${applicationId}/commands`);
		},

		/** The application's commands in one guild. */
		async listGuildCommands(
			applicationId: string,
			guildId: string,
		): Promise<readonly DiscordRegisteredCommand[] | undefined> {
			return await http.request<DiscordRegisteredCommand[]>(
				"GET",
				`/applications/${applicationId}/guilds/${guildId}/commands`,
			);
		},

		/** Discord's recommended gateway shard count for this bot. */
		async gatewayShards(): Promise<number> {
			const result = await http.request<Schema.Json>("GET", "/gateway/bot");
			const shards = numberField(result, "shards");

			if (shards !== undefined && Number.isFinite(shards) && shards >= 1) {
				return Math.floor(shards);
			}

			throw new DiscordError("Discord did not return a shard count");
		},

		/** Where Discord currently posts interactions, from the application object. */
		async interactionsEndpoint(): Promise<string | undefined> {
			const result = await http.request<Schema.Json>("GET", "/applications/@me");

			return stringField(result, "interactions_endpoint_url");
		},

		/**
		 * Point Discord's interactions at a URL.
		 *
		 * Discord verifies the URL with a signed PING before accepting it, so a
		 * rejected endpoint leaves gateway delivery untouched.
		 */
		async setInteractionsEndpoint(url: string): Promise<void> {
			await http.request<Schema.Json>("PATCH", "/applications/@me", jsonBody({ interactions_endpoint_url: url }));
		},

		/** Replace the application's global commands. */
		async overwriteCommands(applicationId: string, commands: readonly DiscordCommand[]): Promise<void> {
			await http.request<Schema.Json>("PUT", `/applications/${applicationId}/commands`, jsonBody(commands));
		},

		/** Replace the application's commands in one guild. */
		async overwriteGuildCommands(
			applicationId: string,
			guildId: string,
			commands: readonly DiscordCommand[],
		): Promise<void> {
			await http.request<Schema.Json>(
				"PUT",
				`/applications/${applicationId}/guilds/${guildId}/commands`,
				jsonBody(commands),
			);
		},
	};
}

export type DiscordRest = ReturnType<typeof discordRest>;

