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
import { DISCORD_METADATA_KEY, type DiscordContext } from "./discord/context";
import { DiscordStream } from "./discord/stream";
import { fileStore, type FileStore } from "./opencode/store";
import { discordPlugin } from "./opencode/discord";
import { workspacePlugin } from "./opencode/workspace";
import { createGitHub } from "./github";
import { githubPlugin } from "./opencode/github";
import { mintInternalToken } from "./mcp/access";
import { MCP_PATH } from "./mcp/oauth";
import { ensureToken, readMcpServers, writeMcpServers, type McpServerRecord } from "./mcp/servers";
import type { IntegrationMethodOption, IntegrationOption, ProviderField } from "./providers";
import type { GuildConnection } from "./registry";

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

/** A model the console can offer, normalised for the dropdown. */
interface ModelOption {
	/** The `provider/model` reference the registry accepts, e.g. `openrouter/anthropic/claude-sonnet-5`. */
	id: string;
	name: string;
	provider: string;
	status: string;
	enabled: boolean;
}

/**
 * What every route into this object needs to build a host: the providers the
 * guild has connected, the model it chose, and its GitHub binding. The
 * credentials arrive per request from the gateway or the Worker, which are the
 * only things that read the registry.
 */
interface GuildRequest {
	guildId: string;
	connections: GuildConnection[];
	model?: string;
	github?: { installationId?: string; repo?: string };
}

interface PromptRequest extends GuildRequest {
	threadId: string;
	title?: string;
	text: string;
	/** The name the speaker goes by, so the agent knows who it is answering. */
	author?: string;
	/** Where the request came from in Discord, recorded on the session for the agent. */
	discord?: DiscordContext;
}

/** One step of a provider sign-in, as the console drives it. */
interface OAuthRequest extends GuildRequest {
	action: "start" | "status" | "complete" | "cancel";
	integrationID: string;
	methodID?: string;
	attemptID?: string;
	/** The code the provider showed the user, for a flow that needs one. */
	code?: string;
	/** What the flow's own form was answered with, when it asked for anything. */
	answer?: Record<string, unknown>;
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
	/** Set when the thread was deleted, so the reply has nowhere to go. */
	gone: boolean;
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
		gone: false,
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

/**
 * The message as the model should read it.
 *
 * Discord threads are multi-user and the transcript does not otherwise record
 * who spoke: without this the agent cannot tell whether it is answering the
 * person who opened the thread or someone else who just joined it.
 */
function userMessage(request: PromptRequest): string {
	const author = request.author?.trim();
	return author ? `${author}: ${request.text}` : request.text;
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

/** How a provider describes one way to connect it, as far as we read it. */
type HostIntegrationMethod =
	| { type: "key"; label?: string }
	| { type: "oauth"; id: string; label: string; form?: readonly unknown[] }
	| { type: "command"; id: string; label: string }
	| { type: "external"; id: string; label: string }
	| { type: "env"; names: readonly string[] };

/**
 * Which flows this deployment can run.
 *
 * `key` is a secret we can hold and replay, and `oauth` is a browser round trip
 * the host performs. The rest cannot work here, and are reported rather than
 * hidden so the console can say why a provider cannot be connected: `env` needs
 * an environment variable per guild, `command` needs a process to run, and
 * `external` needs a credential chain the platform provides.
 */
function describeMethod(method: HostIntegrationMethod): IntegrationMethodOption | undefined {
	switch (method.type) {
		case "key":
			return { type: "key", label: method.label?.trim() || "API key", supported: true };
		case "oauth": {
			const fields = (method.form ?? []).map(describeField);
			return {
				type: "oauth",
				id: method.id,
				label: method.label,
				// A flow that asks for something is only offered if every field it asks
				// for is one this console can actually collect.
				supported: fields.every((field) => field !== undefined),
				fields: fields.filter((field): field is ProviderField => field !== undefined),
			};
		}
		case "env":
			return { type: "env", label: `Environment variable (${method.names.join(", ")})`, supported: false };
		case "command":
			return { type: "command", label: method.label, supported: false };
		case "external":
			return { type: "external", label: method.label, supported: false };
		default:
			return undefined;
	}
}

/**
 * Project one field of a flow's form.
 *
 * The provider declares these, so this validates rather than trusts: a field of
 * a kind a Worker cannot render is left out, and the flow it belongs to is then
 * reported as unavailable rather than asking for something uncollectable.
 */
function describeField(value: unknown): ProviderField | undefined {
	if (!value || typeof value !== "object") return undefined;
	const field = value as Record<string, unknown>;
	if (typeof field.key !== "string" || !field.key) return undefined;
	const when = readConditions(field.when);
	const common = {
		key: field.key,
		...(typeof field.title === "string" ? { title: field.title } : {}),
		...(typeof field.description === "string" ? { description: field.description } : {}),
		...(field.required === true ? { required: true } : {}),
		...(when ? { when } : {}),
	};
	if (field.type === "string") {
		const options = readOptions(field.options);
		return {
			...common,
			type: "string",
			...(typeof field.placeholder === "string" ? { placeholder: field.placeholder } : {}),
			...(typeof field.default === "string" ? { default: field.default } : {}),
			...(options ? { options } : {}),
		};
	}
	if (field.type === "number" || field.type === "integer") {
		return {
			...common,
			type: field.type,
			...(typeof field.default === "number" ? { default: field.default } : {}),
		};
	}
	if (field.type === "boolean") {
		return {
			...common,
			type: "boolean",
			...(typeof field.default === "boolean" ? { default: field.default } : {}),
		};
	}
	return undefined;
}

/** A field's visibility conditions, ignoring anything malformed. */
function readConditions(value: unknown): ProviderField["when"] {
	if (!Array.isArray(value)) return undefined;
	const conditions: { key: string; op: "eq" | "neq"; value: string | number | boolean }[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const condition = entry as { key?: unknown; op?: unknown; value?: unknown };
		if (typeof condition.key !== "string") continue;
		if (condition.op !== "eq" && condition.op !== "neq") continue;
		const expected = condition.value;
		if (typeof expected !== "string" && typeof expected !== "number" && typeof expected !== "boolean") continue;
		conditions.push({ key: condition.key, op: condition.op, value: expected });
	}
	return conditions.length ? conditions : undefined;
}

/** A string field's choices, ignoring anything malformed. */
function readOptions(value: unknown): ProviderField["options"] {
	if (!Array.isArray(value)) return undefined;
	const options = value.flatMap((entry) => {
		if (!entry || typeof entry !== "object") return [];
		const option = entry as { value?: unknown; label?: unknown; description?: unknown };
		if (typeof option.value !== "string" || typeof option.label !== "string") return [];
		return [
			{
				value: option.value,
				label: option.label,
				...(typeof option.description === "string" ? { description: option.description } : {}),
			},
		];
	});
	return options.length ? options : undefined;
}

/** The live state of one thread inside this guild's object. */
interface ThreadRun {
	turn?: Turn;
	stream?: DiscordStream;
}

/** The shape the host's config wants for a remote MCP server. */
type RemoteMcpServer = {
	type: "remote";
	url: string;
	headers?: Record<string, string>;
	oauth: false;
	codemode: boolean;
};

interface Host {
	promise: Promise<OpenCodeWorkerd.Interface>;
	/** Signature of the provider set, so a changed or rotated credential rebuilds the host. */
	connections: string;
	model: string;
	/** Signature of the GitHub binding, so a config change rebuilds the host. */
	github: string;
	/** Signature of the owner's MCP servers, so connecting one rebuilds the host. */
	mcp: string;
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
	/** The guild's owner, resolved once. `null` records that Discord would not say. */
	private owner: string | null | undefined;
	/** Signature of the owner's MCP servers, so a change rebuilds the host. */
	private mcpSignature = "";
	/** The model catalogue for the current host, fetched at most once per host. */
	private models: ModelOption[] | undefined;
	/** The model already selected on a thread's session, so we only switch once. */
	private readonly appliedModels = new Map<string, string>();
	/**
	 * The Discord context already written to a thread's session, so a renamed
	 * thread updates its metadata once instead of on every turn.
	 */
	private readonly appliedContext = new Map<string, string>();

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
	 * providers the guild has connected. A changed provider set or model rebuilds
	 * the host, so a rotated credential takes effect on the next turn.
	 */
	private async hostFor(
		connections: GuildConnection[],
		model: string,
		github?: { installationId?: string; repo?: string },
	): Promise<OpenCodeWorkerd.Interface> {
		const githubKey = github ? `${github.installationId ?? ""}|${github.repo ?? ""}` : "";
		// The signature is what decides a rebuild, so it has to change when a key
		// is replaced. It lives in memory only and is never logged.
		const signature = connections
			.map((connection) => `${connection.integrationID}:${connection.method}:${connection.key}`)
			.sort()
			.join("\u0000");
		// The owner's MCP servers are read before the decision to rebuild, because
		// connecting one has to take effect on the next turn rather than whenever
		// something else happens to change the host.
		const mcp = await this.mcpConfig();
		if (
			!this.host ||
			this.host.connections !== signature ||
			this.host.model !== model ||
			this.host.github !== githubKey ||
			this.host.mcp !== this.mcpSignature
		) {
			const previous = this.host?.promise;
			this.abort?.abort();
			this.abort = new AbortController();

			const plugins = [workspacePlugin(this.files), discordPlugin()];
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
					mcp,
				},
				plugins,
			}).then(async (host) => {
				// Every provider is connected the same way: the integration the guild
				// chose and the key it gave us. Which integrations exist, and which
				// flows each one offers, is the host's business, so a provider this
				// Worker has never heard of needs nothing here.
				//
				// The credential is supplied as an integration credential, not as
				// `providers.<id>.settings.apiKey`. That config field is accepted by
				// the schema but never reaches provider activation, so a provider
				// configured that way stays invisible: its models do not resolve and
				// no request can be made against it. The integration store is the
				// channel the registry actually reads, it lives in this object's own
				// database, and that keeps a guild's keys inside the guild's object.
				for (const connection of connections) {
					// A connection with no key came from a sign-in, whose credential is
					// already in this object's own store; connecting an empty key would
					// overwrite it.
					if (!connection.key) continue;
					await host.integration
						.connect.key({
							integrationID: connection.integrationID,
							key: connection.key,
							location: { directory: LOCATION },
						})
						// One unusable credential must not cost the guild every other
						// provider it connected, so it is logged and skipped.
						.catch((error) => log(`could not connect ${connection.integrationID}: ${describeError(error)}`));
				}
				return host;
			});
			this.host = { promise, connections: signature, model, github: githubKey, mcp: this.mcpSignature };
			this.consuming = undefined;
			// A different provider set or model means a different catalogue.
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
	private async mcpConfig(): Promise<Configuration["mcp"]> {
		this.mcpToken ??= (async () => {
			const secret = this.env.SESSION_SECRET?.trim();
			if (!secret) return undefined;
			return await mintInternalToken(secret);
		})().catch((error) => {
			log(`could not mint an MCP token, the MCP will be omitted: ${describeError(error)}`);
			this.mcpToken = undefined;
			return undefined;
		});

		const servers: Record<string, RemoteMcpServer> = { ...(await this.ownerMcpServers()) };
		const token = await this.mcpToken;
		if (token) {
			const url = this.env.MCP_INTERNAL_URL?.trim() || `${this.publicOrigin()}${MCP_PATH}`;
			servers.eryn = {
				type: "remote",
				url,
				headers: { Authorization: `Bearer ${token}` },
				// Eryn's own token is already minted; never start a login flow.
				oauth: false,
				codemode: false,
			};
		}
		return Object.keys(servers).length ? { servers } : undefined;
	}

	/**
	 * The MCP servers the guild's owner has connected, as the agent's own config.
	 *
	 * They are the owner's rather than the guild's because they are a person's
	 * tools: the same set follows them into every server they run Eryn in. The
	 * token is refreshed here and written back, so the registry keeps a usable
	 * one, and the agent is handed a plain bearer header — OpenCode's own MCP
	 * client cannot complete an OAuth flow inside a Worker, because it waits for
	 * the callback on a `127.0.0.1` listener.
	 */
	private async ownerMcpServers(): Promise<Record<string, RemoteMcpServer>> {
		const ownerId = await this.ownerId();
		if (!ownerId) return {};
		const servers = await readMcpServers(this.env, ownerId).catch(() => [] as McpServerRecord[]);
		const enabled = servers.filter((server) => server.enabled && server.name !== "eryn");
		this.mcpSignature = enabled.map((server) => `${server.name}:${server.url}`).join("|");
		if (!enabled.length) return {};

		const config: Record<string, RemoteMcpServer> = {};
		const refreshed = new Map<string, McpServerRecord>();
		for (const server of enabled) {
			const resolved: { token?: string; updated?: McpServerRecord } = await ensureToken(server).catch(() => ({}));
			const { token, updated } = resolved;
			if (updated) refreshed.set(server.id, updated);
			config[server.name] = {
				type: "remote",
				url: server.url,
				// A stored token is presented directly, so no flow is ever started.
				oauth: false,
				codemode: false,
				...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
			};
		}
		if (refreshed.size) {
			await writeMcpServers(
				this.env,
				ownerId,
				servers.map((server) => refreshed.get(server.id) ?? server),
			).catch((error) => log(`could not store a refreshed MCP token: ${describeError(error)}`));
		}
		return config;
	}

	/** The guild's owner, resolved once per object. */
	private async ownerId(): Promise<string | undefined> {
		if (this.owner === undefined) this.owner = (await this.rest.guildOwner(this.guildId).catch(() => undefined)) ?? null;
		return this.owner ?? undefined;
	}

	private publicOrigin(): string {
		return this.env.PUBLIC_ORIGIN?.trim().replace(/\/$/, "") || DEFAULT_MCP_URL.slice(0, -MCP_PATH.length);
	}

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		if (request.method === "POST" && pathname === "/session/prompt") {
			const body = (await request.json()) as PromptRequest;
			if (!Array.isArray(body.connections) || body.connections.length === 0) {
				return Response.json({ ok: false, error: "no provider is connected" }, { status: 400 });
			}
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
			const body = (await request.json().catch(() => ({}))) as { threadId?: string; gone?: boolean };
			return Response.json({ stopped: await this.interrupt(body.threadId, body.gone === true) });
		}
		if (request.method === "POST" && pathname === "/session/models") {
			return await this.modelsResponse(request);
		}
		if (request.method === "POST" && pathname === "/session/integrations") {
			return await this.integrationsResponse(request);
		}
		if (request.method === "POST" && pathname === "/session/oauth") {
			return await this.oauthResponse(request);
		}
		if (request.method === "POST" && pathname === "/session/disconnect") {
			return await this.disconnectResponse(request);
		}
		if (request.method === "GET" && pathname === "/session/status") {
			return Response.json({ guildId: this.guildId, busy: this.runs.size > 0 });
		}
		return Response.json({ error: "not found" }, { status: 404 });
	}

	// --- Provider catalogue -----------------------------------------------------

	/**
	 * The models the guild's connected providers can reach.
	 *
	 * Read from the embedded OpenCode server rather than by reimplementing
	 * provider discovery: the SDK already knows how a provider publishes its
	 * catalogue, which entries are enabled, and what each one is called, so this
	 * is a single call. The catalogue is cached for the life of the host, so a
	 * console reload does not pay for it twice.
	 */
	private async modelsResponse(request: Request): Promise<Response> {
		const body = await this.guildRequest<GuildRequest>(request);
		if (body instanceof Response) return body;
		try {
			return Response.json({ models: await this.listModels(body) });
		} catch (error) {
			log(`could not list models: ${describeError(error)}`);
			return Response.json({ error: describeError(error) }, { status: 502 });
		}
	}

	/** Parse a guild request, or the response to send back when it is unusable. */
	private async guildRequest<T extends GuildRequest>(request: Request): Promise<T | Response> {
		const body = (await request.json().catch(() => undefined)) as T | undefined;
		if (!body) return Response.json({ error: "the request could not be read" }, { status: 400 });
		if (this.guildId && body.guildId && body.guildId !== this.guildId) {
			return Response.json({ error: "guild mismatch" }, { status: 403 });
		}
		return { ...body, connections: Array.isArray(body.connections) ? body.connections : [] };
	}

	/**
	 * The models of every provider the guild has connected.
	 *
	 * Nothing connected means an empty list rather than every model in the
	 * catalogue: offering a model whose provider has no credential would promise
	 * something a turn cannot do.
	 */
	private async listModels(request: GuildRequest): Promise<ModelOption[]> {
		const host = await this.hostFor(request.connections, request.model ?? MODEL, request.github);
		if (!this.models) {
			const connected = await this.connectedProviders(host);
			const listed = await host.model.list({ location: { directory: LOCATION } });
			this.models = listed.data
				.filter((entry) => entry.status !== "deprecated" && connected.has(entry.providerID))
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

	/**
	 * The integrations that currently hold a credential.
	 *
	 * A provider id and its integration id are the same thing — that is how
	 * models.dev registers them — which is what lets the model catalogue be
	 * narrowed to what the guild can actually use.
	 */
	private async connectedProviders(host: OpenCodeWorkerd.Interface): Promise<Set<string>> {
		const listed = await host.integration.list({ location: { directory: LOCATION } });
		return new Set(listed.data.filter((entry) => entry.connections.length > 0).map((entry) => String(entry.id)));
	}

	/**
	 * The providers a guild could connect, and the flows each one offers.
	 *
	 * The list is the host's, not ours: models.dev describes the providers and
	 * each provider's own plugin adds whatever else it supports, so a provider
	 * added upstream shows up here without a change in this Worker.
	 */
	private async integrationsResponse(request: Request): Promise<Response> {
		const body = await this.guildRequest<GuildRequest>(request);
		if (body instanceof Response) return body;
		try {
			const host = await this.hostFor(body.connections, body.model ?? MODEL, body.github);
			const listed = await host.integration.list({ location: { directory: LOCATION } });
			const integrations: IntegrationOption[] = listed.data
				.map((integration) => ({
					id: String(integration.id),
					name: integration.name || String(integration.id),
					connected: integration.connections.length > 0,
					methods: integration.methods
						.map(describeMethod)
						.filter((method): method is IntegrationMethodOption => method !== undefined),
				}))
				// A provider whose methods we cannot describe at all is dropped. Ones we
				// can describe but cannot run stay, so the console can still name a
				// provider a server connected before it changed shape.
				.filter((integration) => integration.methods.length > 0)
				.sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
			return Response.json({ integrations });
		} catch (error) {
			log(`could not list integrations: ${describeError(error)}`);
			return Response.json({ error: describeError(error) }, { status: 502 });
		}
	}

	/**
	 * Drive one step of a provider sign-in.
	 *
	 * The host owns the flow — it opens the browser round trip and keeps the
	 * credential that comes back — so this only starts it, reports its status,
	 * and finishes it when the provider asks for a code.
	 */
	private async oauthResponse(request: Request): Promise<Response> {
		const body = await this.guildRequest<OAuthRequest>(request);
		if (body instanceof Response) return body;
		if (!body.integrationID) return Response.json({ error: "an integration is required" }, { status: 400 });
		try {
			const host = await this.hostFor(body.connections, body.model ?? MODEL, body.github);
			const location = { directory: LOCATION };
			if (body.action === "start") {
				const attempt = await host.integration.oauth.connect({
					integrationID: body.integrationID,
					methodID: body.methodID ?? "",
					// The provider validates this against its own form, so it is passed
					// through as given rather than shaped here.
					answer: (body.answer ?? {}) as Record<string, string | number | boolean>,
					location,
				});
				return Response.json({ attempt: attempt.data });
			}
			if (!body.attemptID) return Response.json({ error: "an attempt is required" }, { status: 400 });
			if (body.action === "status") {
				const status = await host.integration.oauth.status({
					integrationID: body.integrationID,
					attemptID: body.attemptID,
					location,
				});
				// A finished sign-in adds a credential, which changes what the model
				// catalogue should contain.
				if (status.data.status === "complete") this.models = undefined;
				return Response.json({ status: status.data });
			}
			if (body.action === "complete") {
				await host.integration.oauth.complete({
					integrationID: body.integrationID,
					attemptID: body.attemptID,
					code: body.code,
					location,
				});
				this.models = undefined;
				return Response.json({ ok: true });
			}
			await host.integration.oauth.cancel({
				integrationID: body.integrationID,
				attemptID: body.attemptID,
				location,
			});
			return Response.json({ ok: true });
		} catch (error) {
			log(`provider sign-in failed: ${describeError(error)}`);
			return Response.json({ error: describeError(error) }, { status: 502 });
		}
	}

	/**
	 * Drop every credential for one integration.
	 *
	 * A key is forgotten by removing it from the registry, but an OAuth
	 * credential lives in this object's own store, so it has to be removed here
	 * too or clearing a provider would leave it connected.
	 */
	private async disconnectResponse(request: Request): Promise<Response> {
		const body = (await request.json().catch(() => undefined)) as
			| (GuildRequest & { integrationID?: string })
			| undefined;
		if (!body?.integrationID) return Response.json({ error: "an integration is required" }, { status: 400 });
		if (this.guildId && body.guildId && body.guildId !== this.guildId) {
			return Response.json({ error: "guild mismatch" }, { status: 403 });
		}
		try {
			const host = await this.hostFor(body.connections ?? [], body.model ?? MODEL, body.github);
			const credentials = await host.credential.list();
			let removed = 0;
			for (const entry of credentials) {
				if (String(entry.integrationID) !== body.integrationID) continue;
				await host.credential.remove({ credentialID: entry.id });
				removed += 1;
			}
			if (removed > 0) this.models = undefined;
			return Response.json({ ok: true, removed });
		} catch (error) {
			log(`could not disconnect ${body.integrationID}: ${describeError(error)}`);
			return Response.json({ error: describeError(error) }, { status: 502 });
		}
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

			const host = await this.hostFor(request.connections, request.model ?? MODEL, request.github);
			// The reply and the completion signal both arrive as events, so a
			// stream that died since the last turn has to be replaced before this
			// one starts; otherwise the turn would run blind until it timed out.
			this.startConsuming(host);
			const sessionID = await this.ensureSession(host, request.threadId, request.title ?? DEFAULT_THREAD_NAME);
			// The context has to be on the session before the first request, because
			// that is where the plugin reads it from.
			await this.applyDiscord(host, request.threadId, sessionID, request.discord);
			const baseline = await this.lastAssistantID(host, sessionID).catch(() => undefined);
			await this.applyModel(host, request.threadId, sessionID, request.model ?? MODEL);

			await host.sessions.prompt({ sessionID, text: userMessage(request) });
			const finished = await this.wait(turn);
			if (!finished) await this.interrupt(request.threadId).catch(() => undefined);

			if (turn.gone) {
				// The thread was deleted mid-turn: there is nowhere to put the
				// reply and no one left to read it, so the spinner is stopped
				// without writing anything to a channel that no longer exists.
				stream.abandon();
				log(`thread ${request.threadId} was deleted, so the reply was dropped`);
			} else {
				const final = await this.finalText(host, sessionID, baseline).catch(() => undefined);
				const body = turn.error ? failureNote(turn.error) : (final ?? renderTurn(turn));
				const suffix = turn.interrupted ? "Stopped." : finished ? undefined : "Stopped after timing out.";
				await stream.finish(body, suffix);
			}
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

	/**
	 * Record where the request came from on the thread's session, so the
	 * `eryn.discord` plugin can tell the agent about it.
	 *
	 * It is stored on the session rather than held by the plugin, because the
	 * plugin is per host and the host serves every thread in the guild: the
	 * context has to travel with the request. A rename or a move updates it, so
	 * the write is skipped while the context is unchanged — every turn but the
	 * first, and the first after a rename.
	 */
	private async applyDiscord(
		host: OpenCodeWorkerd.Interface,
		threadId: string,
		sessionID: string,
		discord: DiscordContext | undefined,
	): Promise<void> {
		if (!discord) return;
		const signature = JSON.stringify(discord);
		if (this.appliedContext.get(threadId) === signature) return;
		try {
			const session = await host.sessions.get({ sessionID });
			await host.sessions.update({
				sessionID,
				// Merged, so a context write cannot drop metadata some other
				// plugin put on the session.
				metadata: { ...session.metadata, [DISCORD_METADATA_KEY]: discord },
			});
			this.appliedContext.set(threadId, signature);
		} catch (error) {
			// A context the agent cannot read costs it a hint; it must never cost
			// the turn, so this is logged and dropped.
			log(`could not record the Discord context for ${threadId}: ${describeError(error)}`);
		}
	}

	/**
	 * Cancel a thread's running turn, keeping its session for later messages.
	 *
	 * `gone` means the thread itself was deleted, which is not the same as a
	 * stopped turn: there is no message left to write the outcome into, so the
	 * reply is dropped rather than attempted.
	 */
	private async interrupt(threadId: string | undefined, gone = false): Promise<boolean> {
		const run = threadId ? this.runs.get(threadId) : undefined;
		const sessionID = threadId ? await this.sessionFor(threadId) : undefined;
		if (!run?.turn || !this.host || !sessionID) return false;
		if (gone) run.turn.gone = true;
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
