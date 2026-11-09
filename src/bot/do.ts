/**
 * The bot gateway object.
 *
 * It holds the Discord gateway connections (a singleton named "bot"), one per
 * shard, turns mentions into threads, remembers which threads it owns,
 * dispatches the slash commands, announces fresh installs, and forwards prompts
 * to the per-guild session object. It deliberately hosts no OpenCode work and
 * no database, so it is the only part of the bot that has to stay resident.
 *
 * That residency is unavoidable: Discord needs an outbound gateway WebSocket,
 * and outbound WebSockets cannot hibernate. The per-guild session objects are
 * the ones that should sleep between conversations; this object only keeps the
 * socket and its reconnect alarm alive.
 *
 * Clearing `DISCORD_BOT_TOKEN` stops the gateway entirely (the object returns
 * without connecting), which is the switch for "run nothing at all".
 *
 * The alarm is only a safety net: it re-arms itself, reconnects a dropped
 * socket, and resumes the Discord session before Cloudflare's 15 minute cap.
 */

import { DurableObject } from "cloudflare:workers";
import { Option, Schema } from "effect";

import { CLIENT_ID, INTERACTIONS_PATH, log as botLog, publicOrigin } from "../config";
import { deployRestart } from "../deploy";
import { describeError } from "../errors";
import { json } from "../http";
import { DEFAULT_THREAD_NAME, DiscordError, THREAD_TYPES, discordRest, type DiscordRest } from "../discord/api";
import { renderChannelRenamed, renderThreadCreated } from "../discord/render";
import {
	DiscordSocket,
	type DiscordChannel,
	type DiscordGuildCreate,
	type DiscordInteraction,
	type DiscordMessage,
	type DiscordSocketHandlers,
} from "../discord/socket";
import { DiscordContextSchema, type DiscordContext } from "../session/models";
import { erynCommand, handleInteraction, sameCommands, type CommandContext } from "./commands";
import { SessionClient } from "./client";
import { dismissInstallGreeting, maybeAnnounceInstall } from "./install";
import { DiscordLookups } from "./lookups";
import { attachmentsOf, authorInfo, isBotMessage, isMention, isStopText, mentionInfo, stripMention, threadName } from "./message";

const WAKE_PATH = "/wake";
const INTERACTION_PATH = "/interaction";
const SUBSCRIPTION_PATH = "/subscription";
const MESSAGE_WATCH_PATH = "/message-watch";
const THREAD_PREFIX = "thread:";
const CHANNEL_PREFIX = "channel:";
const WATCH_PREFIX = "watch:";
const RENAME_PREFIX = "rename:";
/**
 * How often the keepalive alarm runs.
 *
 * It has two jobs: recycle the socket before Cloudflare's 15 minute in-memory
 * cap (see `CONNECTION_RECYCLE_MS`), and bring this object back after it is
 * evicted. Both want it short: an evicted object holds no gateway socket, so
 * every interaction Discord sends in the meantime is lost, and Discord reports
 * "The application did not respond". The old 14 minute interval made the
 * recycle race the hard cap and let an eviction go unnoticed for a quarter of
 * an hour; two minutes keeps both windows comfortably small.
 */
const KEEPALIVE_MS = 120_000;

function log(message: string): void {
	botLog("gateway", message);
}

/** A message whose threads the agent asked to be told about. */
interface MessageWatch {
	readonly guildId: string;
	readonly channelId: string;
	readonly messageId: string;
	/** The conversation the agent asked from; the notice is delivered there. */
	readonly notifyThreadId?: string;
	readonly notifyTitle?: string;
	readonly notifyDiscord?: DiscordContext;
}

/** The interaction body the Worker forwards: only the ids the bot needs. */
const InteractionBodySchema = Schema.Struct({
	id: Schema.String,
	token: Schema.String,
});

/** A request to subscribe or unsubscribe a conversation. */
const SubscriptionBodySchema = Schema.Struct({
	kind: Schema.Literals(["thread", "channel"]),
	id: Schema.String,
	subscribed: Schema.Boolean,
});

/** A request to start or stop watching a message for a new thread. */
const MessageWatchBodySchema = Schema.Struct({
	guildId: Schema.String,
	channelId: Schema.String,
	messageId: Schema.String,
	subscribed: Schema.Boolean,
	notifyThreadId: Schema.optional(Schema.String),
	notifyTitle: Schema.optional(Schema.String),
	notifyDiscord: Schema.optional(DiscordContextSchema),
});

/** Decode a JSON body, or `undefined` when it is missing or the wrong shape. */
async function decodeBody<S extends Schema.ConstraintDecoder<unknown>>(
	request: Request,
	schema: S,
): Promise<S["Type"] | undefined> {
	const body = await request.json().catch(() => undefined);
	return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(body));
}

const badRequest = () => json({ error: "bad request" }, 400);

/**
 * A rename an owned conversation has not been told about yet.
 *
 * Renames arrive while the agent is idle, and telling it promptly would mean
 * starting a turn for nothing. The notice waits for the next real message, so
 * the agent learns the old and new names in the turn that already runs.
 */
interface RenameNotice {
	readonly id: string;
	readonly kind: "thread" | "channel";
	readonly name: string;
	readonly previousName?: string;
}

export class BotGatewayV5 extends DurableObject<Env> {
	private readonly token: string;
	private readonly rest: DiscordRest;
	/**
	 * The gateway connections, one per shard. Undefined until the shard count is
	 * known, which takes a Discord call, so it is built during initialization
	 * rather than in the constructor.
	 */
	private gateway: DiscordSocket | undefined;
	private readonly lookups: DiscordLookups;
	private readonly keepAliveMs = KEEPALIVE_MS;
	private readonly locks = new Map<string, Promise<void>>();

	private botUserId: string | undefined;
	private initialization: Promise<void> | undefined;
	/**
	 * Whether this instance has seen a newer deploy. Deliberately not persisted:
	 * an abort discards storage writes, so a marker would outlive the restart and
	 * restart every replacement instance.
	 */
	private restartPending = false;
	/**
	 * Socket work in progress. A message handler can be waiting on a whole
	 * agent turn, so a deploy restart waits for it rather than cutting the turn
	 * off before the reply exists.
	 */
	private active = 0;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.token = env.DISCORD_BOT_TOKEN?.trim() ?? "";
		this.rest = discordRest(this.token);
		this.lookups = new DiscordLookups(this.rest);
		// A fresh instance — after a deploy reset or an eviction — has no socket.
		// Connect and arm the keepalive alarm before the first request, so the bot
		// comes back on its own and is not evicted before the next cron wake.
		state.blockConcurrencyWhile(() => this.keepAlive());
	}

	/** The events the gateway passes on, counted so a restart can wait for them. */
	private readonly socketHandlers: DiscordSocketHandlers = {
		onMessage: (message) => this.track(() => this.onMessage(message), "message handling failed"),
		onInteraction: (interaction) =>
			this.track(() => this.onInteraction(interaction), "interaction handling failed"),
		onGuild: (guild) => this.track(() => this.onGuild(guild), "guild handling failed"),
		onGuildUpdate: (guild) =>
			this.track(() => this.onGuildUpdate(guild), "guild update handling failed"),
		onThreadCreate: (thread) =>
			this.track(() => this.onThreadCreate(thread), "thread creation handling failed"),
		onChannelUpdate: (channel) =>
			this.track(() => this.onChannelUpdate(channel), "channel update handling failed"),
		onChannelDelete: (channel) =>
			this.track(() => this.onChannelDelete(channel), "channel deletion handling failed"),
	};

	/** Run one socket handler, counting it so a restart can wait for it. */
	private track(run: () => Promise<void>, failure: string): void {
		this.active += 1;
		void run()
			.catch((error) => log(`${failure}: ${describeError(error)}`))
			.finally(() => {
				this.active -= 1;
			});
	}

	/** Keeps the gateway alive and arms the next wake-up. */
	async alarm(): Promise<void> {
		// A deploy moved on while this instance was alive: reset into the new
		// code. The signal is in memory on purpose — the abort discards the
		// event's storage writes, so a persisted marker would survive the restart
		// and make every new instance restart again.
		if (this.restartPending) {
			if (this.active > 0) {
				// A message or interaction is still being handled. Restarting now
				// would drop it, so check again once it has finished.
				await this.ctx.storage.setAlarm(Date.now() + 5_000);
				return;
			}
			// Retry this alarm on the replacement instance: it starts with no
			// timers, and re-running the keepalive is what reconnects the socket
			// straight after a deploy. Cancelling it (retryAlarm: false) leaves a
			// silent object that only an external poke can revive.
			this.ctx.abort("deploy changed");
			return;
		}
		await this.keepAlive();
	}

	/**
	 * Restart this object when a deploy has moved on.
	 *
	 * A deploy does not restart a live Durable Object: it keeps running the code
	 * it started with, and its own `versionMetadata()` keeps reporting that
	 * deploy. So the caller says which deploy is current on every request; when
	 * that changes, schedule an alarm a moment out so the restart happens after
	 * this request has finished.
	 */
	private async ensureCurrentVersion(request: Request): Promise<void> {
		if (await deployRestart(this.ctx.storage, request, this.env)) this.restartPending = true;
	}

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (pathname === INTERACTION_PATH) {
			await this.ensureCurrentVersion(request);
			if (request.method !== "POST") return json({ error: "not found" }, 404);
			const body = await request.json().catch(() => undefined);
			if (!Schema.is(InteractionBodySchema)(body)) return badRequest();
			// The Worker already answered Discord with a 202, so this handler still
			// acknowledges through the interaction callback endpoint. The payload is
			// passed on untouched; only the ids the bot needs are checked here.
			await this.onInteraction(body as DiscordInteraction);
			return json({ ok: true });
		}
		if (pathname === SUBSCRIPTION_PATH) {
			await this.ensureCurrentVersion(request);
			if (request.method !== "POST") return json({ error: "not found" }, 404);
			const body = await decodeBody(request, SubscriptionBodySchema);
			if (!body) return badRequest();
			const key = (body.kind === "thread" ? THREAD_PREFIX : CHANNEL_PREFIX) + body.id;
			if (body.subscribed) await this.ctx.storage.put(key, true);
			else await this.ctx.storage.delete(key);
			return json({ ok: true });
		}
		if (pathname === MESSAGE_WATCH_PATH) {
			await this.ensureCurrentVersion(request);
			if (request.method !== "POST") return json({ error: "not found" }, 404);
			const body = await decodeBody(request, MessageWatchBodySchema);
			if (!body) return badRequest();
			const key = WATCH_PREFIX + body.messageId;
			if (!body.subscribed) {
				await this.ctx.storage.delete(key);
				return json({ ok: true });
			}
			const watch: MessageWatch = {
				guildId: body.guildId,
				channelId: body.channelId,
				messageId: body.messageId,
				...(body.notifyThreadId !== undefined ? { notifyThreadId: body.notifyThreadId } : {}),
				...(body.notifyTitle !== undefined ? { notifyTitle: body.notifyTitle } : {}),
				...(body.notifyDiscord !== undefined ? { notifyDiscord: body.notifyDiscord } : {}),
			};
			await this.ctx.storage.put(key, watch);
			return json({ ok: true });
		}
		if (pathname === WAKE_PATH) {
			// `keepAlive` also arms the alarm, so the first wake starts the cycle
			// that reconnects the socket before Cloudflare's 15 minute cap.
			await this.keepAlive();
			// Arm the restart *after* keepAlive: the keepalive alarm is the long
			// one, and setting it last would replace the one-second restart alarm.
			await this.ensureCurrentVersion(request);
			const deploy = await this.ctx.storage.get<string>("deploy:version");
			return json({
				ok: true,
				connected: this.gateway?.open ?? false,
				shards: this.gateway?.status ?? { total: 0, open: 0 },
				deploy: deploy ?? null,
				restart: this.restartPending,
			});
		}
		await this.ensureCurrentVersion(request);
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
		await this.syncCommands(me.id);
		await this.syncInteractionsEndpoint();
		await this.connectGateway();
	}

	/**
	 * Open the gateway, one connection per shard.
	 *
	 * Discord requires a shard for every 2,500 guilds and reports how many it
	 * recommends for this bot. The count is remembered so a transient failure to
	 * read it still builds the same set; nothing ever guesses, because too few
	 * shards makes Discord refuse the session outright.
	 */
	private async connectGateway(): Promise<void> {
		if (this.gateway) {
			this.gateway.ensure();
			return;
		}
		const stored = await this.ctx.storage.get<number>("gateway:shards").catch(() => undefined);
		const recommended = await this.rest.gatewayShards().catch((error) => {
			log(`could not read the recommended shard count: ${describeError(error)}`);
			return undefined;
		});
		// Never guess: connecting with too few shards makes Discord refuse the
		// session, and it is worse at scale than retrying the read a moment later.
		const shards = recommended ?? stored;
		if (shards === undefined) throw new Error("Discord's shard count is not known yet");
		if (recommended !== undefined && recommended !== stored) {
			await this.ctx.storage.put("gateway:shards", recommended).catch((error) => {
				log(`could not remember the shard count: ${describeError(error)}`);
			});
		}
		if (shards > 1) log(`opening ${shards} gateway shards`);
		this.gateway = new DiscordSocket(this.token, log, this.socketHandlers, shards);
		this.gateway.ensure();
	}

	/**
	 * Point Discord at the Worker's HTTP interactions route.
	 *
	 * An interaction delivered over the gateway depends on this object holding a
	 * live socket, so a restart leaves the bot unable to answer a slash command
	 * at all. Once the endpoint is set, Discord POSTs each interaction to the
	 * Worker, which forwards it here and answers even while the socket is
	 * reconnecting.
	 *
	 * Discord verifies the URL with a signed PING before it accepts the setting,
	 * so a failed attempt leaves gateway delivery in place; the next start tries
	 * again.
	 */
	private async syncInteractionsEndpoint(): Promise<void> {
		const url = `${publicOrigin(this.env)}${INTERACTIONS_PATH}`;
		const current = await this.rest.interactionsEndpoint().catch((error) => {
			log(`could not read the interactions endpoint: ${describeError(error)}`);
			return undefined;
		});
		if (current === url) return;
		try {
			await this.rest.setInteractionsEndpoint(url);
			log(`interactions are now delivered to ${url}`);
		} catch (error) {
			log(`could not switch interactions to ${url}, keeping the gateway: ${describeError(error)}`);
		}
	}

	/**
	 * Make Discord's copy of the commands match this build.
	 *
	 * Compared against what Discord actually holds rather than a version marker,
	 * so a restart with unchanged commands writes nothing: every write bumps the
	 * command version, and a client holding the previous copy then refuses the
	 * command with "This command is outdated".
	 */
	private async syncCommands(applicationId: string): Promise<void> {
		const desired = [erynCommand()];
		const registered = await this.rest.listCommands(applicationId).catch(() => undefined);
		if (registered && sameCommands(registered, desired)) return;
		await this.rest.overwriteCommands(applicationId, desired);
		log(registered ? "updated the global commands" : "registered the global commands");
	}

	private async keepAlive(): Promise<void> {
		if (!this.token || this.gateway?.fatallyClosed) return;
		if (this.gateway?.reshardRequired) {
			// Discord rejected this layout (too few shards, or an invalid index).
			// Rebuild in place from its current recommendation rather than retrying
			// the same wrong count forever.
			log("the gateway rejected its shard layout; rebuilding with Discord's current recommendation");
			this.gateway.stop();
			this.gateway = undefined;
			await this.ctx.storage.delete("gateway:shards").catch(() => undefined);
			await this.connectGateway().catch((error) => log(`could not rebuild the gateway: ${describeError(error)}`));
		}
		// A pending restart owns the alarm; replacing it with the keepalive would
		// postpone the restart for a whole cycle. A closed gateway gets a short
		// retry so a failed first connect does not wait for the long interval.
		if (!this.restartPending) {
			const delay = this.gateway?.open ? this.keepAliveMs : Math.min(this.keepAliveMs, 10_000);
			await this.ctx.storage.setAlarm(Date.now() + delay);
		}
		await this.ensure();
		if (!this.gateway) return;
		if (!this.gateway.open) this.gateway.ensure();
		else if (this.gateway.stale) {
			log("recycling the gateway connections before Cloudflare evicts this object");
			this.gateway.recycle();
		}
	}

	// --- Inbound Discord events -------------------------------------------------

	private async onGuild(guild: DiscordGuildCreate): Promise<void> {
		await maybeAnnounceInstall(this.rest, this.ctx.storage, guild, this.botUserId);
	}

	/** A guild rename only has to reach the next context build. */
	private async onGuildUpdate(guild: DiscordGuildCreate): Promise<void> {
		if (guild.name) this.lookups.rememberGuild(guild.id, guild.name);
	}

	private async onMessage(message: DiscordMessage): Promise<void> {
		if (!this.botUserId) return;
		const guildId = message.guild_id;
		if (guildId === undefined) return;
		if (isBotMessage(message, this.botUserId)) return;

		const channel = await this.lookups.channel(message.channel_id);
		if (!channel) return;

		// Discord also creates a managed role named after the bot, and its `@`
		// autocomplete can insert `<@&role>` instead of `<@user>`, so accept both.
		const roleId = await this.lookups.botRoleMention(message, this.botUserId);

		// A message inside a thread we own goes straight to that thread's session.
		if (THREAD_TYPES.has(channel.type)) {
			if (!(await this.ownsThread(channel.id))) return;
			// The agent is told about the channel the request came from, which for a
			// message inside a thread is the thread's parent — the thread is where
			// the reply goes, the parent is the room it belongs to.
			const parent = channel.parent_id ? await this.lookups.channel(channel.parent_id) : undefined;
			await this.handleOwned(
				guildId,
				channel,
				message,
				roleId,
				await this.lookups.context(guildId, parent, channel),
			);
			return;
		}

		// A message in a subscribed channel is a request too, even without a
		// mention; the reply lands in the channel rather than in a new thread.
		if (await this.ownsChannel(channel.id)) {
			await this.handleOwned(
				guildId,
				channel,
				message,
				roleId,
				await this.lookups.context(guildId, channel, { id: channel.id, name: channel.name }, "channel"),
			);
			return;
		}

		// Otherwise require an explicit mention and open a thread for the request.
		if (!isMention(message, this.botUserId, roleId)) return;

		const text = stripMention(message.content ?? "", this.botUserId, roleId);
		const name = threadName(text);
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
		if (!text && attachmentsOf(message).length === 0) {
			await this.rest.sendMessage(threadId, "What would you like me to do?").catch(() => undefined);
			return;
		}
		if ((await this.guildReady(guildId)) === false) {
			await this.requireSetup(threadId);
			return;
		}
		await this.forward(
			guildId,
			threadId,
			name,
			text,
			message,
			await this.lookups.context(guildId, channel, { id: threadId, name }),
			await this.takeRenameNotice(threadId),
		);
	}

	/**
	 * A thread was created. A thread made from a message shares that message's
	 * id, so a watch stored under the message id is found from the thread id.
	 * The thread is joined and subscribed, then the agent is told its id in the
	 * conversation that asked for the watch.
	 */
	private async onThreadCreate(thread: DiscordChannel): Promise<void> {
		const guildId = thread.guild_id;
		if (guildId === undefined) return;
		// Keep the creation payload, so a rename that follows has a name to
		// compare against.
		this.lookups.remember(thread);
		const watch = await this.ctx.storage.get<MessageWatch>(WATCH_PREFIX + thread.id);
		if (!watch || watch.guildId !== guildId) return;
		// A thread made from a message can only live in that message's channel.
		if (thread.parent_id !== undefined && thread.parent_id !== watch.channelId) {
			log(`watched message ${watch.messageId} grew a thread in ${thread.parent_id}, not ${watch.channelId}`);
			return;
		}
		// A duplicate event, or a thread this bot already owns, has been handled
		// before; only a fresh thread needs a notice.
		if (await this.ownsThread(thread.id)) return;

		await this.rest.joinThread(thread.id).catch((error) => {
			log(`could not join new thread ${thread.id}: ${describeError(error)}`);
		});
		await this.ctx.storage.put(THREAD_PREFIX + thread.id, true);

		const notifyThreadId = watch.notifyThreadId;
		if (!notifyThreadId) return;
		const text = renderThreadCreated(thread, watch.messageId);
		await this.withLock(notifyThreadId, async () => {
			try {
				await this.session(watch.guildId).prompt({
					threadId: notifyThreadId,
					title: watch.notifyTitle ?? DEFAULT_THREAD_NAME,
					text,
					...(watch.notifyDiscord ? { discord: watch.notifyDiscord } : {}),
				});
			} catch (error) {
				log(
					`could not tell ${notifyThreadId} that thread ${thread.id} was created: ${describeError(error)}`,
				);
			}
		});
	}

	private async onInteraction(interaction: DiscordInteraction): Promise<void> {
		const ctx: CommandContext = {
			env: this.env,
			log,
			applicationId: this.botUserId ?? CLIENT_ID,
			session: (guildId) => this.session(guildId),
			ownsConversation: async (channelId) =>
				(await this.ownsThread(channelId)) || (await this.ownsChannel(channelId)),
			dismissGreeting: (guildId) => dismissInstallGreeting(this.rest, this.ctx.storage, guildId),
			rest: this.rest,
		};
		await handleInteraction(ctx, interaction);
	}

	/**
	 * A channel or thread was updated, usually because it was renamed.
	 *
	 * The payload itself is the freshest lookup, so the next message carries
	 * the new name with no REST round-trip. When the renamed conversation is
	 * one Eryn owns, the session's stored context is corrected too: the agent
	 * was told the old name in its system prompt, and nothing else would ever
	 * correct it. A notice is left for the next message so the agent knows a
	 * rename happened without spending a whole turn on it.
	 */
	private async onChannelUpdate(channel: DiscordChannel): Promise<void> {
		const guildId = channel.guild_id;
		const previous = this.lookups.cached(channel.id)?.name;
		const ref = this.lookups.remember(channel);
		if (guildId === undefined || !ref?.name || previous === undefined || previous === ref.name) return;

		const isThread = THREAD_TYPES.has(ref.type);
		if (!(await this.owns(ref))) return;

		const kind = isThread ? "thread" : "channel";
		await this.ctx.storage.put<RenameNotice>(RENAME_PREFIX + ref.id, {
			id: ref.id,
			kind,
			name: ref.name,
			previousName: previous,
		});
		const parent = ref.parent_id ? await this.lookups.channel(ref.parent_id) : undefined;
		const discord = await this.lookups.context(guildId, parent, { id: ref.id, name: ref.name }, kind);
		await this.session(guildId)
			.updateContext(ref.id, discord)
			.catch((error) => log(`could not record the rename of ${ref.id}: ${describeError(error)}`));
	}

	/**
	 * A deleted thread or channel can never receive the reply, so a turn still
	 * running in it is cancelled rather than left to finish into nothing, and
	 * the record that says we own the conversation goes with it. The session
	 * object also deletes the conversation's schedules and session, so nothing
	 * wakes later to run a turn for a conversation nobody can see.
	 */
	private async onChannelDelete(channel: DiscordChannel): Promise<void> {
		const guildId = channel.guild_id;
		if (guildId === undefined) return;
		const isThread = THREAD_TYPES.has(channel.type ?? 0);
		if (!(await this.owns(channel))) return;
		await this.stopThread(guildId, channel.id, true).catch((error) =>
			log(`could not stop the turn in deleted ${isThread ? "thread" : "channel"} ${channel.id}: ${describeError(error)}`),
		);
		await this.ctx.storage.delete((isThread ? THREAD_PREFIX : CHANNEL_PREFIX) + channel.id);
		// The conversation is gone, so a rename it never received is moot.
		await this.ctx.storage.delete(RENAME_PREFIX + channel.id);
	}

	// --- Session object plumbing ------------------------------------------------

	/** The guild's own session object, which is the security boundary between servers. */
	private session(guildId: string): SessionClient {
		return new SessionClient(this.env, guildId);
	}

	/**
	 * Whether the guild has connected a provider yet.
	 *
	 * `undefined` means the session could not be asked — it was restarting,
	 * evicted, or answered badly. That is not the same as "no provider", so it
	 * must not be turned into setup advice.
	 */
	private async guildReady(guildId: string): Promise<boolean | undefined> {
		try {
			return (await this.session(guildId).config()).ready;
		} catch (error) {
			log(`could not read whether guild ${guildId} has a provider: ${describeError(error)}`);
			return undefined;
		}
	}

	/** Ask a server admin to connect a key before the agent can run. */
	private async requireSetup(threadId: string): Promise<void> {
		await this.rest
			.sendMessage(
				threadId,
				"This server has not connected a provider yet, so I cannot run inference here. A server admin can connect one from `/eryn setup` with **Connect provider**.",
			)
			.catch(() => undefined);
	}

	/**
	 * Handle a message in a conversation Eryn owns, whether a thread or a
	 * subscribed channel. Both forms read the request, honour stop words, and
	 * forward it to the same session.
	 */
	private async handleOwned(
		guildId: string,
		channel: DiscordChannel,
		message: DiscordMessage,
		roleId: string | undefined,
		context: DiscordContext,
	): Promise<void> {
		const text = stripMention(message.content ?? "", this.botUserId, roleId);
		if (!text && attachmentsOf(message).length === 0) return;
		if (isStopText(text)) {
			await this.stopThread(guildId, channel.id);
			return;
		}
		if ((await this.guildReady(guildId)) === false) {
			await this.requireSetup(channel.id);
			return;
		}
		await this.forward(
			guildId,
			channel.id,
			threadName(text),
			text,
			message,
			context,
			await this.takeRenameNotice(channel.id),
		);
	}

	/**
	 * Forward a prompt to the guild's session object and wait for the turn,
	 * serialised per thread so messages keep their order.
	 */
	private forward(
		guildId: string,
		threadId: string,
		title: string,
		text: string,
		message: DiscordMessage,
		discord: DiscordContext,
		notice?: string,
	): Promise<void> {
		return this.withLock(threadId, async () => {
			const client = this.session(guildId);
			try {
				await client.prompt({
					threadId,
					title,
					text,
					author: authorInfo(message),
					mentions: mentionInfo(message, this.botUserId),
					discord,
					...(notice ? { notice } : {}),
					attachments: attachmentsOf(message),
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
	 * Take the rename notice a conversation is owed, if any.
	 *
	 * Read at prompt time rather than delivered on the event: starting a turn
	 * just to say a name changed would spend tokens and could make the agent
	 * post a reply nobody asked for. The next real message carries it instead.
	 */
	private async takeRenameNotice(channelId: string): Promise<string | undefined> {
		const notice = await this.ctx.storage.get<RenameNotice>(RENAME_PREFIX + channelId);
		if (!notice) return undefined;
		await this.ctx.storage.delete(RENAME_PREFIX + channelId);
		return renderChannelRenamed(notice);
	}

	/**
	 * Cancel a thread's running turn. `gone` marks a thread that no longer
	 * exists, which the session object needs to know: there is nowhere to write
	 * the outcome, so it drops the reply instead of trying to send it.
	 */
	private async stopThread(guildId: string | undefined, threadId: string, gone = false): Promise<void> {
		if (guildId === undefined) return;
		await this.session(guildId).interrupt(threadId, gone).catch((error) => {
			log(`could not interrupt ${threadId}: ${describeError(error)}`);
		});
	}

	/** Whether Eryn owns this conversation, which may be a thread or a channel. */
	private owns(channel: { id: string; type?: number }): Promise<boolean> {
		return THREAD_TYPES.has(channel.type ?? 0) ? this.ownsThread(channel.id) : this.ownsChannel(channel.id);
	}

	private ownsThread(threadId: string): Promise<boolean> {
		return this.ctx.storage.get<boolean>(THREAD_PREFIX + threadId).then((value) => value === true);
	}

	private ownsChannel(channelId: string): Promise<boolean> {
		return this.ctx.storage.get<boolean>(CHANNEL_PREFIX + channelId).then((value) => value === true);
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
