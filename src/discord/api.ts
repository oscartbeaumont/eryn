/**
 * The deterministic Discord REST surface used by Eryn.
 *
 * This module owns channel configuration, sending and editing messages,
 * starting threads, typing indicators, interaction replies, and command
 * registration. It never logs the bot token or a Discord response body, which
 * can contain user messages.
 */

const API = "https://discord.com/api/v10";

/** Discord channel types that are already threads. */
export const THREAD_TYPES = new Set([10, 11, 12]);

/** Discord rejects message content longer than this. */
export const MAX_CONTENT = 2_000;

/** Fallback thread name when a request is empty. */
export const DEFAULT_THREAD_NAME = "eryn";

export interface DiscordUser {
	id: string;
	username?: string;
	/** The user's display name, when they have one. Preferred over the handle. */
	global_name?: string;
	bot?: boolean;
}

export interface DiscordChannelRef {
	id: string;
	type: number;
	parent_id?: string;
	name?: string;
	topic?: string;
	position?: number;
	thread_metadata?: { archived?: boolean; auto_archive_duration?: number };
}

/** The subset of a guild role this bot reads. Managed bot roles carry `tags.bot_id`. */
/** The subset of a guild channel this bot reads. */
export interface DiscordGuildChannel {
	id: string;
	type: number;
	name?: string;
	parent_id?: string;
	topic?: string;
	position?: number;
	thread_metadata?: { archived?: boolean; auto_archive_duration?: number };
}

/** The subset of a message this bot reads. */
export interface DiscordMessageView {
	id: string;
	channel_id: string;
	content?: string;
	timestamp?: string;
	author?: { id?: string; username?: string; global_name?: string; bot?: boolean };
	attachments?: { filename?: string; url?: string }[];
	embeds?: unknown[];
	referenced_message?: { id?: string } | null;
}

/** The subset of a role this bot reads. */
export interface DiscordRole {
	id: string;
	name: string;
	managed: boolean;
	tags?: { bot_id?: string };
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A one-line description of an unknown error, for logs and thread messages. */
export function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Split a message into Discord-sized chunks, preferring line boundaries.
 * Always returns at least one chunk so callers can rely on `chunks[0]`.
 */
export function splitMessage(message: string, limit = MAX_CONTENT): string[] {
	const chunks: string[] = [];
	const pattern = new RegExp(`[\\s\\S]{1,${limit}}`, "g");
	for (const line of message.split("\n")) {
		const parts = line.length > limit ? (line.match(pattern) ?? []) : [line];
		for (const part of parts) {
			const current = chunks.at(-1);
			const next = current === undefined || current === "" ? part : `${current}\n${part}`;
			if (current === undefined || next.length > limit) chunks.push(part);
			else chunks[chunks.length - 1] = next;
		}
	}
	return chunks.length ? chunks : [""];
}

/** Seconds Discord asked us to wait, from a 429 body. Defaults to one second. */
function retryDelay(body: unknown): number {
	if (body && typeof body === "object" && "retry_after" in body) {
		const value = (body as { retry_after?: unknown }).retry_after;
		if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.min(value, 60) * 1_000 + 250;
	}
	return 1_000;
}

export interface DiscordCommand {
	name: string;
	description: string;
	type: 1;
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
		for (let attempt = 0; ; attempt++) {
			const headers = new Headers({ Authorization: `Bot ${token}` });
			if (body !== undefined) headers.set("Content-Type", "application/json");
			const response = await fetch(`${API}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});

			if (response.status === 429 && attempt < 3) {
				await sleep(retryDelay(await response.json().catch(() => undefined)));
				continue;
			}
			if (response.status === 404 && method === "GET") return undefined;
			if (response.status === 204) return undefined;
			if (!response.ok) {
				throw new DiscordError(`Discord returned HTTP ${response.status} for ${method} ${path}`, response.status);
			}
			return (await response.json()) as T;
		}
	}

	return {
		/** The bot's own user, which also serves as the application id. */
		async me(): Promise<DiscordUser> {
			const result = await request<{ id?: unknown; username?: unknown }>("GET", "/users/@me");
			if (!result || typeof result.id !== "string") throw new DiscordError("Discord did not return a bot user");
			return {
				id: result.id,
				...(typeof result.username === "string" ? { username: result.username } : {}),
			};
		},

		/** A channel or thread, or undefined when the id does not exist. */
		async channel(channelId: string): Promise<DiscordChannelRef | undefined> {
			const result = await request<Record<string, unknown>>("GET", `/channels/${channelId}`);
			if (!result || typeof result.id !== "string" || typeof result.type !== "number") return undefined;
			return {
				id: result.id,
				type: result.type,
				...(typeof result.parent_id === "string" ? { parent_id: result.parent_id } : {}),
				...(typeof result.name === "string" ? { name: result.name } : {}),
				...(typeof result.topic === "string" ? { topic: result.topic } : {}),
				...(typeof result.position === "number" ? { position: result.position } : {}),
				...(result.thread_metadata && typeof result.thread_metadata === "object"
					? { thread_metadata: result.thread_metadata as { archived?: boolean } }
					: {}),
			};
		},

		async sendMessage(
			channelId: string,
			content: string,
			options: { users?: readonly string[]; replyTo?: string } = {},
		): Promise<{ id: string }> {
			const body: Record<string, unknown> = {
				content,
				// Suppress every ping unless a caller names the users to notify.
				allowed_mentions: { parse: [], users: options.users ?? [] },
			};
			if (options.replyTo) body.message_reference = { message_id: options.replyTo, fail_if_not_exists: false };
			const result = await request<{ id?: unknown }>("POST", `/channels/${channelId}/messages`, body);
			if (!result || typeof result.id !== "string") throw new DiscordError("Discord did not accept the message");
			return { id: result.id };
		},

		/** Add a user to a thread so they follow it. This does not notify them. */
		async addThreadMember(channelId: string, userId: string): Promise<void> {
			await request<void>("PUT", `/channels/${channelId}/thread-members/${userId}`);
		},

		async editMessage(channelId: string, messageId: string, content: string): Promise<void> {
			await request<void>("PATCH", `/channels/${channelId}/messages/${messageId}`, {
				content,
				allowed_mentions: { parse: [] },
			});
		},

		async createThread(channelId: string, messageId: string, name: string): Promise<{ id: string }> {
			const result = await request<{ id?: unknown }>(
				"POST",
				`/channels/${channelId}/messages/${messageId}/threads`,
				{ name, auto_archive_duration: 1_440 },
			);
			if (!result || typeof result.id !== "string") throw new DiscordError("Discord did not create the thread");
			return { id: result.id };
		},

		async triggerTyping(channelId: string): Promise<void> {
			await request<void>("POST", `/channels/${channelId}/typing`);
		},

		/** The guild's roles, used to find the bot's managed role. */
		async guildRoles(guildId: string): Promise<DiscordRole[]> {
			const result = await request<DiscordRole[]>("GET", `/guilds/${guildId}/roles`);
			return Array.isArray(result) ? result : [];
		},

		/** A guild's channels, including categories and threads the bot can see. */
		async guildChannels(guildId: string): Promise<DiscordGuildChannel[]> {
			const result = await request<DiscordGuildChannel[]>("GET", `/guilds/${guildId}/channels`);
			return Array.isArray(result) ? result : [];
		},

		/**
		 * A channel's messages, newest first.
		 *
		 * Discord pages by message id: `before` walks backwards through history and
		 * `after` forwards from an id, so a caller that has one message can read
		 * either side of it.
		 */
		async channelMessages(
			channelId: string,
			options: { limit?: number; before?: string; after?: string } = {},
		): Promise<DiscordMessageView[]> {
			const query = new URLSearchParams();
			query.set("limit", String(Math.min(Math.max(options.limit ?? 50, 1), 100)));
			if (options.before) query.set("before", options.before);
			if (options.after) query.set("after", options.after);
			const result = await request<DiscordMessageView[]>("GET", `/channels/${channelId}/messages?${query}`);
			return Array.isArray(result) ? result : [];
		},

		/** One message, so a caller can read what it is about to reply to. */
		async message(channelId: string, messageId: string): Promise<DiscordMessageView | undefined> {
			return await request<DiscordMessageView>("GET", `/channels/${channelId}/messages/${messageId}`);
		},

		/** A guild's active threads, which is the only place Discord lists them. */
		async activeThreads(guildId: string): Promise<DiscordGuildChannel[]> {
			const result = await request<{ threads?: DiscordGuildChannel[] }>("GET", `/guilds/${guildId}/threads/active`);
			return Array.isArray(result?.threads) ? result.threads : [];
		},

		/** A channel's archived threads, newest first. Private ones need a bot that is a member. */
		async archivedThreads(
			channelId: string,
			options: { limit?: number; before?: string; private?: boolean } = {},
		): Promise<DiscordGuildChannel[]> {
			const query = new URLSearchParams({ limit: String(Math.min(Math.max(options.limit ?? 50, 1), 100)) });
			if (options.before) query.set("before", options.before);
			const kind = options.private ? "private" : "public";
			const result = await request<{ threads?: DiscordGuildChannel[] }>(
				"GET",
				`/channels/${channelId}/threads/archived/${kind}?${query}`,
			);
			return Array.isArray(result?.threads) ? result.threads : [];
		},

		/**
		 * Search a guild's messages.
		 *
		 * Discord returns results grouped by thread, so the arrays are flattened
		 * here and the caller sees messages in the order the index returned them.
		 */
		async searchMessages(
			guildId: string,
			options: { content?: string; authorId?: string; channelId?: string; limit?: number; offset?: number } = {},
		): Promise<{ total: number; messages: DiscordMessageView[] }> {
			const query = new URLSearchParams();
			if (options.content) query.set("content", options.content);
			if (options.authorId) query.append("author_id", options.authorId);
			if (options.channelId) query.append("channel_id", options.channelId);
			query.set("limit", String(Math.min(Math.max(options.limit ?? 25, 1), 25)));
			if (options.offset) query.set("offset", String(options.offset));
			const result = await request<{ messages?: DiscordMessageView[][]; total_results?: number }>(
				"GET",
				`/guilds/${guildId}/messages/search?${query}`,
			);
			const grouped = Array.isArray(result?.messages) ? result.messages : [];
			return {
				total: typeof result?.total_results === "number" ? result.total_results : 0,
				messages: grouped.flat().filter(Boolean),
			};
		},

		/** Start a thread in a channel, not attached to any message. */
		async startThread(
			channelId: string,
			name: string,
			options: { autoArchiveDuration?: number } = {},
		): Promise<{ id: string }> {
			const result = await request<{ id?: unknown }>("POST", `/channels/${channelId}/threads`, {
				name,
				auto_archive_duration: options.autoArchiveDuration ?? 1_440,
			});
			if (!result || typeof result.id !== "string") throw new DiscordError("Discord did not create the thread");
			return { id: result.id };
		},

		/** A guild's owner, whose MCP tools the agent in that guild acts with. */
		async guildOwner(guildId: string): Promise<string | undefined> {
			const result = await request<{ owner_id?: unknown }>("GET", `/guilds/${guildId}`);
			return typeof result?.owner_id === "string" ? result.owner_id : undefined;
		},

		/** The guilds the bot is a member of, used to show install status on setup. */
		async guilds(): Promise<{ id: string; name: string }[]> {
			const result = await request<{ id?: unknown; name?: unknown }[]>("GET", "/users/@me/guilds");
			if (!Array.isArray(result)) return [];
			return result
				.filter((guild): guild is { id: string; name: string } => typeof guild.id === "string" && typeof guild.name === "string")
				.map((guild) => ({ id: guild.id, name: guild.name }));
		},

		/** Acknowledge an interaction with a (by default ephemeral) message. */
		async interactionReply(interactionId: string, token: string, content: string, ephemeral = true): Promise<void> {
			await request<void>("POST", `/interactions/${interactionId}/${token}/callback`, {
				type: 4,
				data: { content, flags: ephemeral ? 64 : 0 },
			});
		},

		/** Replace the application's global commands. */
		async overwriteCommands(applicationId: string, commands: DiscordCommand[]): Promise<void> {
			await request<unknown>("PUT", `/applications/${applicationId}/commands`, commands);
		},
	};
}

export type DiscordRest = ReturnType<typeof discordRest>;
