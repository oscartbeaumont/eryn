/**
 * The deterministic Discord REST surface used by Eryn.
 *
 * This module owns channel configuration, sending and editing messages,
 * starting threads, typing indicators, interaction replies, and command
 * registration. It never logs the bot token or a Discord response body, which
 * can contain user messages.
 */

const API = "https://discord.com/api/v10";

/** Discord snowflake ids are non-zero integers serialised as strings. */
export const SNOWFLAKE = /^[1-9]\d{0,19}$/;

/** Discord channel types that are already threads. */
export const THREAD_TYPES = new Set([10, 11, 12]);

/** Discord rejects message content longer than this. */
export const MAX_CONTENT = 2_000;

/** Fallback thread name when a request is empty. */
export const DEFAULT_THREAD_NAME = "eryn";

export interface DiscordUser {
	id: string;
	username?: string;
	bot?: boolean;
}

export interface DiscordChannelRef {
	id: string;
	type: number;
	parent_id?: string;
	name?: string;
}

export interface DiscordChannel {
	id: string;
	description?: string;
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

/** Keep only well-formed channel entries; ignore anything malformed. */
export function parseChannels(raw: string | undefined): Record<string, DiscordChannel> {
	if (!raw?.trim()) return {};

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		console.warn("[eryn] DISCORD_CHANNELS is not valid JSON; no channels are allowlisted");
		return {};
	}

	const source =
		parsed && typeof parsed === "object" && !Array.isArray(parsed) && "channels" in parsed
			? (parsed as { channels?: unknown }).channels
			: parsed;
	if (!source || typeof source !== "object" || Array.isArray(source)) return {};

	const channels: Record<string, DiscordChannel> = {};
	for (const [name, value] of Object.entries(source)) {
		if (!value || typeof value !== "object") continue;
		const candidate = value as { id?: unknown; description?: unknown };
		if (typeof candidate.id !== "string" || !SNOWFLAKE.test(candidate.id)) continue;
		channels[name] = {
			id: candidate.id,
			...(typeof candidate.description === "string" ? { description: candidate.description } : {}),
		};
	}
	return channels;
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
			};
		},

		async sendMessage(channelId: string, content: string): Promise<{ id: string }> {
			const result = await request<{ id?: unknown }>("POST", `/channels/${channelId}/messages`, {
				content,
				allowed_mentions: { parse: [] },
			});
			if (!result || typeof result.id !== "string") throw new DiscordError("Discord did not accept the message");
			return { id: result.id };
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

		/** Acknowledge an interaction with a (by default ephemeral) message. */
		async interactionReply(interactionId: string, token: string, content: string, ephemeral = true): Promise<void> {
			await request<void>("POST", `/interactions/${interactionId}/${token}/callback`, {
				type: 4,
				data: { content, flags: ephemeral ? 64 : 0 },
			});
		},

		/** Replace the application's commands globally, or within one guild. */
		async overwriteCommands(applicationId: string, commands: DiscordCommand[], guildId?: string): Promise<void> {
			const path = guildId
				? `/applications/${applicationId}/guilds/${guildId}/commands`
				: `/applications/${applicationId}/commands`;
			await request<unknown>("PUT", path, commands);
		},
	};
}

export type DiscordRest = ReturnType<typeof discordRest>;
