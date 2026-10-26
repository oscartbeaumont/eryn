/**
 * The bot gateway object.
 *
 * It holds exactly one Discord gateway connection (a singleton named "bot"),
 * turns mentions into threads, remembers which threads it owns, dispatches the
 * slash commands, announces fresh installs, and forwards prompts to the
 * per-guild session object. It deliberately hosts no OpenCode work and no
 * database, so it is the only part of the bot that has to stay resident.
 *
 * Clearing `DISCORD_BOT_TOKEN` stops the gateway entirely (the object returns
 * without connecting), which is the switch for "run nothing at all".
 *
 * The alarm is only a safety net: it re-arms itself, reconnects a dropped
 * socket, and resumes the Discord session before Cloudflare's 15 minute cap.
 */

import { DurableObject } from "cloudflare:workers";
import { intFromEnv, log as botLog } from "../config";
import { describeError } from "../errors";
import {
	DEFAULT_THREAD_NAME,
	DiscordError,
	THREAD_TYPES,
	discordRest,
	type DiscordChannelRef,
	type DiscordRest,
} from "../discord/api";
import type { DiscordContext } from "../discord/context";
import { DiscordSocket, type DiscordChannel, type DiscordGuildCreate, type DiscordInteraction, type DiscordMessage } from "../discord/socket";
import { COMMANDS_VERSION, erynCommand, handleInteraction, type CommandContext } from "./commands";
import { GatewayClient, SessionClient } from "./client";
import { maybeAnnounceInstall } from "./install";

const WAKE_PATH = "/wake";
const THREAD_PREFIX = "thread:";
const COMMANDS_KEY = "discord:commands";
const MAX_THREAD_NAME = 100;
const DEFAULT_KEEPALIVE_SECONDS = 840;
/** Text that interrupts the running turn when sent in an owned thread. */
const STOP_TEXT = new Set(["stop", "cancel", "!stop", "!cancel", "/stop", "/cancel"]);

function log(message: string): void {
	botLog("gateway", message);
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

export class BotGatewayV3 extends DurableObject<Env> {
	private readonly token: string;
	private readonly rest: DiscordRest;
	private readonly socket: DiscordSocket;
	private readonly keepAliveMs: number;
	private readonly locks = new Map<string, Promise<void>>();
	/** Bot managed-role id per guild, resolved lazily. */
	private readonly roleCache = new Map<string, string>();
	/**
	 * Channels the agent's context needs, by id. Only a thread's parent is ever
	 * looked up here, so this is one request per thread rather than one per
	 * message.
	 */
	private readonly channels = new Map<string, DiscordChannelRef>();
	/** Guild names by id, filled from one listing. */
	private readonly guildNames = new Map<string, string>();

	private botUserId: string | undefined;
	private initialization: Promise<void> | undefined;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.token = env.DISCORD_BOT_TOKEN?.trim() ?? "";
		this.rest = discordRest(this.token);
		this.keepAliveMs = intFromEnv(env.DISCORD_KEEPALIVE_SECONDS, DEFAULT_KEEPALIVE_SECONDS, 60, 3_600) * 1_000;
		this.socket = new DiscordSocket(this.token, log, {
			onMessage: (message) => {
				void this.onMessage(message).catch((error) => log(`message handling failed: ${describeError(error)}`));
			},
			onInteraction: (interaction) => {
				void this.onInteraction(interaction).catch((error) =>
					log(`interaction handling failed: ${describeError(error)}`),
				);
			},
			onGuild: (guild) => {
				void this.onGuild(guild).catch((error) => log(`guild handling failed: ${describeError(error)}`));
			},
			onChannelDelete: (channel) => {
				void this.onChannelDelete(channel).catch((error) =>
					log(`channel deletion handling failed: ${describeError(error)}`),
				);
			},
		});
	}

	/** Keeps the gateway alive and arms the next wake-up. */
	async alarm(): Promise<void> {
		await this.ensureCurrentVersion();
		await this.keepAlive();
	}

	/**
	 * Restart this object when a deploy has moved on.
	 *
	 * A deploy does not restart a live Durable Object: it keeps running the code
	 * it started with, which is why a fix can appear not to have shipped. The
	 * first run stores the version; a later change aborts once, and the next
	 * request starts the object on the current code.
	 */
	private async ensureCurrentVersion(): Promise<void> {
		const version = (this.env as unknown as { CF_VERSION?: { id?: string } }).CF_VERSION?.id;
		if (!version) return;
		const stored = await this.ctx.storage.get<string>("deploy:version");
		if (stored === version) return;
		await this.ctx.storage.put("deploy:version", version);
		if (stored !== undefined) this.ctx.abort();
	}

	async fetch(request: Request): Promise<Response> {
		await this.ensureCurrentVersion();
		const { pathname } = new URL(request.url);
		if (pathname === WAKE_PATH) {
			// `keepAlive` also arms the alarm, so the first wake starts the cycle
			// that reconnects the socket before Cloudflare's 15 minute cap.
			await this.keepAlive();
			return json({ ok: true, connected: this.socket.open });
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
		this.socket.ensure();
	}

	private async registerCommands(applicationId: string): Promise<void> {
		if ((await this.ctx.storage.get<string>(COMMANDS_KEY)) === COMMANDS_VERSION) return;
		await this.rest.overwriteCommands(applicationId, [erynCommand()]);
		await this.ctx.storage.put(COMMANDS_KEY, COMMANDS_VERSION);
		log("registered global commands");
	}

	private async keepAlive(): Promise<void> {
		if (!this.token || this.socket.fatallyClosed) return;
		await this.ctx.storage.setAlarm(Date.now() + this.keepAliveMs);
		await this.ensure();
		if (!this.socket.open) this.socket.ensure();
		else if (this.socket.stale) {
			log("recycling the gateway connection before Cloudflare evicts this object");
			this.socket.recycle();
		}
	}

	// --- Inbound Discord events -------------------------------------------------

	private async onGuild(guild: DiscordGuildCreate): Promise<void> {
		await maybeAnnounceInstall(this.rest, this.ctx.storage, guild, this.botUserId);
	}

	private async onMessage(message: DiscordMessage): Promise<void> {
		if (!this.botUserId) return;
		const guildId = message.guild_id;
		if (guildId === undefined) return;
		if (message.webhook_id !== undefined) return;
		if (message.author?.bot || message.author?.id === this.botUserId) return;

		const channel = await this.rest.channel(message.channel_id);
		if (!channel) return;

		// Discord also creates a managed role named after the bot, and its `@`
		// autocomplete can insert `<@&role>` instead of `<@user>`, so accept both.
		const roleId = await this.botRoleMention(message);

		// A message inside a thread we own goes straight to that thread's session.
		if (THREAD_TYPES.has(channel.type)) {
			if (!(await this.ownsThread(channel.id))) return;
			const text = this.stripMention(message.content ?? "", roleId).trim();
			if (!text) return;
			if (STOP_TEXT.has(text.toLowerCase())) {
				await this.stopThread(guildId, channel.id);
				return;
			}
			if (!(await this.guildReady(guildId))) {
				await this.requireSetup(channel.id);
				return;
			}
			// The agent is told about the channel the request came from, which for a
			// message inside a thread is the thread's parent — the thread is where
			// the reply goes, the parent is the room it belongs to.
			const parent = channel.parent_id ? await this.channelRef(channel.parent_id) : undefined;
			await this.forward(
				guildId,
				channel.id,
				this.threadName(text),
				text,
				message,
				await this.discordContext(guildId, parent, channel),
			);
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
		if (!(await this.guildReady(guildId))) {
			await this.requireSetup(threadId);
			return;
		}
		await this.forward(
			guildId,
			threadId,
			name,
			text,
			message,
			await this.discordContext(guildId, channel, { id: threadId, name }),
		);
	}

	private async onInteraction(interaction: DiscordInteraction): Promise<void> {
		const ctx: CommandContext = {
			env: this.env,
			log: (message) => log(message),
			session: (guildId) => new SessionClient(this.env, guildId),
			gateway: new GatewayClient(this.env),
			ownsThread: (threadId) => this.ownsThread(threadId),
			rest: this.rest,
		};
		await handleInteraction(ctx, interaction);
	}

	/**
	 * A deleted thread can never receive the reply, so a turn still running in it
	 * is cancelled rather than left to finish into nothing, and the record that
	 * says we own the thread goes with it.
	 */
	private async onChannelDelete(channel: DiscordChannel): Promise<void> {
		if (!THREAD_TYPES.has(channel.type ?? 0)) return;
		const guildId = channel.guild_id;
		if (guildId === undefined) return;
		if (!(await this.ownsThread(channel.id))) return;
		await this.stopThread(guildId, channel.id, true).catch((error) =>
			log(`could not stop the turn in deleted thread ${channel.id}: ${describeError(error)}`),
		);
		await this.ctx.storage.delete(THREAD_PREFIX + channel.id);
	}

	// --- Session object plumbing ------------------------------------------------

	/** Whether the guild has connected a provider yet. */
	private async guildReady(guildId: string): Promise<boolean> {
		return await new SessionClient(this.env, guildId)
			.config()
			.then((status) => status.ready)
			.catch(() => false);
	}

	/** Ask a server admin to connect a key before the agent can run. */
	private async requireSetup(threadId: string): Promise<void> {
		await this.rest
			.sendMessage(
				threadId,
				"This server has not connected a provider yet, so I cannot run inference here. A server admin can connect one with `/eryn setup provider`.",
			)
			.catch(() => undefined);
	}

	/**
	 * Forward a prompt to the guild's session object and wait for the turn,
	 * serialised per thread so messages keep their order. The object is named
	 * after the guild, which is the security boundary between servers.
	 */
	private forward(
		guildId: string,
		threadId: string,
		title: string,
		text: string,
		message: DiscordMessage,
		discord: DiscordContext,
	): Promise<void> {
		return this.withLock(threadId, async () => {
			const client = new SessionClient(this.env, guildId);
			try {
				await client.prompt({
					threadId,
					title,
					text,
					author: this.authorName(message),
					discord,
				});
				return;
			} catch (error) {
				log(`session prompt for ${threadId} could not be delivered: ${describeError(error)}`);
			}
			// The session object is gone or refused the turn, so nothing will edit
			// the message it may have left behind. Say so rather than leaving the
			// thread looking like the agent is still thinking.
			await this.rest
				.sendMessage(threadId, "I could not start that turn, so there is nothing to show. Please try again.")
				.catch(() => undefined);
		});
	}

	/**
	 * Cancel a thread's running turn. `gone` marks a thread that no longer
	 * exists, which the session object needs to know: there is nowhere to write
	 * the outcome, so it drops the reply instead of trying to send it.
	 */
	private async stopThread(guildId: string | undefined, threadId: string, gone = false): Promise<void> {
		if (guildId === undefined) return;
		await new SessionClient(this.env, guildId).interrupt(threadId, gone).catch((error) => {
			log(`could not interrupt ${threadId}: ${describeError(error)}`);
		});
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

	/**
	 * The name the speaker goes by in this guild, so the agent knows who it is
	 * answering. Discord's own precedence: server nickname, then display name,
	 * then the handle.
	 */
	private authorName(message: DiscordMessage): string {
		return (
			message.member?.nick?.trim() ||
			message.author?.global_name?.trim() ||
			message.author?.username?.trim() ||
			"someone"
		);
	}

	/**
	 * Describe where the agent was invoked, for the session to store and the
	 * `eryn.discord` plugin to put in front of the model.
	 */
	private async discordContext(
		guildId: string,
		invocation: DiscordChannelRef | undefined,
		thread: { id: string; name?: string },
	): Promise<DiscordContext> {
		const channel = invocation ?? thread;
		const guildName = await this.guildName(guildId);
		return {
			guild: guildName ? { id: guildId, name: guildName } : { id: guildId },
			channel: channel.name ? { id: channel.id, name: channel.name } : { id: channel.id },
			thread: thread.name ? { id: thread.id, name: thread.name } : { id: thread.id },
		};
	}

	/**
	 * A channel or thread, cached: a thread's parent is looked up once, not per
	 * message. Only a real answer is remembered — a lookup that failed is not a
	 * channel that is missing, and the next message should try again.
	 */
	private async channelRef(channelId: string): Promise<DiscordChannelRef | undefined> {
		const cached = this.channels.get(channelId);
		if (cached) return cached;
		const channel = await this.rest.channel(channelId).catch(() => undefined);
		if (channel) this.channels.set(channelId, channel);
		return channel;
	}

	/** A guild's name, from one cached listing. A failed listing is not cached. */
	private async guildName(guildId: string): Promise<string | undefined> {
		const cached = this.guildNames.get(guildId);
		if (cached) return cached;
		const guilds = await this.rest.guilds().catch(() => undefined);
		if (!guilds) return undefined;
		for (const guild of guilds) this.guildNames.set(guild.id, guild.name);
		return this.guildNames.get(guildId);
	}

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
