/**
 * The gateway Durable Object.
 *
 * It holds exactly one Discord gateway connection (a singleton named
 * "gateway"), turns mentions into threads, remembers which threads it owns,
 * and forwards prompts to the per-thread session object. It deliberately
 * hosts no OpenCode work so a long agent turn can never stall the heartbeat.
 *
 * Cloudflare only keeps an object in memory for 15 minutes per outbound
 * connection, so this object arms an alarm that resumes or recycles the
 * gateway before that cap is reached, and that also restarts it after a
 * deploy, eviction, or a missed connection.
 */

import { DurableObject } from "cloudflare:workers";
import { intFromEnv } from "./config";
import {
	DEFAULT_THREAD_NAME,
	DiscordError,
	THREAD_TYPES,
	describeError,
	discordRest,
	type DiscordRest,
} from "./discord/api";
import { DiscordGateway, type DiscordInteraction, type DiscordMessage } from "./discord/gateway";
import { getGuildKey, type GuildKey } from "./registry-client";

const WAKE_PATH = "/wake";
const THREAD_PREFIX = "thread:";
const COMMANDS_KEY = "discord:commands";
/** Bump when the registered command set changes so it is re-registered. */
const COMMANDS_VERSION = "1";
const MAX_THREAD_NAME = 100;
const DEFAULT_KEEPALIVE_SECONDS = 60;
/** Text that interrupts the running turn when sent in an owned thread. */
const STOP_TEXT = new Set(["stop", "cancel", "!stop", "!cancel", "/stop", "/cancel"]);

function log(message: string): void {
	console.log(`[eryn:gateway] ${message}`);
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

export class ErynGateway extends DurableObject<Env> {
	private readonly token: string;
	private readonly rest: DiscordRest;
	private readonly gateway: DiscordGateway;
	private readonly keepAliveMs: number;
	private readonly locks = new Map<string, Promise<void>>();
	/** Bot managed-role id per guild, resolved lazily. */
	private readonly roleCache = new Map<string, string>();

	private botUserId: string | undefined;
	private initialization: Promise<void> | undefined;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.token = env.DISCORD_BOT_TOKEN?.trim() ?? "";
		this.rest = discordRest(this.token);
		this.keepAliveMs = intFromEnv(env.DISCORD_KEEPALIVE_SECONDS, DEFAULT_KEEPALIVE_SECONDS, 20, 3_600) * 1_000;
		this.gateway = new DiscordGateway(this.token, log, {
			onMessage: (message) => {
				void this.onMessage(message).catch((error) => log(`message handling failed: ${describeError(error)}`));
			},
			onInteraction: (interaction) => {
				void this.onInteraction(interaction).catch((error) =>
					log(`interaction handling failed: ${describeError(error)}`),
				);
			},
		});
	}

	/** Keeps the gateway alive and arms the next wake-up. */
	async alarm(): Promise<void> {
		await this.keepAlive();
	}

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === WAKE_PATH) {
			await this.ensure();
			return json({ ok: true, connected: this.gateway.open });
		}
		return json({ error: "not found" }, 404);
	}

	/** Resolve the bot identity, register commands, and connect. Idempotent. */
	private ensure(): Promise<void> {
		if (!this.token) return Promise.resolve();
		this.initialization ??= this.initialize().catch((error) => {
			this.initialization = undefined;
			log(`initialization failed, will retry on the next wake: ${describeError(error)}`);
		});
		return this.initialization;
	}

	private async initialize(): Promise<void> {
		const me = await this.rest.me();
		this.botUserId = me.id;
		log(`signed in as ${me.username ?? me.id}`);
		await this.registerCommands(me.id);
		this.gateway.ensure();
	}

	private async registerCommands(applicationId: string): Promise<void> {
		if ((await this.ctx.storage.get<string>(COMMANDS_KEY)) === COMMANDS_VERSION) return;
		await this.rest.overwriteCommands(applicationId, [
			{ name: "stop", description: "Stop the Eryn agent running in this thread", type: 1 },
		]);
		await this.ctx.storage.put(COMMANDS_KEY, COMMANDS_VERSION);
		log("registered global commands");
	}

	private async keepAlive(): Promise<void> {
		if (!this.token || this.gateway.fatallyClosed) return;
		await this.ctx.storage.setAlarm(Date.now() + this.keepAliveMs);
		await this.ensure();
		if (!this.gateway.open) this.gateway.ensure();
		else if (this.gateway.stale) {
			log("recycling the gateway connection before Cloudflare evicts this object");
			this.gateway.recycle();
		}
	}

	// --- Inbound Discord events -------------------------------------------------

	private async onMessage(message: DiscordMessage): Promise<void> {
		if (!this.botUserId) return;
		if (message.guild_id === undefined) return;
		if (message.webhook_id !== undefined) return;
		if (message.author?.bot || message.author?.id === this.botUserId) return;

		const channel = await this.rest.channel(message.channel_id);
		if (!channel) return;

		// Discord also creates a managed role named after the bot, and its `@`
		// autocomplete can insert `<@&role>` instead of `<@user>`, so accept both.
		const roleId = await this.botRoleMention(message);
		const config = await this.guildConfig(message.guild_id);

		// A message inside a thread we own goes straight to that thread's session.
		if (THREAD_TYPES.has(channel.type)) {
			if (!(await this.ownsThread(channel.id))) return;
			const text = this.stripMention(message.content ?? "", roleId).trim();
			if (!text) return;
			if (STOP_TEXT.has(text.toLowerCase())) {
				await this.stopThread(channel.id);
				return;
			}
			if (!config) {
				await this.requireSetup(channel.id);
				return;
			}
			await this.forward(channel.id, this.threadName(text), text, message, config);
			return;
		}

		// Otherwise require an explicit mention and open a thread for the request.
		if (!this.isMention(message, roleId)) return;

		const text = this.stripMention(message.content ?? "", roleId).trim();
		const name = this.threadName(text || DEFAULT_THREAD_NAME);
		let threadId: string;
		try {
			threadId = await this.createThread(channel.id, message.id, name);
		} catch (error) {
			log(`could not start a thread in ${channel.id}: ${describeError(error)}`);
			await this.rest
				.sendMessage(channel.id, `I could not start a thread for that: ${describeError(error)}`)
				.catch(() => undefined);
			return;
		}

		await this.ctx.storage.put(THREAD_PREFIX + threadId, true);
		// Add the requester to the thread, silently, so a completion ping lands
		// for someone who has already navigated away.
		const authorId = message.author?.id;
		if (authorId) {
			await this.rest
				.addThreadMember(threadId, authorId)
				.catch((error) => log(`could not add ${authorId} to thread ${threadId}: ${describeError(error)}`));
		}
		if (!text) {
			await this.rest.sendMessage(threadId, "What would you like me to do?").catch(() => undefined);
			return;
		}
		if (!config) {
			await this.requireSetup(threadId);
			return;
		}
		await this.forward(threadId, name, text, message, config);
	}

	private async onInteraction(interaction: DiscordInteraction): Promise<void> {
		if (interaction.type !== 2) return;
		if (interaction.data?.name !== "stop") return;
		const channelId = interaction.channel_id;
		if (!channelId) return;

		if (!(await this.ownsThread(channelId))) {
			await this.rest
				.interactionReply(interaction.id, interaction.token, "There is no Eryn run in this thread.")
				.catch(() => undefined);
			return;
		}
		await this.rest
			.interactionReply(interaction.id, interaction.token, "Stopping the current run…")
			.catch(() => undefined);
		void this.stopThread(channelId).catch((error) => log(`stop failed: ${describeError(error)}`));
	}

	// --- Session object plumbing ------------------------------------------------

	/** The guild's credential from the registry, or undefined when unconfigured. */
	private async guildConfig(guildId: string): Promise<GuildKey | undefined> {
		return await getGuildKey(this.env, guildId).catch(() => undefined);
	}

	/** Ask a server admin to connect a key before the agent can run. */
	private async requireSetup(threadId: string): Promise<void> {
		const origin = this.env.PUBLIC_ORIGIN?.trim() || "https://eryn.otbeaumont.me";
		await this.rest
			.sendMessage(
				threadId,
				`This server has not connected an OpenCode Go key yet, so I cannot run inference here. A server admin can add one at ${origin}/console`,
			)
			.catch(() => undefined);
	}

	/** Forward a prompt and wait for the turn, serialised per thread. */
	private forward(
		threadId: string,
		title: string,
		text: string,
		message: DiscordMessage,
		config: GuildKey,
	): Promise<void> {
		return this.withLock(threadId, async () => {
			const stub = this.env.SESSION.get(this.env.SESSION.idFromName(threadId));
			const response = await stub.fetch("https://eryn/session/prompt", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					threadId,
					title,
					text,
					author: message.author?.username ?? "someone",
					apiKey: config.apiKey,
					model: config.model,
					github: config.github,
				}),
			});
			if (!response.ok) log(`session prompt for ${threadId} failed with HTTP ${response.status}`);
		});
	}

	private async stopThread(threadId: string): Promise<void> {
		const stub = this.env.SESSION.get(this.env.SESSION.idFromName(threadId));
		await stub.fetch("https://eryn/session/interrupt", { method: "POST" });
	}

	private ownsThread(threadId: string): Promise<boolean> {
		return this.ctx.storage.get<boolean>(THREAD_PREFIX + threadId).then((value) => value === true);
	}

	/** Serialise work that shares a session so messages keep their order. */
	private withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
		const previous = this.locks.get(key) ?? Promise.resolve();
		const next = previous.then(run, run);
		const guard = next.then(
			() => undefined,
			() => undefined,
		);
		this.locks.set(key, guard);
		void guard.then(() => {
			if (this.locks.get(key) === guard) this.locks.delete(key);
		});
		return next;
	}

	// --- Helpers ----------------------------------------------------------------

	private mentionPattern(): RegExp | undefined {
		return this.botUserId ? new RegExp(`<@!?${this.botUserId}>`, "g") : undefined;
	}

	private isMention(message: DiscordMessage, roleId: string | undefined): boolean {
		if (!this.botUserId) return false;
		if (message.mentions?.some((user) => user.id === this.botUserId)) return true;
		if (this.mentionPattern()?.test(message.content ?? "")) return true;
		if (roleId !== undefined) {
			if (message.mention_roles?.includes(roleId)) return true;
			if ((message.content ?? "").includes(`<@&${roleId}>`)) return true;
		}
		return false;
	}

	private stripMention(content: string, roleId: string | undefined): string {
		const pattern = this.mentionPattern();
		let text = pattern ? content.replace(pattern, " ") : content;
		if (roleId !== undefined) text = text.replaceAll(`<@&${roleId}>`, " ");
		return text.replace(/\s+/g, " ").trim();
	}

	/**
	 * The bot's managed role id for the guild, but only when the message might
	 * reference it, so ordinary messages never pay for the lookup.
	 */
	private async botRoleMention(message: DiscordMessage): Promise<string | undefined> {
		if (message.guild_id === undefined) return undefined;
		const roles = message.mention_roles ?? [];
		if (!roles.length && !/<@&\d+>/.test(message.content ?? "")) return undefined;
		return await this.botRoleId(message.guild_id).catch(() => undefined);
	}

	private async botRoleId(guildId: string): Promise<string | undefined> {
		const cached = this.roleCache.get(guildId);
		if (cached) return cached;
		if (!this.botUserId) return undefined;
		const roles = await this.rest.guildRoles(guildId);
		const role = roles.find((candidate) => candidate.tags?.bot_id === this.botUserId);
		if (!role) return undefined;
		this.roleCache.set(guildId, role.id);
		return role.id;
	}

	/** Discord permits 100 characters in a thread name; derive one from the request. */
	private threadName(content: string): string {
		const text = content.replace(/\s+/g, " ").trim();
		if (!text) return DEFAULT_THREAD_NAME;
		return text.length > MAX_THREAD_NAME ? text.slice(0, MAX_THREAD_NAME - 1) : text;
	}

	/** Reuse an existing thread for a message, or start one from it. */
	private async createThread(channelId: string, messageId: string, name: string): Promise<string> {
		try {
			return (await this.rest.createThread(channelId, messageId, name)).id;
		} catch (error) {
			// A thread already exists for this message, e.g. a second mention.
			if (error instanceof DiscordError && error.status === 400) {
				const existing = await this.rest.channel(messageId);
				if (existing) return existing.id;
			}
			throw error;
		}
	}
}
