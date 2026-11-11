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
import type { DiscordComponent, DiscordModal } from "./components";

const API = "https://discord.com/api/v10";

/** Discord channel types that are already threads. */
export const THREAD_TYPES = new Set([10, 11, 12]);

/** Discord rejects message content longer than this. */
export const MAX_CONTENT = 2_000;

/** Fallback thread name when a request is empty. */
export const DEFAULT_THREAD_NAME = "eryn";

/** Discord's audit-log action type for `BOT_ADD`. */
export const AUDIT_BOT_ADD = 28;

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
	action_type: Schema.Number,
	user_id: Schema.optional(Schema.String),
	target_id: Schema.optional(Schema.String),
});

const AuditLogSchema = Schema.Struct({
	audit_log_entries: Schema.optional(Schema.Array(DiscordAuditEntrySchema)),
});

/** Seconds Discord asked us to wait, from a 429 body. Defaults to one second. */
function retryDelay(body: unknown): number {
	if (body && typeof body === "object" && "retry_after" in body) {
		const value = (body as { retry_after?: unknown }).retry_after;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.min(value, 60) * 1_000 + 250;
	}
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
		] as [Attempt, Duration.Duration]);
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

/** How to acknowledge an interaction that produced a message. */
export interface InteractionMessageOptions {
	ephemeral?: boolean;
	components?: readonly DiscordComponent[];
}

function permissionOverwrites(value: unknown): readonly PermissionOverwrite[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const parsed: PermissionOverwrite[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const overwrite = entry as Record<string, unknown>;
		if (typeof overwrite.id !== "string" || typeof overwrite.type !== "number") continue;
		parsed.push({
			id: overwrite.id,
			type: overwrite.type,
			allow: typeof overwrite.allow === "string" ? overwrite.allow : "0",
			deny: typeof overwrite.deny === "string" ? overwrite.deny : "0",
		});
	}
	return parsed;
}

function channelRef(value: unknown): DiscordChannelRef | undefined {
	if (!value || typeof value !== "object") return undefined;
	const result = value as Record<string, unknown>;
	if (typeof result.id !== "string" || typeof result.type !== "number") return undefined;
	const overwrites = permissionOverwrites(result.permission_overwrites);
	return {
		id: result.id,
		type: result.type,
		...(typeof result.guild_id === "string" ? { guild_id: result.guild_id } : {}),
		...(typeof result.parent_id === "string" ? { parent_id: result.parent_id } : {}),
		...(typeof result.name === "string" ? { name: result.name } : {}),
		...(typeof result.topic === "string" ? { topic: result.topic } : {}),
		...(typeof result.position === "number" ? { position: result.position } : {}),
		...(overwrites ? { permission_overwrites: overwrites } : {}),
		...(result.thread_metadata && typeof result.thread_metadata === "object"
			? { thread_metadata: result.thread_metadata as { archived?: boolean; auto_archive_duration?: number } }
			: {}),
	};
}

/** Decode a list of channels, dropping entries that are not one. */
function channelRefs(value: unknown): DiscordChannelRef[] {
	if (!Array.isArray(value)) return [];
	return value.map(channelRef).filter((ref): ref is DiscordChannelRef => ref !== undefined);
}

/** The path of one message, which most message operations extend. */
function messagePath(channelId: string, messageId: string): string {
	return `/channels/${channelId}/messages/${messageId}`;
}

/** The id a create-style response must carry. */
function idOf(result: { id?: unknown } | undefined, failure: string): string {
	if (!result || typeof result.id !== "string") throw new DiscordError(failure);
	return result.id;
}

/**
 * A minimal Discord REST client. Responses are never echoed back in errors and
 * rate limits are retried a few times.
 */
export function discordRest(token: string) {
	async function request<T>(
		method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
		path: string,
		body?: unknown,
	): Promise<T | undefined> {
		const headers = new Headers({ Authorization: `Bot ${token}` });
		if (body !== undefined) headers.set("Content-Type", "application/json");
		const fetchOnce = Effect.promise(async (): Promise<Attempt> => {
			const response = await fetch(`${API}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const retryAfter =
				response.status === 429 ? retryDelay(await response.json().catch(() => undefined)) : undefined;
			return { response, ...(retryAfter === undefined ? {} : { retryAfter }) };
		});

		const { response } = await Effect.runPromise(Effect.repeat(fetchOnce, retryRateLimits));
		if (response.status === 404 && method === "GET") return undefined;
		if (response.status === 204) return undefined;
		if (!response.ok) {
			throw new DiscordError(`Discord returned HTTP ${response.status} for ${method} ${path}`, response.status);
		}
		return (await response.json()) as T;
	}

	/** POST a body and return the id of the resource Discord created. */
	async function create(path: string, body: unknown, failure: string): Promise<{ id: string }> {
		return { id: idOf(await request<{ id?: unknown }>("POST", path, body), failure) };
	}

	async function interactionCallback(interactionId: string, interactionToken: string, payload: unknown): Promise<void> {
		await request<void>("POST", `/interactions/${interactionId}/${interactionToken}/callback`, payload);
	}

	return {
		/** The bot's own user, which also serves as the application id. */
		async me(): Promise<DiscordUser> {
			const result = await request<{ id?: unknown; username?: unknown }>("GET", "/users/@me");
			return {
				id: idOf(result, "Discord did not return a bot user"),
				...(typeof result?.username === "string" ? { username: result.username } : {}),
			};
		},

		/** A channel or thread, or undefined when the id does not exist. */
		async channel(channelId: string): Promise<DiscordChannelRef | undefined> {
			return channelRef(await request<unknown>("GET", `/channels/${channelId}`));
		},

		/** Every channel the bot can see in a guild, excluding threads. */
		async guildChannels(guildId: string): Promise<DiscordChannelRef[]> {
			return channelRefs(await request<unknown[]>("GET", `/guilds/${guildId}/channels`));
		},

		/** Active threads in a guild, which Discord lists separately from channels. */
		async activeThreads(guildId: string): Promise<DiscordChannelRef[]> {
			const result = await request<{ threads?: unknown[] }>("GET", `/guilds/${guildId}/threads/active`);
			return channelRefs(result?.threads);
		},

		/** One message in a channel or thread, or undefined when it does not exist. */
		async message(channelId: string, messageId: string): Promise<DiscordMessageView | undefined> {
			return await request<DiscordMessageView>("GET", messagePath(channelId, messageId));
		},

		/** Recent messages in a channel or thread, newest first. */
		async channelMessages(
			channelId: string,
			options: { limit?: number; before?: string } = {},
		): Promise<DiscordMessageView[]> {
			const query = new URLSearchParams({ limit: String(Math.min(Math.max(options.limit ?? 20, 1), 100)) });
			if (options.before) query.set("before", options.before);
			const result = await request<DiscordMessageView[]>("GET", `/channels/${channelId}/messages?${query}`);
			return Array.isArray(result) ? result : [];
		},

		async sendMessage(
			channelId: string,
			content: string,
			options: { users?: readonly string[]; replyTo?: string; components?: readonly DiscordComponent[] } = {},
		): Promise<{ id: string }> {
			const body: Record<string, unknown> = {
				content,
				// Suppress every ping unless a caller names the users to notify.
				allowed_mentions: { parse: [], users: options.users ?? [] },
			};
			if (options.replyTo) body.message_reference = { message_id: options.replyTo, fail_if_not_exists: false };
			if (options.components?.length) body.components = options.components;
			return await create(`/channels/${channelId}/messages`, body, "Discord did not accept the message");
		},

		/** Add a user to a thread so they follow it. This does not notify them. */
		async addThreadMember(channelId: string, userId: string): Promise<void> {
			await request<void>("PUT", `/channels/${channelId}/thread-members/${userId}`);
		},

		async editMessage(
			channelId: string,
			messageId: string,
			content: string,
			options: { components?: readonly DiscordComponent[] } = {},
		): Promise<void> {
			await request<void>("PATCH", messagePath(channelId, messageId), {
				content,
				allowed_mentions: { parse: [] },
				...(options.components ? { components: options.components } : {}),
			});
		},

		async createThread(channelId: string, messageId: string, name: string): Promise<{ id: string }> {
			const path = `${messagePath(channelId, messageId)}/threads`;
			return await create(path, { name, auto_archive_duration: 1_440 }, "Discord did not create the thread");
		},

		/** Start a public thread in a channel, not attached to a message. */
		async startThread(channelId: string, name: string): Promise<{ id: string }> {
			return await create(
				`/channels/${channelId}/threads`,
				{ name, auto_archive_duration: 1_440 },
				"Discord did not create the thread",
			);
		},

		/** Archive or unarchive a thread. */
		async setThreadArchived(threadId: string, archived: boolean, locked = false): Promise<void> {
			await request<void>("PATCH", `/channels/${threadId}`, { archived, locked });
		},

		/** Follow a thread, so its messages stay available to the bot. */
		async joinThread(threadId: string): Promise<void> {
			await request<void>("PUT", `/channels/${threadId}/thread-members/@me`);
		},

		/** Stop following a thread. */
		async leaveThread(threadId: string): Promise<void> {
			await request<void>("DELETE", `/channels/${threadId}/thread-members/@me`);
		},

		async deleteMessage(channelId: string, messageId: string): Promise<void> {
			await request<void>("DELETE", messagePath(channelId, messageId));
		},

		async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
			await request<void>("PUT", `${messagePath(channelId, messageId)}/reactions/${encodeURIComponent(emoji)}/@me`);
		},

		async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
			await request<void>("DELETE", `${messagePath(channelId, messageId)}/reactions/${encodeURIComponent(emoji)}/@me`);
		},

		async pinMessage(channelId: string, messageId: string): Promise<void> {
			await request<void>("PUT", `/channels/${channelId}/pins/${messageId}`);
		},

		async unpinMessage(channelId: string, messageId: string): Promise<void> {
			await request<void>("DELETE", `/channels/${channelId}/pins/${messageId}`);
		},

		async triggerTyping(channelId: string): Promise<void> {
			await request<void>("POST", `/channels/${channelId}/typing`);
		},

		/** The guild's roles, used to find the bot's managed role. */
		async guildRoles(guildId: string): Promise<DiscordRole[]> {
			const result = await request<DiscordRole[]>("GET", `/guilds/${guildId}/roles`);
			return Array.isArray(result) ? result : [];
		},

		/**
		 * One guild member's role ids, or undefined when they are not a member.
		 *
		 * Permissions are computed from these ids; a member who has left has no
		 * permissions to lend to a tool call.
		 */
		async guildMember(guildId: string, userId: string): Promise<{ roles: string[] } | undefined> {
			const result = await request<{ roles?: unknown }>("GET", `/guilds/${guildId}/members/${userId}`);
			if (!result || !Array.isArray(result.roles)) return undefined;
			return { roles: result.roles.filter((role): role is string => typeof role === "string") };
		},

		/** A guild's owner, which the permission resolver needs to grant everything. */
		async guildInfo(guildId: string): Promise<{ ownerId?: string } | undefined> {
			const result = await request<{ owner_id?: unknown }>("GET", `/guilds/${guildId}`);
			if (!result) return undefined;
			return typeof result.owner_id === "string" ? { ownerId: result.owner_id } : {};
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
				const result = await request<unknown>("GET", `/channels/${threadId}/thread-members/${userId}`);
				return result !== undefined;
			} catch {
				return undefined;
			}
		},

		/** The guilds the bot is a member of. */
		async guilds(): Promise<{ id: string; name: string }[]> {
			const result = await request<{ id?: unknown; name?: unknown }[]>("GET", "/users/@me/guilds");
			if (!Array.isArray(result)) return [];
			return result
				.filter(
					(guild): guild is { id: string; name: string } =>
						typeof guild.id === "string" && typeof guild.name === "string",
				)
				.map((guild) => ({ id: guild.id, name: guild.name }));
		},

		/**
		 * The most recent `BOT_ADD` audit entry for a guild, which is how the bot
		 * learns *who* installed it. `target_id` is the bot user id.
		 */
		async botAddEntry(guildId: string): Promise<DiscordAuditEntry | undefined> {
			const result = await request<unknown>(
				"GET",
				`/guilds/${guildId}/audit-logs?action_type=${AUDIT_BOT_ADD}&limit=1`,
			);
			return Option.getOrUndefined(Schema.decodeUnknownOption(AuditLogSchema)(result))?.audit_log_entries?.[0];
		},

		/** Acknowledge an interaction with a message (ephemeral by default). */
		async interactionReply(
			interactionId: string,
			interactionToken: string,
			content: string,
			options: InteractionMessageOptions = {},
		): Promise<void> {
			await interactionCallback(interactionId, interactionToken, {
				type: 4,
				data: {
					content,
					// Error strings and MCP text are untrusted: never let a mention
					// token in them ping a user, role, or another bot.
					allowed_mentions: { parse: [] },
					flags: options.ephemeral === false ? 0 : 64,
					...(options.components?.length ? { components: options.components } : {}),
				},
			});
		},

		/** Acknowledge an interaction without content, so slow work can finish later. */
		async interactionDefer(interactionId: string, interactionToken: string, ephemeral = true): Promise<void> {
			await interactionCallback(interactionId, interactionToken, {
				type: 5,
				data: { flags: ephemeral ? 64 : 0 },
			});
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
			await request<void>("PATCH", `/webhooks/${applicationId}/${interactionToken}/messages/@original`, {
				content,
				allowed_mentions: { parse: [] },
				...(options.components ? { components: options.components } : {}),
			});
		},

		/** Replace the message a component interaction came from. Same rule applies. */
		async interactionUpdate(
			interactionId: string,
			interactionToken: string,
			content: string,
			options: { components?: readonly DiscordComponent[] } = {},
		): Promise<void> {
			await interactionCallback(interactionId, interactionToken, {
				type: 7,
				data: {
					content,
					allowed_mentions: { parse: [] },
					...(options.components ? { components: options.components } : {}),
				},
			});
		},

		/** Acknowledge a component interaction without touching its message, so it can be deleted. */
		async interactionDeferUpdate(interactionId: string, interactionToken: string): Promise<void> {
			await interactionCallback(interactionId, interactionToken, { type: 6 });
		},

		/** Delete the message an interaction responded with, including an ephemeral menu. */
		async interactionDeleteOriginal(applicationId: string, interactionToken: string): Promise<void> {
			await request<void>("DELETE", `/webhooks/${applicationId}/${interactionToken}/messages/@original`);
		},

		/** Open a modal in response to a component or command interaction. */
		async interactionModal(interactionId: string, interactionToken: string, modal: DiscordModal): Promise<void> {
			await interactionCallback(interactionId, interactionToken, { type: 9, data: modal });
		},

		/** The application's current global commands. */
		async listCommands(applicationId: string): Promise<readonly DiscordRegisteredCommand[] | undefined> {
			return await request<DiscordRegisteredCommand[]>("GET", `/applications/${applicationId}/commands`);
		},

		/** Discord's recommended gateway shard count for this bot. */
		async gatewayShards(): Promise<number> {
			const result = await request<{ shards?: unknown }>("GET", "/gateway/bot");
			if (typeof result?.shards === "number" && Number.isFinite(result.shards) && result.shards >= 1) {
				return Math.floor(result.shards);
			}
			throw new DiscordError("Discord did not return a shard count");
		},

		/** Where Discord currently posts interactions, from the application object. */
		async interactionsEndpoint(): Promise<string | undefined> {
			const result = await request<{ interactions_endpoint_url?: unknown }>("GET", "/applications/@me");
			return typeof result?.interactions_endpoint_url === "string"
				? result.interactions_endpoint_url
				: undefined;
		},

		/**
		 * Point Discord's interactions at a URL.
		 *
		 * Discord verifies the URL with a signed PING before accepting it, so a
		 * rejected endpoint leaves gateway delivery untouched.
		 */
		async setInteractionsEndpoint(url: string): Promise<void> {
			await request<unknown>("PATCH", "/applications/@me", { interactions_endpoint_url: url });
		},

		/** Replace the application's global commands. */
		async overwriteCommands(applicationId: string, commands: readonly DiscordCommand[]): Promise<void> {
			await request<unknown>("PUT", `/applications/${applicationId}/commands`, commands);
		},
	};
}

export type DiscordRest = ReturnType<typeof discordRest>;

