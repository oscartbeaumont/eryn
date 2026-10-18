/**
 * The session Durable Object.
 *
 * **One object per Discord guild.** The guild id is the object name, so a
 * guild's OpenCode database, virtual filesystem, GitHub binding, and provider
 * credential all live in storage that no other guild can be routed to. That is
 * the security boundary: two servers can never share a workspace, a session,
 * or a key, because they are different objects with different SQLite files.
 *
 * Threads inside the guild are OpenCode sessions inside this one object, so a
 * server behaves like a single project and quickly goes idle between turns.
 * The object holds no alarm and no background timer of its own: it wakes when
 * the gateway forwards a prompt and is evictable the moment the turn ends and
 * the event subscription is closed. All of the always-on work lives in the
 * single gateway object, which does nothing but hold the Discord socket.
 *
 * A prompt runs the agent turn and streams the reply straight into the thread.
 * Events are matched back to their thread by session id, so concurrent turns in
 * the same guild keep their own state.
 */

import { DurableObject } from "cloudflare:workers";
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import type { Configuration } from "@opencode/sdk/workerd";
import { DEFAULT_MODEL, intFromEnv } from "./config";
import { DEFAULT_THREAD_NAME, describeError, discordRest, type DiscordRest } from "./discord/api";
import { DiscordStream } from "./discord/stream";
import { fileStore, type FileStore } from "./opencode/store";
import { workspacePlugin } from "./opencode/workspace";
import { createGitHub } from "./github";
import { githubPlugin } from "./opencode/github";
import { mintInternalToken } from "./mcp/access";

const MODEL = DEFAULT_MODEL;
/** Namespace used for every session in this Worker. The workerd profile has no real filesystem. */
const LOCATION = "/eryn";
/** Prefix for a thread's session id, so one guild's storage holds many threads. */
const SESSION_PREFIX = "opencode:session:";
const DEFAULT_TURN_TIMEOUT_SECONDS = 900;
const DEFAULT_MCP_URL = "https://eryn.otbeaumont.me/mcp";

function log(message: string): void {
	console.log(`[eryn:session] ${message}`);
}

interface PromptRequest {
	/** The guild this thread belongs to. It must match the object's own name. */
	guildId: string;
	threadId: string;
	title?: string;
	text: string;
	author?: string;
	/** The guild's own OpenCode Go credential, supplied by the gateway. */
	apiKey: string;
	model?: string;
	/** GitHub App binding for this guild, when configured. */
	github?: { installationId?: string; repo?: string };
}

/** Accumulated assistant output for one turn, keyed by message then part. */
interface Turn {
	readonly threadId: string;
	readonly createdAt: number;
	readonly parts: Map<string, Map<number, string>>;
	/** Assistant message ids that belong to a real step, excluding auxiliary requests. */
	readonly main: Set<string>;
	done: boolean;
	interrupted: boolean;
	failed: boolean;
	readonly resolve: () => void;
	readonly completed: Promise<void>;
}

function createTurn(threadId: string): Turn {
	let resolve!: () => void;
	const completed = new Promise<void>((res) => {
		resolve = res;
	});
	return {
		threadId,
		createdAt: Date.now(),
		parts: new Map(),
		main: new Set(),
		done: false,
		interrupted: false,
		failed: false,
		resolve,
		completed,
	};
}

function completeTurn(turn: Turn): void {
	if (turn.done) return;
	turn.done = true;
	turn.resolve();
}

/** Render the streamed text so far, preferring messages that belong to a step. */
function renderTurn(turn: Turn): string {
	const messages: string[] = [];
	for (const [messageID, ordinals] of turn.parts) {
		if (turn.main.size > 0 && !turn.main.has(messageID)) continue;
		const text = [...ordinals.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, value]) => value)
			.join("")
			.trim();
		if (text) messages.push(text);
	}
	return messages.join("\n\n").trim();
}

/** The live state of one thread inside this guild's object. */
interface ThreadRun {
	turn?: Turn;
	stream?: DiscordStream;
}

interface Host {
	promise: Promise<OpenCodeWorkerd.Interface>;
	apiKey: string;
	model: string;
	/** Signature of the GitHub binding, so a config change rebuilds the host. */
	github: string;
}

export class ErynSession extends DurableObject<Env> {
	/** The guild this object serves, taken from the storage key the gateway used. */
	private readonly guildId: string;
	private readonly rest: DiscordRest;
	private readonly turnTimeoutMs: number;
	/** The guild's project: files shared by every thread, its file tools, and GitHub. */
	private readonly files: FileStore;
	/** In-memory turn state per thread; a thread's session id is persisted. */
	private readonly runs = new Map<string, ThreadRun>();

	private host: Host | undefined;
	private abort: AbortController | undefined;
	private consuming: Promise<void> | undefined;
	/** Which thread each OpenCode session belongs to, so events can be routed. */
	private readonly sessions = new Map<string, string>();
	/** The minted MCP bearer token, reused for the object's lifetime. */
	private mcpToken: Promise<string | undefined> | undefined;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		// The Durable Object name is the guild id, which is exactly the boundary
		// the gateway needs to enforce. Reading it back here makes that explicit.
		this.guildId = state.id.name ?? "";
		this.rest = discordRest(env.DISCORD_BOT_TOKEN?.trim() ?? "");
		this.files = fileStore(state.storage);
		this.turnTimeoutMs =
			intFromEnv(env.DISCORD_TURN_TIMEOUT_SECONDS, DEFAULT_TURN_TIMEOUT_SECONDS, 30, 3_600) * 1_000;
	}

	/**
	 * The embedded OpenCode host for this guild, built on first use with the
	 * guild's own credential. A changed key or model rebuilds the host so a
	 * rotated credential takes effect on the next turn.
	 */
	private async hostFor(
		apiKey: string,
		model: string,
		github?: { installationId?: string; repo?: string },
	): Promise<OpenCodeWorkerd.Interface> {
		const githubKey = github ? `${github.installationId ?? ""}|${github.repo ?? ""}` : "";
		if (!this.host || this.host.apiKey !== apiKey || this.host.model !== model || this.host.github !== githubKey) {
			const previous = this.host?.promise;
			this.abort?.abort();
			this.abort = new AbortController();

			const plugins = [workspacePlugin(this.files)];
			const appId = this.env.GITHUB_APP_ID?.trim();
			const privateKey = this.env.GITHUB_APP_PRIVATE_KEY?.trim();
			if (github?.installationId && appId && privateKey) {
				plugins.push(
					githubPlugin({
						github: createGitHub({ appId, privateKey, installationId: github.installationId }),
						repo: github.repo,
						store: this.files,
					}),
				);
			}

			const promise = OpenCodeWorkerd.create({
				storage: this.ctx.storage,
				config: {
					model,
					default_agent: "build",
					permissions: [{ action: "*", resource: "*", effect: "allow" }],
					providers: { "opencode-go": { settings: { apiKey } } },
					mcp: await this.mcpConfig(),
				},
				plugins,
			});
			this.host = { promise, apiKey, model, github: githubKey };
			this.consuming = undefined;
			void promise
				.then((host) => this.startConsuming(host))
				.catch((error) => log(`could not start the event stream: ${describeError(error)}`));
			void previous?.then((host) => host.close()).catch(() => undefined);
		}
		return this.host.promise;
	}

	/**
	 * The MCP server Eryn hosts, wired in with a locally minted token so the
	 * cloud agent needs no OAuth round trip. It is the same public, protected
	 * endpoint any harness can use.
	 */
	private mcpConfig(): Promise<Configuration["mcp"]> {
		this.mcpToken ??= (async () => {
			const secret = this.env.SESSION_SECRET?.trim();
			if (!secret) return undefined;
			return await mintInternalToken(secret);
		})();
		return this.mcpToken.then((token) => {
			if (!token) return undefined;
			const url = this.env.MCP_INTERNAL_URL?.trim() || `${this.publicOrigin()}/mcp`;
			return {
				servers: {
					eryn: {
						type: "remote",
						url,
						headers: { Authorization: `Bearer ${token}` },
						// Eryn's own token is already minted; never start a login flow.
						oauth: false,
						codemode: false,
					},
				},
			};
		});
	}

	private publicOrigin(): string {
		return this.env.PUBLIC_ORIGIN?.trim().replace(/\/$/, "") || DEFAULT_MCP_URL.slice(0, -"/mcp".length);
	}

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === "POST" && pathname === "/session/prompt") {
			const body = (await request.json()) as PromptRequest;
			if (!body.apiKey) return Response.json({ ok: false, error: "missing api key" }, { status: 400 });
			// The gateway names this object after the guild, so a mismatch means a
			// routing bug rather than an authorised cross-guild request.
			if (this.guildId && body.guildId && body.guildId !== this.guildId) {
				return Response.json({ ok: false, error: "guild mismatch" }, { status: 403 });
			}
			try {
				await this.prompt(body);
				return Response.json({ ok: true });
			} catch (error) {
				log(`prompt failed: ${describeError(error)}`);
				return Response.json({ ok: false, error: describeError(error) }, { status: 500 });
			}
		}
		if (request.method === "POST" && pathname === "/session/interrupt") {
			const body = (await request.json().catch(() => ({}))) as { threadId?: string };
			return Response.json({ stopped: await this.interrupt(body.threadId) });
		}
		if (request.method === "GET" && pathname === "/session/status") {
			return Response.json({ guildId: this.guildId, busy: this.runs.size > 0 });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	}

	// --- A turn -----------------------------------------------------------------

	private async prompt(request: PromptRequest): Promise<void> {
		const host = await this.hostFor(request.apiKey, request.model ?? MODEL, request.github);
		const sessionID = await this.ensureSession(host, request.threadId, request.title ?? DEFAULT_THREAD_NAME);
		const baseline = await this.lastAssistantID(host, sessionID).catch(() => undefined);

		const stream = new DiscordStream(this.rest, request.threadId);
		await stream.start();

		const run = this.runs.get(request.threadId) ?? {};
		const turn = createTurn(request.threadId);
		run.turn = turn;
		run.stream = stream;
		this.runs.set(request.threadId, run);
		const stopTyping = this.startTyping(request.threadId);

		try {
			await host.sessions.prompt({ sessionID, text: request.text });
			const finished = await this.wait(turn);
			if (!finished) await this.interrupt(request.threadId).catch(() => undefined);

			const final = await this.finalText(host, sessionID, baseline).catch(() => undefined);
			const body = final ?? renderTurn(turn);
			const suffix = turn.interrupted ? "Stopped." : finished ? undefined : "Stopped after timing out.";
			await stream.finish(body, suffix);
		} catch (error) {
			await stream.finish(`I hit an error: ${describeError(error)}`);
		} finally {
			stopTyping();
			turn.done = true;
			const current = this.runs.get(request.threadId);
			if (current && current.turn === turn) {
				current.turn = undefined;
				current.stream = undefined;
				// Drop the thread entry so the object has nothing left to hold on to.
				this.runs.delete(request.threadId);
			}
		}
	}

	/** Cancel a thread's running turn, keeping its session for later messages. */
	private async interrupt(threadId: string | undefined): Promise<boolean> {
		const run = threadId ? this.runs.get(threadId) : undefined;
		const sessionID = threadId ? await this.sessionFor(threadId) : undefined;
		if (!run?.turn || !this.host || !sessionID) return false;
		const host = await this.host.promise;
		await host.sessions.interrupt({ sessionID });
		return true;
	}

	private async wait(turn: Turn): Promise<boolean> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<boolean>((resolve) => {
			timer = setTimeout(() => resolve(false), this.turnTimeoutMs);
		});
		const result = await Promise.race([turn.completed.then(() => true), timeout]);
		if (timer) clearTimeout(timer);
		return result;
	}

	private startTyping(channelId: string): () => void {
		const ping = () => {
			void this.rest.triggerTyping(channelId).catch(() => undefined);
		};
		ping();
		const timer = setInterval(ping, 8_000);
		return () => clearInterval(timer);
	}

	// --- Sessions ---------------------------------------------------------------

	/** A thread's OpenCode session id, if it has been created. */
	private async sessionFor(threadId: string): Promise<string | undefined> {
		const cached = this.sessions.get(threadId);
		if (cached) return cached;
		const stored = await this.ctx.storage.get<string>(SESSION_PREFIX + threadId);
		if (stored) this.sessions.set(threadId, stored);
		return stored;
	}

	/** The session for a thread, created on first use and stored durably. */
	private async ensureSession(
		host: OpenCodeWorkerd.Interface,
		threadId: string,
		title: string,
	): Promise<string> {
		const existing = await this.sessionFor(threadId);
		if (existing) {
			try {
				await host.sessions.get({ sessionID: existing });
				return existing;
			} catch {
				this.sessions.delete(threadId);
			}
		}

		const session = await host.sessions.create({ title, location: { directory: LOCATION } });
		this.sessions.set(threadId, session.id);
		await this.ctx.storage.put(SESSION_PREFIX + threadId, session.id);
		return session.id;
	}

	private async lastAssistantID(host: OpenCodeWorkerd.Interface, sessionID: string): Promise<string | undefined> {
		const messages = await host.sessions.context({ sessionID });
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]!;
			if (message.type === "assistant") return message.id;
		}
		return undefined;
	}

	/** The assistant text produced since `baseline`, read from the transcript. */
	private async finalText(
		host: OpenCodeWorkerd.Interface,
		sessionID: string,
		baseline: string | undefined,
	): Promise<string | undefined> {
		const messages = await host.sessions.context({ sessionID });
		const collected: string[] = [];
		for (let index = messages.length - 1; index >= 0; index--) {
			const message = messages[index]!;
			if (message.type !== "assistant") continue;
			if (baseline && message.id === baseline) break;
			const text = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("")
				.trim();
			if (text) collected.push(text);
		}
		return collected.reverse().join("\n\n").trim() || undefined;
	}

	// --- Event stream -----------------------------------------------------------

	private startConsuming(host: OpenCodeWorkerd.Interface): void {
		if (this.consuming) return;
		this.consuming = (async () => {
			for await (const event of host.events.subscribe({ signal: this.abort?.signal })) {
				try {
					this.handleEvent(event);
				} catch (error) {
					log(`event handling failed: ${describeError(error)}`);
				}
			}
		})().catch((error) => {
			log(`event stream stopped: ${describeError(error)}`);
			this.consuming = undefined;
		});
	}

	private handleEvent(event: unknown): void {
		const shape = event as { type?: unknown; created?: unknown; data?: unknown };
		if (typeof shape.type !== "string" || !shape.data || typeof shape.data !== "object") return;
		const data = shape.data as Record<string, unknown>;
		const sessionID = data.sessionID;
		if (typeof sessionID !== "string") return;
		const threadId = this.sessions.get(sessionID);
		if (!threadId) return;

		const turn = this.runs.get(threadId)?.turn;
		if (!turn || turn.done) return;
		// Ignore events that predate this turn, such as the previous one going idle.
		if (typeof shape.created === "number" && shape.created < turn.createdAt - 1_000) return;

		switch (shape.type) {
			case "session.step.started": {
				if (typeof data.assistantMessageID === "string") turn.main.add(data.assistantMessageID);
				return;
			}
			case "session.tool.called": {
				// The agent is past pure reasoning; reflect that in the loading line.
				this.runs.get(threadId)?.stream?.setStatus("Working…");
				return;
			}
			case "session.text.delta": {
				this.appendText(threadId, turn, data, typeof data.delta === "string" ? data.delta : "");
				return;
			}
			case "session.text.ended": {
				this.setPart(threadId, turn, data, typeof data.text === "string" ? data.text : "");
				return;
			}
			case "session.execution.failed": {
				turn.failed = true;
				completeTurn(turn);
				return;
			}
			case "session.execution.interrupted": {
				turn.interrupted = true;
				completeTurn(turn);
				return;
			}
			case "session.execution.succeeded": {
				completeTurn(turn);
				return;
			}
			case "session.idle": {
				// Only a session that actually started a step is considered finished.
				if (turn.main.size > 0) completeTurn(turn);
				return;
			}
			default:
				return;
		}
	}

	private appendText(threadId: string, turn: Turn, data: Record<string, unknown>, delta: string): void {
		const messageID = data.assistantMessageID;
		const ordinal = data.ordinal;
		if (typeof messageID !== "string" || typeof ordinal !== "number" || !delta) return;
		const ordinals = turn.parts.get(messageID) ?? new Map<number, string>();
		ordinals.set(ordinal, (ordinals.get(ordinal) ?? "") + delta);
		turn.parts.set(messageID, ordinals);
		this.runs.get(threadId)?.stream?.push(renderTurn(turn));
	}

	private setPart(threadId: string, turn: Turn, data: Record<string, unknown>, text: string): void {
		const messageID = data.assistantMessageID;
		const ordinal = data.ordinal;
		if (typeof messageID !== "string" || typeof ordinal !== "number") return;
		const ordinals = turn.parts.get(messageID) ?? new Map<number, string>();
		ordinals.set(ordinal, text);
		turn.parts.set(messageID, ordinals);
		this.runs.get(threadId)?.stream?.push(renderTurn(turn));
	}
}
