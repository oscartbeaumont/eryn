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
import { MCP_PATH } from "./mcp/oauth";

const MODEL = DEFAULT_MODEL;
/** Namespace used for every session in this Worker. The workerd profile has no real filesystem. */
const LOCATION = "/eryn";
/** Prefix for a thread's session id, so one guild's storage holds many threads. */
const SESSION_PREFIX = "opencode:session:";
const DEFAULT_TURN_TIMEOUT_SECONDS = 900;
const DEFAULT_MCP_URL = "https://eryn.otbeaumont.me/mcp";
/** The provider every guild's OpenCode Go key is for. */
const PROVIDER = "opencode-go";

function log(message: string): void {
	console.log(`[eryn:session] ${message}`);
}

/** A model the console can offer, normalised for the dropdown. */
interface ModelOption {
	/** The `provider/model` reference the registry accepts, e.g. `opencode-go/kimi-k3`. */
	id: string;
	name: string;
	provider: string;
	status: string;
	enabled: boolean;
}

interface ModelsRequest {
	guildId: string;
	apiKey: string;
	model?: string;
	github?: { installationId?: string; repo?: string };
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
	/** Why the turn failed, when the provider or agent reported a reason. */
	error?: string;
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

/** Split a stored `provider/model` reference for the session API. */
function parseModelRef(model: string): { providerID: string; id: string } | undefined {
	const at = model.indexOf("/");
	if (at <= 0 || at === model.length - 1) return undefined;
	return { providerID: model.slice(0, at), id: model.slice(at + 1) };
}

/** The error detail an SDK failure carries, if any. */
function errorDetail(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const shape = error as { message?: unknown; type?: unknown };
	if (typeof shape.message === "string" && shape.message.trim()) return shape.message.trim();
	if (typeof shape.type === "string") return shape.type;
	return undefined;
}

/**
 * What to say when a turn failed. The SDK reports the provider's own message,
 * which is far more useful than a generic apology, and the fix is almost always
 * the model or the key for this server.
 */
function failureNote(error: string): string {
	const hint = /deprecat|unavailable|not found/i.test(error)
		? "\n\nThe model for this server is no longer available — pick another in the console."
		: /credential|unauthor|401|403/i.test(error)
			? "\n\nThe key for this server was rejected — check or replace it in the console."
			: "";
	return `**That turn failed.**\n> ${error}${hint}`;
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
	/**
	 * A thread's session, and the reverse mapping.
	 *
	 * Both directions are needed, because the two sides know different things: a
	 * prompt knows the thread it belongs to, and an event knows only the session
	 * that produced it. Keeping a single map and reading it the other way round
	 * silently matches nothing, which reads as a turn that never finishes.
	 */
	private readonly sessionByThread = new Map<string, string>();
	private readonly threadBySession = new Map<string, string>();
	/** The minted MCP bearer token, reused for the object's lifetime. */
	private mcpToken: Promise<string | undefined> | undefined;
	/** The model catalogue for the current host, fetched at most once per host. */
	private models: ModelOption[] | undefined;
	/** The model already selected on a thread's session, so we only switch once. */
	private readonly appliedModels = new Map<string, string>();

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
					mcp: await this.mcpConfig(),
				},
				plugins,
			}).then(async (host) => {
				// The key is supplied as an integration credential, not as
				// `providers.<id>.settings.apiKey`. That config field is accepted by
				// the schema but never reaches provider activation, so a provider
				// configured that way stays invisible: its models do not resolve and
				// no request can be made against it. The integration store is the
				// channel the registry actually reads, it lives in this object's own
				// database, and that keeps a guild's key inside the guild's object.
				await host.integration.connect.key({
					integrationID: PROVIDER,
					key: apiKey,
					location: { directory: LOCATION },
				});
				return host;
			});
			this.host = { promise, apiKey, model, github: githubKey };
			this.consuming = undefined;
			// A different credential or model means a different catalogue.
			this.models = undefined;
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
	 *
	 * Deliberately fail-safe: if the token cannot be minted the MCP is simply
	 * omitted, because an agent that cannot reach its own MCP is far better than
	 * an agent that cannot answer at all.
	 */
	private mcpConfig(): Promise<Configuration["mcp"]> {
		this.mcpToken ??= (async () => {
			const secret = this.env.SESSION_SECRET?.trim();
			if (!secret) return undefined;
			return await mintInternalToken(secret);
		})().catch((error) => {
			log(`could not mint an MCP token, the MCP will be omitted: ${describeError(error)}`);
			this.mcpToken = undefined;
			return undefined;
		});
		return this.mcpToken.then((token) => {
			if (!token) return undefined;
			const url = this.env.MCP_INTERNAL_URL?.trim() || `${this.publicOrigin()}${MCP_PATH}`;
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
		return this.env.PUBLIC_ORIGIN?.trim().replace(/\/$/, "") || DEFAULT_MCP_URL.slice(0, -MCP_PATH.length);
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
		if (request.method === "POST" && pathname === "/session/models") {
			return await this.modelsResponse(request);
		}
		if (request.method === "GET" && pathname === "/session/status") {
			return Response.json({ guildId: this.guildId, busy: this.runs.size > 0 });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	}

	// --- Model catalogue --------------------------------------------------------

	/**
	 * The models this guild's key can reach.
	 *
	 * Read from the embedded OpenCode server rather than by reimplementing
	 * provider discovery: the SDK already knows how a provider publishes its
	 * catalogue, which entries are enabled, and what each one is called, so this
	 * is a single call. The catalogue is cached for the life of the host, so a
	 * console reload does not pay for it twice.
	 */
	private async modelsResponse(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => undefined)) as ModelsRequest | undefined;
		if (!body) return Response.json({ error: "the request could not be read" }, { status: 400 });
		if (this.guildId && body.guildId && body.guildId !== this.guildId) {
			return Response.json({ error: "guild mismatch" }, { status: 403 });
		}
		if (!body.apiKey) return Response.json({ models: [] });
		try {
			return Response.json({ models: await this.listModels(body) });
		} catch (error) {
			log(`could not list models: ${describeError(error)}`);
			return Response.json({ error: describeError(error) }, { status: 502 });
		}
	}

	private async listModels(request: ModelsRequest): Promise<ModelOption[]> {
		const host = await this.hostFor(request.apiKey, request.model ?? MODEL, request.github);
		if (!this.models) {
			const listed = await host.model.list({ location: { directory: LOCATION } });
			const wanted = listed.data.filter((entry) => entry.providerID === PROVIDER);
			// The key is issued for one provider. Should the catalogue name it
			// differently, offer everything rather than presenting an empty list.
			const provider = wanted.length > 0 ? wanted : listed.data;
			this.models = provider
				.filter((entry) => entry.status !== "deprecated")
				.map((entry) => ({
					id: `${entry.providerID}/${entry.id}`,
					name: entry.name,
					provider: entry.providerID,
					status: entry.status,
					enabled: entry.enabled,
				}))
				.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
		}
		return this.models;
	}

	// --- A turn -----------------------------------------------------------------

	private async prompt(request: PromptRequest): Promise<void> {
		const stream = new DiscordStream(this.rest, request.threadId);
		const run = this.runs.get(request.threadId) ?? {};
		const turn = createTurn(request.threadId);
		run.turn = turn;
		run.stream = stream;
		this.runs.set(request.threadId, run);

		let stopTyping: () => void = () => undefined;
		try {
			// Announced before anything slow, so the thread never sits silent while
			// the host boots.
			await stream.start();
			stopTyping = this.startTyping(request.threadId);

			const host = await this.hostFor(request.apiKey, request.model ?? MODEL, request.github);
			// The reply and the completion signal both arrive as events, so a
			// stream that died since the last turn has to be replaced before this
			// one starts; otherwise the turn would run blind until it timed out.
			this.startConsuming(host);
			const sessionID = await this.ensureSession(host, request.threadId, request.title ?? DEFAULT_THREAD_NAME);
			const baseline = await this.lastAssistantID(host, sessionID).catch(() => undefined);
			await this.applyModel(host, request.threadId, sessionID, request.model ?? MODEL);

			await host.sessions.prompt({ sessionID, text: request.text });
			const finished = await this.wait(turn);
			if (!finished) await this.interrupt(request.threadId).catch(() => undefined);

			const final = await this.finalText(host, sessionID, baseline).catch(() => undefined);
			const body = turn.error ? failureNote(turn.error) : (final ?? renderTurn(turn));
			const suffix = turn.interrupted ? "Stopped." : finished ? undefined : "Stopped after timing out.";
			await stream.finish(body, suffix);
		} catch (error) {
			log(`prompt failed: ${describeError(error)}`);
			// Always say something: a silent failure is indistinguishable from a
			// hung turn, which is exactly how a stuck "Thinking…" reads.
			await stream.finish(`I hit an error before I could finish: ${describeError(error)}`);
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

	/**
	 * Point the session at the guild's chosen model.
	 *
	 * This is not redundant with the config's `model`. In this SDK the config
	 * value does not reach session model selection at all — sessions run the
	 * catalogue's default instead, which is a free model that can be deprecated
	 * out from under the bot, failing every turn. Switching the session
	 * explicitly is what actually applies the choice.
	 */
	private async applyModel(
		host: OpenCodeWorkerd.Interface,
		threadId: string,
		sessionID: string,
		model: string,
	): Promise<void> {
		if (this.appliedModels.get(threadId) === model) return;
		const ref = parseModelRef(model);
		if (!ref) return;
		try {
			await host.sessions.switchModel({ sessionID, model: ref });
			this.appliedModels.set(threadId, model);
		} catch (error) {
			log(`could not select model ${model}: ${describeError(error)}`);
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
		const cached = this.sessionByThread.get(threadId);
		if (cached) return cached;
		const stored = await this.ctx.storage.get<string>(SESSION_PREFIX + threadId);
		if (stored) this.remember(threadId, stored);
		return stored;
	}

	/** Record that a thread is served by a session, in both directions. */
	private remember(threadId: string, sessionID: string): void {
		this.sessionByThread.set(threadId, sessionID);
		this.threadBySession.set(sessionID, threadId);
	}

	/** Forget a thread's session, so a dead session id is never reused. */
	private forget(threadId: string): void {
		const sessionID = this.sessionByThread.get(threadId);
		if (sessionID !== undefined) this.threadBySession.delete(sessionID);
		this.sessionByThread.delete(threadId);
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
				this.forget(threadId);
			}
		}

		const session = await host.sessions.create({ title, location: { directory: LOCATION } });
		this.remember(threadId, session.id);
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

	/**
	 * Subscribe to the host's event stream, which is what both the streaming
	 * reply and a turn's completion signal come from.
	 *
	 * The feed is volatile by contract: a slow consumer overflows it and the
	 * stream fails. A subscription that ends is therefore not fatal, but it does
	 * have to be replaced — otherwise every later turn in this object would run
	 * with no events at all and hang until the turn timeout. `prompt` re-ensures
	 * it at the start of every turn, and the identity guard keeps a stale
	 * subscription's teardown from clearing the one that replaced it.
	 */
	private startConsuming(host: OpenCodeWorkerd.Interface): void {
		if (this.consuming) return;
		const loop = (async () => {
			for await (const event of host.events.subscribe({ signal: this.abort?.signal })) {
				try {
					this.handleEvent(event);
				} catch (error) {
					log(`event handling failed: ${describeError(error)}`);
				}
			}
		})();
		const settled = loop
			.catch((error) => log(`event stream stopped: ${describeError(error)}`))
			.then(() => {
				if (this.consuming === settled) this.consuming = undefined;
			});
		this.consuming = settled;
	}

	private handleEvent(event: unknown): void {
		const shape = event as { type?: unknown; created?: unknown; data?: unknown };
		if (typeof shape.type !== "string" || !shape.data || typeof shape.data !== "object") return;
		const data = shape.data as Record<string, unknown>;
		const sessionID = data.sessionID;
		if (typeof sessionID !== "string") return;
		const threadId = this.threadBySession.get(sessionID);
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
			case "session.step.failed": {
				// The SDK puts the provider's own message here — "Model X has been
				// deprecated", "Invalid credential" — which is the only place the
				// real reason for a failure appears. Without it the reply can only
				// say "no output" and give no clue what to fix.
				turn.failed = true;
				turn.error ??= errorDetail(data.error);
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
