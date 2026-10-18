/**
 * Minimal Discord gateway client.
 *
 * One socket is kept open with heartbeats, resumable sessions, and backoff
 * reconnects. It knows nothing about OpenCode: the owner supplies callbacks for
 * the events it cares about (currently MESSAGE_CREATE and INTERACTION_CREATE).
 *
 * Cloudflare stops keeping a Durable Object in memory 15 minutes after an
 * outbound connection opens, so the owner should call `recycle()` (for example
 * from a Durable Object alarm) before that cap is reached.
 */

import { describeError, type DiscordUser } from "./api";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
/** GUILD_MESSAGES | MESSAGE_CONTENT. Message content must also be enabled in the portal. */
const INTENTS = (1 << 9) | (1 << 15);
const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
/** Cloudflare stops pinning a Durable Object 15 minutes after an outbound connection opens. */
const CONNECTION_RECYCLE_MS = 10 * 60_000;
/** Discord closes with these codes when the bot configuration itself is wrong. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
/** Discord closes with these codes when the session cannot be resumed, so re-identify instead. */
const SESSION_RESET_CLOSE_CODES = new Set([4007, 4009]);

/** The subset of a Discord message this bot reads. */
export interface DiscordMessage {
	id: string;
	channel_id: string;
	guild_id?: string;
	content?: string;
	webhook_id?: string;
	author?: DiscordUser;
	mentions?: DiscordUser[];
	mention_roles?: string[];
	thread?: { id: string; parent_id?: string };
}

/** The subset of a Discord interaction this bot reads. */
export interface DiscordInteraction {
	id: string;
	application_id: string;
	type: number;
	token: string;
	guild_id?: string;
	channel_id?: string;
	data?: { name?: string; type?: number };
	member?: { user?: DiscordUser };
	user?: DiscordUser;
}

export interface DiscordGatewayHandlers {
	onMessage(message: DiscordMessage): void;
	onInteraction(interaction: DiscordInteraction): void;
}

interface GatewayPayload {
	op: number;
	t?: string;
	s?: number | null;
	d?: unknown;
}

export class DiscordGateway {
	private socket: WebSocket | undefined;
	private heartbeat: ReturnType<typeof setTimeout> | undefined;
	private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
	private sequence: number | null = null;
	private session: string | undefined;
	private intervalMs = 45_000;
	private awaitingAck = 0;
	private attempt = 0;
	private connectedAt = 0;
	private disposed = false;
	private broken = false;

	constructor(
		private readonly token: string,
		private readonly log: (message: string) => void,
		private readonly handlers: DiscordGatewayHandlers,
	) {}

	/** True when Discord rejected the bot configuration itself, such as a missing intent. */
	get fatallyClosed(): boolean {
		return this.broken;
	}

	get open(): boolean {
		return this.socket !== undefined && this.socket.readyState === WebSocket.OPEN;
	}

	/** True once the connection has been open long enough that Cloudflare may evict the object. */
	get stale(): boolean {
		return this.open && Date.now() - this.connectedAt > CONNECTION_RECYCLE_MS;
	}

	/** Connect when idle. Safe to call repeatedly, from setup or from an alarm. */
	ensure(): void {
		if (this.disposed || this.broken) return;
		if (this.socket || this.reconnectTimer) return;
		this.connect();
	}

	/** Drop the current socket and resume the session on a fresh one. */
	recycle(): void {
		if (this.disposed || this.broken) return;
		if (!this.socket) {
			this.ensure();
			return;
		}
		this.reconnect("connection refresh");
	}

	stop(): void {
		this.disposed = true;
		this.stopHeartbeat();
		if (this.reconnectTimer !== undefined) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		const socket = this.socket;
		this.socket = undefined;
		try {
			socket?.close(1000, "eryn shutting down");
		} catch {
			// The socket is already gone; nothing to clean up.
		}
	}

	private connect(): void {
		if (this.disposed || this.broken) return;
		this.stopHeartbeat();

		let socket: WebSocket;
		try {
			socket = new WebSocket(GATEWAY_URL);
		} catch (error) {
			this.reconnect(`connect failed (${describeError(error)})`);
			return;
		}
		this.socket = socket;

		socket.addEventListener("open", () => {
			this.connectedAt = Date.now();
		});
		socket.addEventListener("message", (event) => {
			this.receive(event);
		});
		socket.addEventListener("error", () => {
			this.log("gateway socket error");
		});
		socket.addEventListener("close", (event) => {
			if (this.socket !== socket) return;
			this.socket = undefined;
			if (FATAL_CLOSE_CODES.has(event.code)) {
				this.broken = true;
				this.stopHeartbeat();
				this.log(
					`gateway closed with ${event.code}; not reconnecting. ` +
						"Check the bot token, that the bot is in the guild, and that the Message Content intent is enabled.",
				);
				return;
			}
			if (SESSION_RESET_CLOSE_CODES.has(event.code)) {
				this.session = undefined;
				this.sequence = null;
			}
			this.reconnect(`socket closed (${event.code})`);
		});
	}

	private receive(event: MessageEvent): void {
		const raw = event.data;
		if (typeof raw !== "string") return;

		let payload: GatewayPayload;
		try {
			payload = JSON.parse(raw) as GatewayPayload;
		} catch {
			this.log("gateway sent unreadable JSON");
			return;
		}

		switch (payload.op) {
			case 10: {
				const interval = (payload.d as { heartbeat_interval?: unknown } | undefined)?.heartbeat_interval;
				if (typeof interval === "number" && interval > 0) this.intervalMs = Math.max(5_000, interval);
				if (this.session) {
					this.send({ op: 6, d: { token: this.token, session_id: this.session, seq: this.sequence ?? 0 } });
				} else {
					this.send({
						op: 2,
						d: {
							token: this.token,
							intents: INTENTS,
							properties: { os: "cloudflare-workers", browser: "eryn", device: "eryn" },
						},
					});
				}
				this.startHeartbeat();
				break;
			}
			case 11:
				this.awaitingAck = 0;
				break;
			case 1:
				this.sendHeartbeat();
				break;
			case 7:
				this.reconnect("gateway requested reconnect");
				break;
			case 9: {
				const resumable = payload.d === true;
				if (!resumable) {
					this.session = undefined;
					this.sequence = null;
				}
				this.reconnect(resumable ? "invalid session, resuming" : "invalid session, re-identifying");
				break;
			}
			case 0: {
				if (typeof payload.s === "number") this.sequence = payload.s;
				if (payload.t === "READY") {
					const session = (payload.d as { session_id?: unknown } | undefined)?.session_id;
					if (typeof session === "string") this.session = session;
					this.attempt = 0;
					this.log("gateway connected");
				} else if (payload.t === "RESUMED") {
					this.attempt = 0;
					this.log("gateway resumed");
				} else if (payload.t === "MESSAGE_CREATE") {
					const message = payload.d as DiscordMessage | undefined;
					if (message && typeof message.id === "string" && typeof message.channel_id === "string") {
						this.handlers.onMessage(message);
					}
				} else if (payload.t === "INTERACTION_CREATE") {
					const interaction = payload.d as DiscordInteraction | undefined;
					if (interaction && typeof interaction.id === "string" && typeof interaction.token === "string") {
						this.handlers.onInteraction(interaction);
					}
				}
				break;
			}
			default:
				break;
		}
	}

	private sendHeartbeat(): void {
		if (!this.open) return;
		this.awaitingAck += 1;
		this.send({ op: 1, d: this.sequence });
	}

	private startHeartbeat(): void {
		this.stopHeartbeat();
		const beat = () => {
			this.sendHeartbeat();
			if (this.awaitingAck >= 2) {
				this.reconnect("heartbeat was not acknowledged");
				return;
			}
			this.heartbeat = setTimeout(beat, this.intervalMs);
		};
		// Discord expects the first heartbeat after a jittered fraction of the interval.
		this.heartbeat = setTimeout(beat, Math.max(1_000, this.intervalMs * (0.9 + Math.random() * 0.1)));
	}

	private stopHeartbeat(): void {
		if (this.heartbeat === undefined) return;
		clearTimeout(this.heartbeat);
		this.heartbeat = undefined;
	}

	private reconnect(reason: string): void {
		if (this.disposed || this.broken) return;
		this.stopHeartbeat();
		const socket = this.socket;
		this.socket = undefined;
		try {
			socket?.close(4000, reason.slice(0, 100));
		} catch {
			// The socket is already gone.
		}
		if (this.reconnectTimer !== undefined) return;

		const delay = RECONNECT_DELAYS[Math.min(this.attempt, RECONNECT_DELAYS.length - 1)] ?? 60_000;
		this.attempt += 1;
		this.log(`gateway reconnecting in ${Math.round(delay / 1_000)}s (${reason})`);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.connect();
		}, delay);
	}

	private send(payload: unknown): void {
		const socket = this.socket;
		if (!socket || socket.readyState !== WebSocket.OPEN) return;
		try {
			socket.send(JSON.stringify(payload));
		} catch (error) {
			this.log(`gateway send failed: ${describeError(error)}`);
		}
	}
}
