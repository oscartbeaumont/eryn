/**
 * The session Durable Object.
 *
 * One instance per Discord thread. It owns an embedded OpenCode host (see
 * `@opencode/sdk/workerd`), whose database lives in this object's SQLite
 * storage, and it is addressed by the thread id so a thread always maps to the
 * same session and conversation history.
 *
 * A prompt runs the agent turn and streams the reply straight into the thread.
 * The object keeps one event subscription for its lifetime and renders
 * `session.text.*` events into a Discord message, using the final transcript as
 * the authoritative result so nothing is lost if an intermediate edit is
 * dropped. `/stop` from the gateway calls `interrupt`, which cancels the turn
 * but keeps the session for future messages.
 */

import { DurableObject } from "cloudflare:workers";
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { DEFAULT_MODEL, intFromEnv } from "./config";
import { DEFAULT_THREAD_NAME, describeError, discordRest, type DiscordRest } from "./discord/api";
import { DiscordStream } from "./discord/stream";
import { fileStore, type FileStore } from "./opencode/store";
import { workspacePlugin } from "./opencode/workspace";
import { createGitHub } from "./github";
import { githubPlugin } from "./opencode/github";

const MODEL = DEFAULT_MODEL;
/** Namespace used for every session in this Worker. The workerd profile has no real filesystem. */
const LOCATION = "/eryn";
const SESSION_KEY = "opencode:session";
const DEFAULT_TURN_TIMEOUT_SECONDS = 900;

function log(message: string): void {
	console.log(`[eryn:session] ${message}`);
}

interface PromptRequest {
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

function createTurn(): Turn {
	let resolve!: () => void;
	const completed = new Promise<void>((res) => {
		resolve = res;
	});
	return {
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

interface Host {
	promise: Promise<OpenCodeWorkerd.Interface>;
	apiKey: string;
	model: string;
	/** Signature of the GitHub binding, so a config change rebuilds the host. */
	github: string;
}

export class ErynSession extends DurableObject<Env> {
	private readonly rest: DiscordRest;
	private readonly turnTimeoutMs: number;
	/** The thread's project: files shared by the file tools, bash, and GitHub. */
	private readonly files: FileStore;

	private host: Host | undefined;
	private abort: AbortController | undefined;
	private sessionID: string | undefined;
	private consuming: Promise<void> | undefined;
	private turn: Turn | undefined;
	private stream: DiscordStream | undefined;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.rest = discordRest(env.DISCORD_BOT_TOKEN?.trim() ?? "");
		this.files = fileStore(state.storage);
		this.turnTimeoutMs =
			intFromEnv(env.DISCORD_TURN_TIMEOUT_SECONDS, DEFAULT_TURN_TIMEOUT_SECONDS, 30, 3_600) * 1_000;
	}

	/**
	 * The embedded OpenCode host for this thread, built on first use with the
	 * guild's own credential. A changed key or model rebuilds the host so a
	 * rotated credential takes effect on the next turn.
	 */
	private hostFor(
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

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === "POST" && pathname === "/session/prompt") {
			const body = (await request.json()) as PromptRequest;
			if (!body.apiKey) return Response.json({ ok: false, error: "missing api key" }, { status: 400 });
			try {
				await this.prompt(body);
				return Response.json({ ok: true });
			} catch (error) {
				log(`prompt failed: ${describeError(error)}`);
				return Response.json({ ok: false, error: describeError(error) }, { status: 500 });
			}
		}
		if (request.method === "POST" && pathname === "/session/interrupt") {
			return Response.json({ stopped: await this.interrupt() });
		}
		if (request.method === "GET" && pathname === "/session/status") {
			return Response.json({ sessionID: this.sessionID, busy: this.turn !== undefined });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	}

	// --- A turn -----------------------------------------------------------------

	private async prompt(request: PromptRequest): Promise<void> {
		const host = await this.hostFor(request.apiKey, request.model ?? MODEL, request.github);
		const sessionID = await this.ensureSession(host, request.title ?? DEFAULT_THREAD_NAME);
		const baseline = await this.lastAssistantID(host, sessionID).catch(() => undefined);

		const stream = new DiscordStream(this.rest, request.threadId);
		await stream.start();

		const turn = createTurn();
		this.turn = turn;
		this.stream = stream;
		const stopTyping = this.startTyping(request.threadId);

		try {
			await host.sessions.prompt({ sessionID, text: request.text });
			const finished = await this.wait(turn);
			if (!finished) await this.interrupt().catch(() => undefined);

			const final = await this.finalText(host, sessionID, baseline).catch(() => undefined);
			const body = final ?? renderTurn(turn);
			const suffix = turn.interrupted ? "Stopped." : finished ? undefined : "Stopped after timing out.";
			await stream.finish(body, suffix);
		} catch (error) {
			await stream.finish(`I hit an error: ${describeError(error)}`);
		} finally {
			stopTyping();
			turn.done = true;
			if (this.turn === turn) this.turn = undefined;
			if (this.stream === stream) this.stream = undefined;
		}
	}

	/** Cancel the running turn, keeping the session for later messages. */
	private async interrupt(): Promise<boolean> {
		if (!this.turn || !this.host || !this.sessionID) return false;
		const host = await this.host.promise;
		await host.sessions.interrupt({ sessionID: this.sessionID });
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

	/** The session for this thread, created on first use and stored durably. */
	private async ensureSession(host: OpenCodeWorkerd.Interface, title: string): Promise<string> {
		this.sessionID ??= await this.ctx.storage.get<string>(SESSION_KEY);
		if (this.sessionID) {
			try {
				await host.sessions.get({ sessionID: this.sessionID });
				return this.sessionID;
			} catch {
				this.sessionID = undefined;
			}
		}

		const session = await host.sessions.create({ title, location: { directory: LOCATION } });
		this.sessionID = session.id;
		await this.ctx.storage.put(SESSION_KEY, session.id);
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
		const turn = this.turn;
		if (!turn || turn.done) return;

		const shape = event as { type?: unknown; created?: unknown; data?: unknown };
		if (typeof shape.type !== "string" || !shape.data || typeof shape.data !== "object") return;
		const data = shape.data as Record<string, unknown>;
		if (data.sessionID !== this.sessionID) return;
		// Ignore events that predate this turn, such as the previous one going idle.
		if (typeof shape.created === "number" && shape.created < turn.createdAt - 1_000) return;

		switch (shape.type) {
			case "session.step.started": {
				if (typeof data.assistantMessageID === "string") turn.main.add(data.assistantMessageID);
				return;
			}
			case "session.tool.called": {
				// The agent is past pure reasoning; reflect that in the loading line.
				this.stream?.setStatus("Working…");
				return;
			}
			case "session.text.delta": {
				this.appendText(turn, data, typeof data.delta === "string" ? data.delta : "");
				return;
			}
			case "session.text.ended": {
				this.setPart(turn, data, typeof data.text === "string" ? data.text : "");
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

	private appendText(turn: Turn, data: Record<string, unknown>, delta: string): void {
		const messageID = data.assistantMessageID;
		const ordinal = data.ordinal;
		if (typeof messageID !== "string" || typeof ordinal !== "number" || !delta) return;
		const ordinals = turn.parts.get(messageID) ?? new Map<number, string>();
		ordinals.set(ordinal, (ordinals.get(ordinal) ?? "") + delta);
		turn.parts.set(messageID, ordinals);
		this.stream?.push(renderTurn(turn));
	}

	private setPart(turn: Turn, data: Record<string, unknown>, text: string): void {
		const messageID = data.assistantMessageID;
		const ordinal = data.ordinal;
		if (typeof messageID !== "string" || typeof ordinal !== "number") return;
		const ordinals = turn.parts.get(messageID) ?? new Map<number, string>();
		ordinals.set(ordinal, text);
		turn.parts.set(messageID, ordinals);
		this.stream?.push(renderTurn(turn));
	}
}
