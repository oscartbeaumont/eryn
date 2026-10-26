/**
 * The events hub: the singleton Durable Object behind the MCP Events extension.
 *
 * It owns the lazily-opened Discord socket — opened on the first subscription and
 * left running, so a deployment that never subscribes pays nothing — and holds
 * every subscription and the recent-event ring buffer. A user's object forwards
 * `events/*` here with the arguments already resolved; the hub knows nothing
 * about accounts, only about channels.
 *
 * Discord is the only source today. It is deliberately its own object rather than
 * the bot's socket: the two packages must not depend on each other, and the
 * gateway must be able to produce Discord events on its own.
 */

import { DurableObject } from "cloudflare:workers";
import { randomToken } from "../crypto";
import { DEPLOY_HEADER, currentDeploy } from "../deploy";
import { descriptors, DISCORD_MESSAGE_EVENT, sseFrame, type Occurrence, type Subscription } from "../events";
import { describeError } from "../discord/api";
import { DiscordGateway, type DiscordMessage } from "../discord/socket";

const MAX_EVENTS = 250;
const RETENTION_MS = 30 * 60 * 1_000;
const HEARTBEAT_MS = 20_000;
const WEBHOOK_TIMEOUT_MS = 10_000;

function log(message: string): void {
	console.log(`[eryn:gateway:events] ${message}`);
}

interface StreamListener {
	filter: { name: string; channel_id?: string; author_id?: string };
	send: (occurrence: Occurrence) => void;
}

export class GatewayDiscordV5 extends DurableObject<Env> {
	private readonly gateway: DiscordGateway;
	private readonly subscriptions = new Map<string, Subscription>();
	private readonly listeners = new Set<StreamListener>();
	private buffer: Occurrence[] = [];
	private seq = 0;
	private started = false;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.gateway = new DiscordGateway(env.DISCORD_BOT_TOKEN?.trim() ?? "", log, {
			onMessage: (message) => {
				try {
					this.onMessage(message);
				} catch (error) {
					log(`message handling failed: ${describeError(error)}`);
				}
			},
			onInteraction: () => undefined,
			onChannelDelete: () => undefined,
		});
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
		const version = request.headers.get(DEPLOY_HEADER) ?? currentDeploy(this.env);
		if (!version) return;
		const stored = await this.ctx.storage.get<string>("deploy:version");
		if (stored === version) return;
		await this.ctx.storage.put("deploy:version", version);
		// A first run has no stored version; only a change needs a restart.
		if (stored !== undefined) {
			await this.ctx.storage.put("deploy:restart", true);
			await this.ctx.storage.setAlarm(Date.now() + 1_000);
		}
	}

	/** Abort into the new code if a deploy happened while this object was live. */
	async alarm(): Promise<void> {
		if (!(await this.ctx.storage.get<boolean>("deploy:restart"))) return;
		await this.ctx.storage.delete("deploy:restart");
		this.ctx.abort();
	}

	override async fetch(request: Request): Promise<Response> {
		await this.ensureCurrentVersion(request);
		const path = new URL(request.url).pathname;
		if (request.method === "POST" && path === "/events/list") {
			return Response.json({ events: descriptors(true) });
		}
		if (request.method === "POST" && path === "/events/subscribe") {
			return await this.subscribe(request);
		}
		if (request.method === "POST" && path === "/events/unsubscribe") {
			const body = (await request.json().catch(() => ({}))) as { id?: string };
			if (body.id) this.subscriptions.delete(body.id);
			return Response.json({ ok: true });
		}
		if (request.method === "POST" && path === "/events/poll") {
			return await this.poll(request);
		}
		if (request.method === "POST" && path === "/events/stream") {
			return await this.stream(request);
		}
		if (path === "/stats") {
			return Response.json({ subscriptions: this.subscriptions.size, listeners: this.listeners.size, buffered: this.buffer.length });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	}

	private ensure(): void {
		if (this.started) return;
		this.started = true;
		this.gateway.ensure();
		log("opened the Discord socket for events");
	}

	private async subscribe(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => ({}))) as {
			name?: string;
			arguments?: { channel_id?: string; author_id?: string };
			delivery?: string;
			url?: string;
			maxAgeMs?: number;
		};
		const channelId = body.arguments?.channel_id;
		if (!body.name || !channelId) return Response.json({ error: "name and arguments.channel_id are required" }, { status: 400 });
		const delivery = body.delivery === "poll" || body.delivery === "push" ? body.delivery : "webhook";
		if (delivery === "webhook" && !body.url) return Response.json({ error: "a webhook subscription needs a url" }, { status: 400 });

		const id = `evt_${randomToken(16)}`;
		this.subscriptions.set(id, {
			id,
			name: body.name,
			args: { channel_id: channelId, ...(body.arguments?.author_id ? { author_id: body.arguments.author_id } : {}) },
			delivery,
			...(body.url ? { url: body.url } : {}),
			...(body.url ? { secret: randomToken(24) } : {}),
			expiresAt: Date.now() + (body.maxAgeMs ?? 7 * 24 * 60 * 60 * 1_000),
			createdAt: Date.now(),
		});
		if (body.name === DISCORD_MESSAGE_EVENT) this.ensure();
		return Response.json({ id });
	}

	private async poll(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => ({}))) as {
			name?: string;
			arguments?: { channel_id?: string; author_id?: string };
			cursor?: string | null;
			maxEvents?: number;
		};
		const since = typeof body.cursor === "string" ? Number.parseInt(body.cursor, 10) : 0;
		const max = Math.min(Math.max(body.maxEvents ?? 50, 1), 100);
		const matched = this.buffer.filter((occurrence) => occurrence.seq > (Number.isFinite(since) ? since : 0) && this.matches(occurrence, body));
		const events = matched.slice(0, max);
		const cursor = events.length ? String(events[events.length - 1]!.seq) : body.cursor ?? "0";
		return Response.json({ events, cursor, hasMore: matched.length > events.length, nextPollMs: 2_000 });
	}

	private async stream(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => ({}))) as {
			name?: string;
			arguments?: { channel_id?: string; author_id?: string };
			cursor?: string | null;
		};
		if (!body.name) return Response.json({ error: "name is required" }, { status: 400 });
		this.ensure();

		const listener: StreamListener = {
			filter: { name: body.name, channel_id: body.arguments?.channel_id, author_id: body.arguments?.author_id },
			send: () => undefined,
		};
		const encoder = new TextEncoder();
		const state = this;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		const sse = new ReadableStream<Uint8Array>({
			start(controller) {
				const write = (text: string) => {
					try {
						controller.enqueue(encoder.encode(text));
					} catch {
						// The stream is gone; the cancel handler cleans up.
					}
				};
				listener.send = (occurrence) => {
					write(sseFrame({ method: "notifications/events/event", params: { ...occurrence, subscriptionId: body.name } }));
				};
				state.listeners.add(listener);
				write(sseFrame({ method: "notifications/events/active", params: { name: body.name, cursor: body.cursor ?? "0" } }));
				heartbeat = setInterval(() => {
					write(sseFrame({ method: "notifications/events/heartbeat", params: { name: body.name } }));
				}, HEARTBEAT_MS);
			},
			cancel() {
				if (heartbeat) clearInterval(heartbeat);
				state.listeners.delete(listener);
			},
		});
		return new Response(sse, {
			headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no" },
		});
	}

	private matches(occurrence: Occurrence, filter: { name?: string; arguments?: { channel_id?: string; author_id?: string } }): boolean {
		if (filter.name && occurrence.name !== filter.name) return false;
		const channelId = filter.arguments?.channel_id;
		if (channelId && occurrence.data.channel_id !== channelId) return false;
		const authorId = filter.arguments?.author_id;
		if (authorId) {
			const author = occurrence.data.author as { id?: string } | undefined;
			if (author?.id !== authorId) return false;
		}
		return true;
	}

	private onMessage(message: DiscordMessage): void {
		if (message.webhook_id !== undefined) return;
		const occurrence: Occurrence = {
			eventId: `discord:${message.id}`,
			name: DISCORD_MESSAGE_EVENT,
			timestamp: new Date().toISOString(),
			seq: ++this.seq,
			data: {
				message_id: message.id,
				channel_id: message.channel_id,
				guild_id: message.guild_id ?? null,
				content: message.content ?? "",
				author: {
					id: message.author?.id ?? null,
					username: message.author?.username ?? null,
					name: message.member?.nick ?? message.author?.global_name ?? message.author?.username ?? null,
				},
			},
		};
		this.remember(occurrence);
		for (const listener of this.listeners) {
			if (this.matches(occurrence, { name: listener.filter.name, arguments: listener.filter })) listener.send(occurrence);
		}
		for (const subscription of this.subscriptions.values()) {
			if (subscription.delivery !== "webhook") continue;
			if (subscription.expiresAt && subscription.expiresAt < Date.now()) {
				this.subscriptions.delete(subscription.id);
				continue;
			}
			if (this.matches(occurrence, { name: subscription.name, arguments: subscription.args })) {
				void this.deliver(subscription, occurrence);
			}
		}
	}

	private remember(occurrence: Occurrence): void {
		this.buffer.push(occurrence);
		const cutoff = Date.now() - RETENTION_MS;
		this.buffer = this.buffer.filter((entry) => occurrence.seq - entry.seq < MAX_EVENTS && Date.parse(entry.timestamp) >= cutoff);
	}

	private async deliver(subscription: Subscription, occurrence: Occurrence): Promise<void> {
		if (!subscription.url) return;
		const body = JSON.stringify({ ...occurrence, subscriptionId: subscription.id });
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const response = await fetch(subscription.url, {
					method: "POST",
					headers: { "content-type": "application/json", "x-eryn-event": occurrence.name },
					body,
					signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
				});
				if (response.ok) return;
			} catch (error) {
				if (attempt === 2) log(`webhook delivery for ${subscription.id} failed: ${describeError(error)}`);
			}
			await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
		}
	}
}
