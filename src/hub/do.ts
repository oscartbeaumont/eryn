/**
 * The messaging data plane.
 *
 * Hub is the only object that knows how a conversation is addressed. It stores
 * provider configuration, channel bindings, and a replayable event log, and it
 * serves the MCP event stream the agent subscribes to. It never builds an
 * OpenCode host, so a tool call cannot re-enter the object that is waiting on
 * it.
 */

import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";

import { capture } from "../analytics.ts";
import type { AnalyticsValue } from "../analytics.ts";
import { KEYS, log, optional } from "../config.ts";
import { deployRestart } from "../deploy.ts";
import { cursor as newCursor } from "../core/ids.ts";
import { body, failure, json } from "../core/http.ts";
import {
	BindChannelRequestSchema,
	ChannelBindingSchema,
	HistoryRequestSchema,
	HistoryResponseSchema,
	IngestRequestSchema,
	InboundMessageSchema,
	MessagingConfigSchema,
	RememberSessionSchema,
	SendMessageRequestSchema,
	SendMessageResponseSchema,
	UnbindChannelRequestSchema,
} from "../core/schema.ts";
import type { Attachment, ChannelBinding, InboundMessage, MessagingConfig } from "../core/schema.ts";
import { recordStore } from "../core/store.ts";
import {
	PrincipalRecordSchema,
	ServerPolicySchema,
	canUseChannel,
	defaultPolicy,
	ownerPermissions,
	permissionsFor,
} from "../core/policy.ts";
import type { PrincipalRecord, ServerPolicy } from "../core/policy.ts";
import type { RecordStore } from "../core/store.ts";
import { discordRest } from "../discord/api.ts";
import { discordProvider } from "../providers/discord.ts";
import { imessageProvider } from "../providers/imessage.ts";
import type { MessagingProvider } from "../providers/types.ts";
import { classifyError, describeError } from "../errors.ts";
import { toJsonObject, stringField } from "../json.ts";

/** A frame on the raw SSE stream Hub serves to the Worker's MCP route. */
type Frame =
	| { type: "active"; cursor: string | null; truncated: boolean }
	| { type: "event"; eventId: string; name: string; timestamp: string; data: unknown; cursor: string }
	| { type: "heartbeat"; cursor: string | null };

interface RecordedEvent {
	readonly cursor: string;
	readonly eventId: string;
	readonly name: string;
	readonly timestamp: string;
	readonly data: unknown;
}

interface DiscordCapabilities {
	read: boolean;
	send: boolean;
	react: boolean;
	manage: boolean;
	createThread: boolean;
	sendInThreads: boolean;
}

interface ChannelListBody {
	channels: ChannelBinding[];
	sessionChannel?: string;
}

interface Subscriber {
	readonly channel: string | undefined;
	readonly write: (frame: Frame) => void;
	ready: boolean;
	pending: Frame[];
}

/** How long a message is kept for replay. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const HEARTBEAT_MS = 20_000;

const encoder = new TextEncoder();

function frameText(frame: Frame): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
}

export class Hub extends DurableObject<Env> {
	private readonly serverId: string;
	private readonly store: RecordStore;
	private readonly subscribers = new Set<Subscriber>();
	private restartPending = false;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.serverId = state.id.name ?? "";
		this.store = recordStore(state.storage, env.ENCRYPTION_KEY);
		state.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS event (
				seq INTEGER PRIMARY KEY AUTOINCREMENT,
				cursor TEXT NOT NULL UNIQUE,
				channel TEXT NOT NULL,
				payload TEXT NOT NULL,
				created INTEGER NOT NULL
			)`,
		);
		state.storage.sql.exec("CREATE INDEX IF NOT EXISTS event_channel ON event (channel, seq)");
		void state.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
	}

	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;

		try {
			if (path === "/events") return this.events(request);
			if (path === "/ingest" && request.method === "POST") return await this.ingest(request);
			if (path === "/send" && request.method === "POST") return await this.send(request);
			if (path === "/history" && request.method === "POST") return await this.history(request);
			if (path === "/bind" && request.method === "POST") return await this.bind(request);
			if (path === "/unbind" && request.method === "POST") return await this.unbind(request);
			if (path === "/channels" && request.method === "POST") return await this.channels(request);
			if (path === "/messaging" && request.method === "POST") return await this.putMessaging(request);
			if (path === "/messaging/status" && request.method === "POST") return await this.messagingStatus();
			if (path === "/remember-session" && request.method === "POST") return await this.rememberSession(request);
			if (path === "/policy" && request.method === "POST") return await this.putPolicy(request);
			if (path === "/context" && request.method === "POST") return await this.context(request);
			if (path === "/thread" && request.method === "POST") return await this.startThread(request);
			if (path === "/threads" && request.method === "POST") return await this.listThreads(request);
			if (path === "/react" && request.method === "POST") return await this.react(request);
			if (path === "/edit" && request.method === "POST") return await this.edit(request);
			if (path === "/delete" && request.method === "POST") return await this.removeMessage(request);
			if (path === "/pin" && request.method === "POST") return await this.pin(request);
			if (path === "/join" && request.method === "POST") return await this.join(request);
			if (path === "/guild/channels" && request.method === "POST") return await this.guildChannels(request);
			if (path === "/thread/archive" && request.method === "POST") return await this.threadAction(request, "archive");
			if (path === "/thread/join" && request.method === "POST") return await this.threadAction(request, "join");
			if (path === "/thread/leave" && request.method === "POST") return await this.threadAction(request, "leave");
			if (path === "/leave" && request.method === "POST") return await this.leave(request);
			return failure("Not found.", 404);
		} catch (error) {
			log("hub", `route ${path} failed: ${describeError(error)}`);

			return failure("The messaging hub could not answer.", 500);
		} finally {
			if (await deployRestart(this.ctx.storage, request, this.env)) this.restartPending = true;
		}
	}

	// --- Channels -------------------------------------------------------------

	/** Coarse product analytics for this server; never blocks the request. */
	private track(event: string, properties: Record<string, AnalyticsValue> = {}): void {
		this.ctx.waitUntil(capture(this.env, event, properties, { serverId: this.serverId }));
	}

	private channelKey(externalId: string): string {
		return KEYS.channel + externalId;
	}

	private async binding(externalId: string): Promise<ChannelBinding | undefined> {
		return await this.store.plain(this.channelKey(externalId), ChannelBindingSchema);
	}

	private async putBinding(binding: ChannelBinding): Promise<void> {
		await this.store.putPlain(this.channelKey(binding.externalId), ChannelBindingSchema, binding);
	}

	/** Start a Discord thread and bind it as a conversation. */
	private async startThread(request: Request): Promise<Response> {
		const input = await body(request, Schema.Struct({ channel: Schema.optional(Schema.String), title: Schema.String }));

		if (input instanceof Response) return input;
		const sessionChannel = await this.sessionChannel(request.headers.get("x-eryn-session") ?? undefined);
		const channel = input.channel || sessionChannel || "";
		const binding = channel ? await this.binding(channel) : undefined;

		if (!binding || binding.provider !== "discord") {
			return json({ ok: false, error: "Threads are only available on Discord conversations." });
		}

		try {
			const rest = discordRest(optional(this.env, "DISCORD_BOT_TOKEN") ?? "");
			const thread = await rest.startThread(binding.externalId, input.title.trim().slice(0, 100) || "Eryn");

			await this.putBinding({
				id: thread.id,
				provider: "discord",
				externalId: thread.id,
				name: input.title.trim().slice(0, 100) || "Eryn",
				containerId: binding.containerId,
				source: "thread",
				enabled: true,
				createdAt: Date.now(),
			});
			this.track("thread_created", { provider: "discord" });

			return json({ ok: true, channelId: thread.id });
		} catch (error) {
			return json({ ok: false, error: describeError(error) });
		}
	}

	private discord() {
		return discordRest(optional(this.env, "DISCORD_BOT_TOKEN") ?? "");
	}

	private async listThreads(request: Request): Promise<Response> {
		const input = await body(request, Schema.Struct({ channel: Schema.optional(Schema.String) }));

		if (input instanceof Response) return input;
		const sessionChannel = await this.sessionChannel(request.headers.get("x-eryn-session") ?? undefined);
		const channel = input.channel || sessionChannel || "";
		const binding = channel ? await this.binding(channel) : undefined;

		if (!binding || binding.provider !== "discord" || !binding.containerId) {
			return json({ ok: false, error: "Threads are only available on Discord conversations." });
		}

		try {
			const threads = await this.discord().activeThreads(binding.containerId);

			return json({
				ok: true,
				threads: threads.map((thread) => ({ id: thread.id, name: thread.name })),
			});
		} catch (error) {
			return json({ ok: false, error: describeError(error) });
		}
	}

	private async reactionTarget(request: Request) {
		const input = await body(
			request,
			Schema.Struct({
				channel: Schema.optional(Schema.String),
				messageId: Schema.String,
				emoji: Schema.String,
			}),
		);

		if (input instanceof Response) return input;
		const sessionChannel = await this.sessionChannel(request.headers.get("x-eryn-session") ?? undefined);
		const channel = input.channel || sessionChannel || "";
		const binding = channel ? await this.binding(channel) : undefined;

		return { input, binding };
	}

	private async react(request: Request): Promise<Response> {
		const target = await this.reactionTarget(request);

		if (target instanceof Response) return target;

		if (!target.binding || target.binding.provider !== "discord") {
			return json({ ok: false, error: "Reactions are only available on Discord conversations." });
		}

		try {
			await this.discord().addReaction(target.binding.externalId, target.input.messageId, target.input.emoji);

			return json({ ok: true });
		} catch (error) {
			return json({ ok: false, error: describeError(error) });
		}
	}

	private async edit(request: Request): Promise<Response> {
		const input = await body(
			request,
			Schema.Struct({
				channel: Schema.optional(Schema.String),
				messageId: Schema.String,
				text: Schema.String,
			}),
		);

		if (input instanceof Response) return input;
		const sessionChannel = await this.sessionChannel(request.headers.get("x-eryn-session") ?? undefined);
		const channel = input.channel || sessionChannel || "";
		const binding = channel ? await this.binding(channel) : undefined;

		if (!binding || binding.provider !== "discord") {
			return json({ ok: false, error: "Editing is only available on Discord conversations." });
		}

		try {
			await this.discord().editMessage(binding.externalId, input.messageId, input.text);

			return json({ ok: true });
		} catch (error) {
			return json({ ok: false, error: describeError(error) });
		}
	}

	private async removeMessage(request: Request): Promise<Response> {
		const input = await body(
			request,
			Schema.Struct({ channel: Schema.optional(Schema.String), messageId: Schema.String }),
		);

		if (input instanceof Response) return input;
		const sessionChannel = await this.sessionChannel(request.headers.get("x-eryn-session") ?? undefined);
		const channel = input.channel || sessionChannel || "";
		const binding = channel ? await this.binding(channel) : undefined;

		if (!binding || binding.provider !== "discord") {
			return json({ ok: false, error: "Deleting is only available on Discord conversations." });
		}

		try {
			await this.discord().deleteMessage(binding.externalId, input.messageId);

			return json({ ok: true });
		} catch (error) {
			return json({ ok: false, error: describeError(error) });
		}
	}

	private async pin(request: Request): Promise<Response> {
		const input = await body(
			request,
			Schema.Struct({ channel: Schema.optional(Schema.String), messageId: Schema.String }),
		);

		if (input instanceof Response) return input;
		const sessionChannel = await this.sessionChannel(request.headers.get("x-eryn-session") ?? undefined);
		const channel = input.channel || sessionChannel || "";
		const binding = channel ? await this.binding(channel) : undefined;

		if (!binding || binding.provider !== "discord") {
			return json({ ok: false, error: "Pinning is only available on Discord conversations." });
		}

		try {
			await this.discord().pinMessage(binding.externalId, input.messageId);

			return json({ ok: true });
		} catch (error) {
			return json({ ok: false, error: describeError(error) });
		}
	}

	private async guildChannels(request: Request): Promise<Response> {
		const input = await body(request, Schema.Struct({ channel: Schema.optional(Schema.String) }));

		if (input instanceof Response) return input;
		const sessionChannel = await this.sessionChannel(request.headers.get("x-eryn-session") ?? undefined);
		const channel = input.channel || sessionChannel || "";
		const binding = channel ? await this.binding(channel) : undefined;

		if (!binding || binding.provider !== "discord" || !binding.containerId) {
			return json({ ok: false, error: "Channels are only available on Discord conversations." });
		}

		try {
			const channels = await this.discord().guildChannels(binding.containerId);
			const speaker = sessionChannel ? await this.principal(sessionChannel) : undefined;
			const visible = await Promise.all(
				channels
					.filter((entry) => (entry.type ?? 0) === 0 || (entry.type ?? 0) === 5)
					.map(async (entry) => {
						if (!speaker) return undefined;
						const capabilities = await this.capabilities(
							binding.containerId as string,
							speaker.authorId,
							entry.id,
						);

						return capabilities?.read ? entry : undefined;
					}),
			);

			return json({
				ok: true,
				channels: visible
					.filter((entry) => entry !== undefined)
					.map((entry) => ({ id: entry.id, name: entry.name, type: entry.type })),
			});
		} catch (error) {
			return json({ ok: false, error: describeError(error) });
		}
	}

	private async threadAction(request: Request, action: "archive" | "join" | "leave"): Promise<Response> {
		const input = await body(request, Schema.Struct({ threadId: Schema.String }));

		if (input instanceof Response) return input;

		try {
			if (action === "archive") await this.discord().setThreadArchived(input.threadId, true);
			else if (action === "join") await this.discord().joinThread(input.threadId);
			else await this.discord().leaveThread(input.threadId);

			return json({ ok: true });
		} catch (error) {
			return json({ ok: false, error: describeError(error) });
		}
	}

	private async join(request: Request): Promise<Response> {
		const input = await body(request, Schema.Struct({ channel: Schema.String }));

		if (input instanceof Response) return input;
		const sessionChannel = await this.sessionChannel(request.headers.get("x-eryn-session") ?? undefined);
		const speaker = sessionChannel ? await this.principal(sessionChannel) : undefined;
		const rest = this.discord();

		try {
			const channel = await rest.channel(input.channel);

			if (!channel) return json({ ok: false, error: "That channel does not exist." });

			if (!speaker || !channel.guild_id) {
				return json({ ok: false, error: "Eryn could not verify your access to that channel." });
			}

			const capabilities = await this.capabilities(channel.guild_id, speaker.authorId, input.channel);

			if (!capabilities?.read) {
				return json({ ok: false, error: "Your Discord permissions do not allow reading that channel." });
			}
			await this.putBinding({
				id: input.channel,
				provider: "discord",
				externalId: input.channel,
				name: channel.name,
				containerId: channel.guild_id,
				source: "manual",
				enabled: true,
				createdAt: Date.now(),
			});

			return json({ ok: true });
		} catch (error) {
			return json({ ok: false, error: describeError(error) });
		}
	}

	private async leave(request: Request): Promise<Response> {
		const input = await body(request, Schema.Struct({ channel: Schema.String }));

		if (input instanceof Response) return input;
		await this.unbindChannel(input.channel);

		return json({ ok: true });
	}

	private async unbindChannel(id: string): Promise<void> {
		await this.store.remove(this.channelKey(id));
	}

	private async bind(request: Request): Promise<Response> {
		const input = await body(request, BindChannelRequestSchema);

		if (input instanceof Response) return input;
		const existing = await this.binding(input.externalId);
		const binding: ChannelBinding =
			existing === undefined
				? {
						id: input.externalId,
						provider: input.provider,
						externalId: input.externalId,
						name: input.name,
						containerId: input.containerId,
						source: input.source,
						enabled: true,
						createdAt: Date.now(),
					}
				: {
						...existing,
						provider: input.provider,
						name: input.name ?? existing.name,
						containerId: input.containerId ?? existing.containerId,
						source: input.source ?? existing.source,
						enabled: true,
					};

		await this.putBinding(binding);

		return json({ binding });
	}

	private async unbind(request: Request): Promise<Response> {
		const input = await body(request, UnbindChannelRequestSchema);

		if (input instanceof Response) return input;
		await this.store.remove(this.channelKey(input.id));

		return json({ ok: true });
	}

	private async channels(request: Request): Promise<Response> {
		const bindings = await this.store.listPlain(KEYS.channel, ChannelBindingSchema);
		bindings.sort((a, b) => a.createdAt - b.createdAt);
		const session = request.headers.get("x-eryn-session");
		const sessionChannel = await this.sessionChannel(session ?? undefined);
		const body: ChannelListBody = { channels: bindings };

		if (sessionChannel) body.sessionChannel = sessionChannel;

		return json(body);
	}

	/** The channel an OpenCode session is working in, so a send can default. */
	private async rememberSession(request: Request): Promise<Response> {
		const input = await body(request, RememberSessionSchema);

		if (input instanceof Response) return input;
		await this.ctx.storage.put(KEYS.channelSession + input.sessionID, input.channel);

		return json({ ok: true });
	}

	// --- Policy and turn context ----------------------------------------------

	private async policy(): Promise<ServerPolicy> {
		return (await this.store.plain(KEYS.policy, ServerPolicySchema)) ?? defaultPolicy();
	}

	private async putPolicy(request: Request): Promise<Response> {
		const input = await body(request, Schema.Struct({ policy: ServerPolicySchema }));

		if (input instanceof Response) return input;
		await this.store.putPlain(KEYS.policy, ServerPolicySchema, input.policy);

		return json({ ok: true });
	}

	/** The latest speaker and permissions for a session's conversation. */
	private async context(request: Request): Promise<Response> {
		const input = await body(request, Schema.Struct({ sessionID: Schema.String }));

		if (input instanceof Response) return input;
		const channel = await this.sessionChannel(input.sessionID);

		if (!channel) return json({ context: null });
		const principal = await this.store.plain(KEYS.principal + channel, PrincipalRecordSchema);

		return json({ context: principal ?? null });
	}

	private async capabilities(guildId: string, userId: string, channelId: string): Promise<DiscordCapabilities | undefined> {
		try {
			const response = await this.env.GATEWAY.get(this.env.GATEWAY.idFromName("gateway")).fetch(
				"https://gateway.internal/authority",
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ guildId, userId, channelId }),
				},
			);
			const raw = (await response.json().catch(() => undefined)) as Schema.Json | undefined;
			const payload = toJsonObject(raw);
			const capabilities = toJsonObject(payload?.capabilities);

			if (!capabilities) return undefined;

			return {
				read: capabilities.read === true,
				send: capabilities.send === true,
				react: capabilities.react === true,
				manage: capabilities.manage === true,
				createThread: capabilities.createThread === true,
				sendInThreads: capabilities.sendInThreads === true,
			};
		} catch {
			return undefined;
		}
	}

	private async principal(channel: string): Promise<PrincipalRecord | undefined> {
		return await this.store.plain(KEYS.principal + channel, PrincipalRecordSchema);
	}

	private async sessionChannel(sessionID: string | undefined): Promise<string | undefined> {
		if (!sessionID) return undefined;
		return await this.ctx.storage.get<string>(KEYS.channelSession + sessionID);
	}

	// --- Provider configuration -----------------------------------------------

	private async putMessaging(request: Request): Promise<Response> {
		const input = await body(request, Schema.Struct({ config: MessagingConfigSchema }));

		if (input instanceof Response) return input;
		await this.store.putSealed(KEYS.messaging + input.config.kind, MessagingConfigSchema, input.config);

		return json({ ok: true });
	}

	private async messagingConfig(kind: "discord" | "imessage"): Promise<MessagingConfig | undefined> {
		return await this.store.sealed(KEYS.messaging + kind, MessagingConfigSchema);
	}

	/** What the settings page may show: no secrets. */
	private async messagingStatus(): Promise<Response> {
		const discord = await this.messagingConfig("discord");
		const imessage = await this.messagingConfig("imessage");
		const bindings = await this.store.listPlain(KEYS.channel, ChannelBindingSchema);

		return json({
			discord: discord?.kind === "discord" ? { configured: true, guildId: discord.guildId } : { configured: false },
			imessage:
				imessage?.kind === "imessage"
					? { configured: true, fromNumber: imessage.fromNumber }
					: { configured: false },
			count: bindings.length,
		});
	}

	private async provider(kind: "discord" | "imessage"): Promise<MessagingProvider> {
		if (kind === "discord") return discordProvider(this.env);
		const config = await this.messagingConfig("imessage");

		if (config?.kind !== "imessage") {
			throw new Error("iMessage is not configured for this server.");
		}

		return imessageProvider({
			apiKeyId: config.apiKeyId,
			apiSecret: config.apiSecret,
			fromNumber: config.fromNumber,
		});
	}

	// --- Inbound --------------------------------------------------------------

	private async ingest(request: Request): Promise<Response> {
		const input = await body(request, IngestRequestSchema);

		if (input instanceof Response) return input;
		const message = input.message;
		let binding = await this.binding(message.channel);

		if (!binding) {
			// A mention in a channel opens a binding; an iMessage conversation
			// always does, because the phone number is the conversation.
			const opens = message.addressed === true || message.provider === "imessage";

			if (!opens) return json({ ok: true, ignored: true });
			binding = {
				id: message.channel,
				provider: message.provider,
				externalId: message.channel,
				name: message.channelName ?? message.author.name,
				source: "mention",
				createdAt: Date.now(),
				enabled: true,
			};
			await this.putBinding(binding);
		}

		if (!binding.enabled) return json({ ok: true, ignored: true });
		if (message.outbound === true) return json({ ok: true, ignored: true });

		const policy = await this.policy();
		const trusted = message.provider === "imessage" || message.author.id === policy.ownerDiscordId;
		const permissions = trusted
			? ownerPermissions()
			: permissionsFor(
					policy,
					{
						id: message.author.id,
						name: message.author.name,
						roles: message.author.roles ?? [],
					},
					message.channel,
				);

		if (!trusted && (!permissions.invoke || !canUseChannel(permissions, message.channel))) {
			return json({ ok: true, ignored: true, denied: true });
		}

		await this.store.putPlain(KEYS.principal + message.channel, PrincipalRecordSchema, {
			channel: message.channel,
			authorId: message.author.id,
			name: message.author.name,
			roles: [...(message.author.roles ?? [])],
			permissions,
			updatedAt: Date.now(),
		});

		const stored = this.record(message);

		this.publish({ ...stored, channel: message.channel });
		this.track("message_received", {
			provider: message.provider,
			attachments: message.attachments.length,
			addressed: message.addressed === true,
		});

		return json({ ok: true, cursor: stored.cursor });
	}

	private record(message: InboundMessage): RecordedEvent {
		const at = message.createdAt || Date.now();
		const stored = {
			cursor: newCursor(),
			eventId: message.id,
			name: "message",
			timestamp: new Date(at).toISOString(),
			data: message,
		};

		this.ctx.storage.sql.exec(
			"INSERT INTO event (cursor, channel, payload, created) VALUES (?, ?, ?, ?)",
			stored.cursor,
			message.channel,
			JSON.stringify(message),
			at,
		);

		return stored;
	}

	private publish(event: RecordedEvent & { readonly channel: string }): void {
		const frame: Frame = {
			type: "event",
			eventId: event.eventId,
			name: event.name,
			timestamp: event.timestamp,
			data: event.data,
			cursor: event.cursor,
		};

		for (const subscriber of this.subscribers) {
			if (subscriber.channel !== undefined && subscriber.channel !== event.channel) continue;
			if (!subscriber.ready) subscriber.pending.push(frame);
			else subscriber.write(frame);
		}
	}

	// --- Outbound -------------------------------------------------------------

	private async send(request: Request): Promise<Response> {
		const input = await body(request, SendMessageRequestSchema);

		if (input instanceof Response) return input;
		const sessionChannel = await this.sessionChannel(request.headers.get("x-eryn-session") ?? undefined);
		const channel = input.channel || sessionChannel || "";

		if (!channel) return json(Schema.encodeSync(SendMessageResponseSchema)({ ok: false, error: "No channel to send to." }));

		const targetBinding = await this.binding(channel);

		if (sessionChannel && channel !== sessionChannel) {
			const speaker = await this.principal(sessionChannel);

			if (speaker?.permissions.crossChannel === "block") {
				return json(
					Schema.encodeSync(SendMessageResponseSchema)({
						ok: false,
						error: "You do not have permission to send outside this conversation.",
					}),
				);
			}

			if (speaker && targetBinding?.containerId) {
				const capabilities = await this.capabilities(
					targetBinding.containerId,
					speaker.authorId,
					targetBinding.externalId,
				);

				if (!capabilities?.send) {
					return json(
						Schema.encodeSync(SendMessageResponseSchema)({
							ok: false,
							error: "Your Discord permissions do not allow sending in that channel.",
						}),
					);
				}
			}
		}

		const binding = targetBinding;

		if (!binding) return json(Schema.encodeSync(SendMessageResponseSchema)({ ok: false, error: `No messaging channel is bound to ${channel}.` }));

		try {
			const provider = await this.provider(binding.provider);
			const result = await provider.send({
				channel: binding.externalId,
				text: input.text,
				attachments: input.attachments,
				replyTo: input.replyTo,
				components: input.components,
			});

			// Record the outbound message for history without feeding it to the agent.
			this.record({
				id: result.id ?? newCursor(),
				provider: binding.provider,
				channel: binding.externalId,
				author: { id: "eryn", name: "Eryn", bot: true },
				text: input.text,
				attachments: [...(input.attachments ?? [])],
				mentions: [],
				createdAt: Date.now(),
				outbound: true,
			});
			this.track("message_sent", {
				provider: binding.provider,
				success: true,
				attachments: input.attachments?.length ?? 0,
			});

			return json(Schema.encodeSync(SendMessageResponseSchema)({ ok: true, id: result.id }));
		} catch (error) {
			log("hub", `could not send to ${binding.externalId}: ${describeError(error)}`);
			this.track("message_sent", {
				provider: binding.provider,
				success: false,
				error_class: classifyError(error),
			});

			return json(Schema.encodeSync(SendMessageResponseSchema)({ ok: false, error: describeError(error) }));
		}
	}

	private async history(request: Request): Promise<Response> {
		const input = await body(request, HistoryRequestSchema);

		if (input instanceof Response) return input;
		const channel =
			input.channel || (await this.sessionChannel(request.headers.get("x-eryn-session") ?? undefined)) || "";

		if (!channel) return json(Schema.encodeSync(HistoryResponseSchema)({ messages: [] }));
		const historySession = request.headers.get("x-eryn-session");
		const current = historySession ? await this.sessionChannel(historySession) : undefined;

		if (current && channel !== current) {
			const speaker = await this.principal(current);
			const target = await this.binding(channel);
			const capabilities =
				speaker && target?.containerId
					? await this.capabilities(target.containerId, speaker.authorId, target.externalId)
					: undefined;

			if (!capabilities?.read) {
				return json(Schema.encodeSync(HistoryResponseSchema)({ messages: [] }));
			}
		}

		const limit = Math.min(Math.max(input.limit ?? 30, 1), 200);
		const rows = this.ctx.storage.sql
			.exec<{ payload: string }>(
				"SELECT payload FROM event WHERE channel = ? ORDER BY seq DESC LIMIT ?",
				channel,
				limit,
			)
			.toArray();
		const messages = rows
			.flatMap((row) => {
				const decoded = Schema.decodeUnknownOption(InboundMessageSchema)(JSON.parse(row.payload));

				return decoded._tag === "Some" ? [decoded.value] : [];
			})
			.reverse();

		return json(Schema.encodeSync(HistoryResponseSchema)({ messages }));
	}

	// --- MCP events -----------------------------------------------------------

	/** The raw SSE stream the Worker's MCP route turns into JSON-RPC notifications. */
	private events(request: Request): Response {
		const url = new URL(request.url);
		const channel = url.searchParams.get("channel") ?? undefined;
		const from = url.searchParams.get("cursor") ?? undefined;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		let subscriber: Subscriber | undefined;

		const stream = new ReadableStream<Uint8Array>({
			start: async (controller) => {
				let closed = false;
				const write = (frame: Frame) => {
					if (closed) return;

					try {
						controller.enqueue(frameText(frame));
					} catch {
						closed = true;
					}
				};

				subscriber = { channel, write, ready: false, pending: [] };
				this.subscribers.add(subscriber);

				// Replay first. Live events that arrive meanwhile wait in `pending`
				// so nothing falls between the query and the subscription.
				let last: string | null = null;

				try {
					const rows = this.replay(channel, from);

					for (const row of rows) {
						const payload = Schema.decodeUnknownOption(InboundMessageSchema)(JSON.parse(row.payload));

						write({
							type: "event",
							eventId: payload._tag === "Some" ? payload.value.id : row.cursor,
							name: "message",
							timestamp: new Date(row.created).toISOString(),
							data: JSON.parse(row.payload) as unknown,
							cursor: row.cursor,
						});
						last = row.cursor;
					}
				} catch (error) {
					log("hub", `could not replay events: ${describeError(error)}`);
				}

				write({ type: "active", cursor: last ?? from ?? null, truncated: false });
				subscriber.ready = true;
				for (const frame of subscriber.pending) subscriber.write(frame);
				subscriber.pending = [];
				heartbeat = setInterval(() => write({ type: "heartbeat", cursor: null }), HEARTBEAT_MS);
			},
			cancel: () => {
				if (heartbeat) clearInterval(heartbeat);
				if (subscriber) this.subscribers.delete(subscriber);
			},
		});

		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache, no-transform",
				connection: "keep-alive",
			},
		});
	}

	private replay(
		channel: string | undefined,
		from: string | undefined,
	): Array<{ cursor: string; payload: string; created: number }> {
		// No cursor means "from now": the subscription is live, and replaying the
		// whole log would make every reconnect re-answer old messages.
		if (!from) return [];

		const after =
			this.ctx.storage.sql
				.exec<{ seq: number }>("SELECT seq FROM event WHERE cursor = ?", from)
				.toArray()[0]?.seq ?? 0;

		if (channel) {
			return this.ctx.storage.sql
				.exec<{ cursor: string; payload: string; created: number }>(
					"SELECT cursor, payload, created FROM event WHERE channel = ? AND seq > ? ORDER BY seq ASC LIMIT 500",
					channel,
					after,
				)
				.toArray();
		}

		return this.ctx.storage.sql
			.exec<{ cursor: string; payload: string; created: number }>(
				"SELECT cursor, payload, created FROM event WHERE seq > ? ORDER BY seq ASC LIMIT 500",
				after,
			)
			.toArray();
	}

	/** Drop replay history past its retention window. */
	async alarm(): Promise<void> {
		if (this.restartPending) {
			this.ctx.abort("deploy changed", { retryAlarm: true });

			return;
		}

		const cutoff = Date.now() - RETENTION_MS;

		this.ctx.storage.sql.exec("DELETE FROM event WHERE created < ?", cutoff);
		await this.ctx.storage.setAlarm(Date.now() + 24 * 60 * 60 * 1000);
	}
}

/** Attach a name to a webhook secret without storing the secret publicly. */
export function webhookMatches(expected: string, given: string | null): boolean {
	if (!given) return false;
	let mismatch = expected.length ^ given.length;

	for (let index = 0; index < Math.max(expected.length, given.length); index++) {
		mismatch |= (expected.charCodeAt(index) || 0) ^ (given.charCodeAt(index) || 0);
	}

	return mismatch === 0;
}

/** A JSON field this module reads from a provider payload. */
export function attachmentOf(value: unknown): Attachment | undefined {
	const object = toJsonObject(value as never);

	if (!object) return undefined;
	const url = stringField(object, "url") ?? stringField(object, "media_url");

	if (!url) return undefined;

	return {
		url,
		name: stringField(object, "name"),
		contentType: stringField(object, "contentType") ?? stringField(object, "content_type"),
	};
}
