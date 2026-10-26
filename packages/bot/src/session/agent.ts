/**
 * The guild's embedded OpenCode host, provider catalogue, and turn machinery.
 *
 * One instance per guild object. It builds the host lazily from the guild's
 * connected providers, its chosen model, and its linked MCP servers; a change
 * to any of them rebuilds it, so a rotated key or a new link takes effect on
 * the next turn. A prompt runs the agent turn and streams the reply into the
 * Discord thread.
 */

import { Context, Effect, Layer } from "effect";
import { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import type { Configuration } from "@opencode/sdk/workerd";
import type { Plugin as PromisePlugin } from "@opencode/plugin";

import { DEFAULT_MODEL, intFromEnv, log } from "../config";
import { botError, describeError } from "../errors";
import { DEFAULT_THREAD_NAME, type DiscordRest } from "../discord/api";
import { DISCORD_METADATA_KEY, type DiscordContext } from "../discord/context";
import { DiscordStream } from "../discord/stream";
import { DiscordApi } from "../discord/api";
import { Workspace } from "../opencode/store";
import { workspacePlugin } from "../opencode/workspace";
import { discordPlugin } from "../opencode/discord";
import mcpeventsPlugin from "../plugins/mcpevents";
import type { FileStore } from "../opencode/store";
import {
	type GuildConfig,
	type IntegrationMethodOption,
	type IntegrationOption,
	type McpLink,
	type ModelOption,
	type OAuthAttempt,
	type OAuthStatus,
	type PromptRequest,
	type ProviderConnection,
	type ProviderField,
} from "./models";

/** Namespace used for every session in this Worker. The workerd profile has no real filesystem. */
const LOCATION = "/eryn";
const DEFAULT_TURN_TIMEOUT_SECONDS = 900;

/** Everything the host needs to be built, and to decide whether to rebuild. */
export interface HostConfig {
	readonly connections: readonly ProviderConnection[];
	readonly model: string;
	readonly links: readonly McpLink[];
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
	/** Signature of the linked MCP servers, so adding one rebuilds the host. */
	mcp: string;
}

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
		? "\n\nThe model for this server is no longer available — pick another with `/eryn setup model`."
		: /credential|unauthor|401|403/i.test(error)
			? "\n\nThe key for this server was rejected — check or replace it with `/eryn setup provider`."
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
 * hidden so the setup command can say why a provider cannot be connected.
 */
function describeMethod(method: HostIntegrationMethod): IntegrationMethodOption | undefined {
	const label = (fallback: string) => {
		const value = (method as { label?: unknown }).label;
		return typeof value === "string" && value.trim() ? value.trim() : fallback;
	};
	switch (method.type) {
		case "key":
			return { type: "key", label: label("API key"), supported: true };
		case "oauth": {
			const fields = (Array.isArray(method.form) ? method.form : []).map(describeField);
			return {
				type: "oauth",
				id: typeof method.id === "string" ? method.id : "",
				label: label("Sign in"),
				supported: fields.every((field) => field !== undefined),
				fields: fields.filter((field): field is ProviderField => field !== undefined),
			};
		}
		case "env": {
			const names = (Array.isArray(method.names) ? method.names : []).filter(
				(name): name is string => typeof name === "string",
			);
			return {
				type: "env",
				label: names.length ? `Environment variable (${names.join(", ")})` : "Environment variable",
				supported: false,
			};
		}
		case "command":
			return { type: "command", label: label("Run a command"), supported: false };
		case "external":
			return { type: "external", label: label("External credential"), supported: false };
		default:
			return undefined;
	}
}

/**
 * Project one field of a flow's form. The provider declares these, so this
 * validates rather than trusts: a field of a kind a Worker cannot render is
 * left out, and the flow it belongs to is then reported as unavailable.
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

/**
 * Whether a sign-in sends the browser back to the machine running this Worker.
 *
 * Several of OpenCode's provider flows open a listener on `127.0.0.1` and wait
 * for the provider to redirect to it. That cannot work here: a Worker has no
 * inbound socket, and the address names the *caller's* machine. The only trace
 * is the redirect in the URL the flow hands back, so that is what is inspected.
 */
function needsLocalCallback(url: string): boolean {
	try {
		const redirect = new URL(url).searchParams.get("redirect_uri");
		if (!redirect) return false;
		const host = new URL(redirect).hostname.toLowerCase().replace(/^\[|\]$/g, "");
		return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
	} catch {
		return false;
	}
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

/** Models preferred when a guild has not chosen one (or chose a free one). */
const PREFERRED_MODELS = [
	"deepseek-v4.1-flash",
	"claude-sonnet-4-5",
	"claude-sonnet-4-6",
	"gpt-5",
	"gpt-5.1",
	"gemini-2.5-pro",
];

/** The service surface the session object drives. */
export interface GuildAgentShape {
	integrations(config: HostConfig): Promise<IntegrationOption[]>;
	models(config: HostConfig): Promise<ModelOption[]>;
	resolveModel(config: HostConfig): Promise<string>;
	connectKey(config: HostConfig, integrationID: string, key: string): Promise<void>;
	oauthConnect(
		config: HostConfig,
		integrationID: string,
		methodID: string,
		answer: Record<string, string | number | boolean>,
	): Promise<OAuthAttempt | { error: string }>;
	oauthStatus(config: HostConfig, integrationID: string, attemptID: string): Promise<OAuthStatus>;
	oauthComplete(config: HostConfig, integrationID: string, attemptID: string, code: string | undefined): Promise<void>;
	oauthCancel(config: HostConfig, integrationID: string, attemptID: string): Promise<void>;
	disconnect(config: HostConfig, integrationID: string): Promise<number>;
	prompt(request: PromptRequest, config: HostConfig): Promise<void>;
	interrupt(threadId: string | undefined, gone: boolean): Promise<boolean>;
}

class GuildAgentImpl implements GuildAgentShape {
	private host: Host | undefined;
	private abort: AbortController | undefined;
	private consuming: Promise<void> | undefined;
	/** The model catalogue for the current host, fetched at most once per host. */
	private modelCache: ModelOption[] | undefined;

	/** In-memory turn state per thread; a thread's session id is persisted. */
	private readonly runs = new Map<string, ThreadRun>();
	/**
	 * A thread's session, and the reverse mapping.
	 *
	 * Both directions are needed: a prompt knows the thread it belongs to, and an
	 * event knows only the session that produced it. Keeping a single map and
	 * reading it the other way round silently matches nothing.
	 */
	private readonly sessionByThread = new Map<string, string>();
	private readonly threadBySession = new Map<string, string>();
	/** The model already selected on a thread's session, so we only switch once. */
	private readonly appliedModels = new Map<string, string>();
	/** The Discord context already written to a thread's session. */
	private readonly appliedContext = new Map<string, string>();

	constructor(
		private readonly env: Env,
		private readonly storage: DurableObjectStorage,
		private readonly files: FileStore,
		private readonly rest: DiscordRest,
		private readonly turnTimeoutMs: number,
	) {}

	// --- Host -----------------------------------------------------------------

	private mcpConfig(links: readonly McpLink[]): Configuration["mcp"] {
		const servers: Record<string, RemoteMcpServer> = {};
		for (const link of links) {
			servers[link.name] = {
				type: "remote",
				url: link.url,
				oauth: false,
				codemode: false,
				...(link.token ? { headers: { Authorization: `Bearer ${link.token}` } } : {}),
			};
		}
		return Object.keys(servers).length ? { servers } : undefined;
	}

	/**
	 * The embedded OpenCode host for this guild, built on first use and rebuilt
	 * when the provider set, the model, or the linked MCP servers change.
	 */
	private async hostFor(config: HostConfig): Promise<OpenCodeWorkerd.Interface> {
		const signature = config.connections
			.map((connection) => `${connection.integrationID}:${connection.method}:${connection.key}`)
			.sort()
			.join("\u0000");
		const mcp = this.mcpConfig(config.links);
		const mcpSignature = config.links
			.map((link) => `${link.id}:${link.url}:${link.token ?? ""}`)
			.sort()
			.join("|");

		if (
			!this.host ||
			this.host.connections !== signature ||
			this.host.model !== config.model ||
			this.host.mcp !== mcpSignature
		) {
			const previous = this.host?.promise;
			this.abort?.abort();
			this.abort = new AbortController();

			// All three are promise-API plugins, which is what this host accepts. The
			// MCP-events plugin parses upstream envelopes with Effect Schema, but its
			// lifecycle is the promise plugin API.
			const plugins: PromisePlugin.Plugin[] = [
				workspacePlugin(this.files),
				discordPlugin(),
				mcpeventsPlugin,
			];

			const promise = OpenCodeWorkerd.create({
				storage: this.storage,
				config: {
					model: config.model,
					default_agent: "build",
					permissions: [{ action: "*", resource: "*", effect: "allow" }],
					mcp,
				},
				plugins,
			}).then(async (host) => {
				// Every provider is connected the same way: the integration the guild
				// chose and the key it gave us. The credential is supplied as an
				// integration credential, not as `providers.<id>.settings.apiKey`,
				// because only the integration store reaches provider activation.
				//
				// Connecting is idempotent: the provider records the host persists are
				// bound to a credential id, so minting a fresh credential on every host
				// build would leave every known model unreachable (`provider.no-route`)
				// after each restart. Reuse the credential for this key, and clear out
				// the duplicates earlier builds left behind.
				const credentials = await host.credential.list().catch(() => []);
				for (const connection of config.connections) {
					if (!connection.key) continue;
					const owned = credentials.filter((entry) => entry.integrationID === connection.integrationID);
					const existing = owned.find(
						(entry) => entry.value.type === "key" && entry.value.key === connection.key,
					);
					try {
						if (!existing) {
							await host.integration.connect.key({
								integrationID: connection.integrationID,
								key: connection.key,
								location: { directory: LOCATION },
							});
							continue;
						}
						if (!existing.active) await host.credential.activate({ credentialID: existing.id });
						for (const stale of owned) {
							if (stale.id === existing.id) continue;
							if (stale.value.type !== "key" || stale.value.key !== connection.key) continue;
							await host.credential.remove({ credentialID: stale.id }).catch(() => undefined);
						}
					} catch (error) {
						log("session", `could not connect ${connection.integrationID}: ${describeError(error)}`);
					}
				}
				return host;
			});
			this.host = { promise, connections: signature, model: config.model, mcp: mcpSignature };
			this.consuming = undefined;
			// A different provider set or model means a different catalogue.
			this.modelCache = undefined;
			void promise
				.then((host) => this.startConsuming(host))
				.catch((error) => log("session", `could not start the event stream: ${describeError(error)}`));
			void previous?.then((host) => host.close()).catch(() => undefined);
		}
		return this.host.promise;
	}

	// --- Catalogue ------------------------------------------------------------

	async integrations(config: HostConfig): Promise<IntegrationOption[]> {
		const host = await this.hostFor(config);
		const listed = await host.integration.list({ location: { directory: LOCATION } });
		const integrations: IntegrationOption[] = [];
		for (const entry of Array.isArray(listed.data) ? listed.data : []) {
			try {
				integrations.push({
					id: String(entry.id),
					name: entry.name || String(entry.id),
					connected: Array.isArray(entry.connections) && entry.connections.length > 0,
					methods: (Array.isArray(entry.methods) ? entry.methods : [])
						.map(describeMethod)
						.filter((method): method is IntegrationMethodOption => method !== undefined),
				});
			} catch (error) {
				log("session", `could not describe ${String((entry as { id?: unknown }).id)}: ${describeError(error)}`);
			}
		}
		integrations.sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
		return integrations;
	}

	/**
	 * Every model the host knows about, with the connected providers first.
	 *
	 * Not only the connected ones: a provider the deployment can reach but that
	 * nobody has connected still has a catalogue worth showing, and the picker
	 * marks it unavailable.
	 */
	async models(config: HostConfig): Promise<ModelOption[]> {
		return await this.listModels(config);
	}

	/**
	 * The model a turn should use.
	 *
	 * A guild can connect a provider while the stored model still names another
	 * one — the default names `opencode-go`, but a guild may have connected
	 * `opencode`. That model cannot run, and the turn would produce nothing, so
	 * fall back to a model from a provider that is actually connected.
	 */
	async resolveModel(config: HostConfig): Promise<string> {
		const provider = config.model.split("/")[0] ?? "";
		const connected = config.connections.some((connection) => connection.integrationID === provider);
		// A `-free` model is the host's fallback rather than a choice worth
		// keeping: it is the one that tends to return nothing, and the provider
		// the guild connected has real models.
		if (connected && !/-free$/i.test(config.model)) return config.model;

		const models = await this.listModels(config).catch(() => [] as ModelOption[]);
		const candidates = models.filter((entry) => entry.connected && entry.enabled);
		const preferred = PREFERRED_MODELS.map((name) => candidates.find((entry) => entry.id.endsWith(`/${name}`))).find(
			(entry) => entry !== undefined,
		);
		const fallback =
			preferred ??
			candidates.find((entry) => !/-free$/i.test(entry.id)) ??
			candidates[0] ??
			models.find((entry) => entry.connected);
		if (!fallback || fallback.id === config.model) return config.model;
		log("session", `using ${fallback.id} instead of ${config.model}`);
		return fallback.id;
	}

	private async listModels(config: HostConfig): Promise<ModelOption[]> {
		const host = await this.hostFor(config);
		// An empty catalogue is not an answer worth caching: a host built just
		// after a credential is connected can snapshot the provider registry before
		// it sees that credential, and caching that would make `/eryn setup model`
		// say "connect a provider" forever.
		if (this.modelCache?.length) return this.modelCache;

		const connected = await this.connectedProviders(host).catch(() => new Set<string>());
		let listed = await host.model.list({ location: { directory: LOCATION } });
		if (!listed.data.length) {
			// Reloading the location re-reads credentials and providers; retry once.
			await host.location.reload().catch(() => undefined);
			listed = await host.model.list({ location: { directory: LOCATION } }).catch(() => listed);
		}
		if (!listed.data.length) {
			// As a last resort ask for the host's default; a single model is still a
			// catalogue the picker can offer.
			const fallback = await host.model.default({ location: { directory: LOCATION } }).catch(() => undefined);
			if (fallback?.data) listed = { ...listed, data: [fallback.data] };
		}

		this.modelCache = listed.data
			.filter((entry) => entry.status !== "deprecated")
			.map((entry) => ({
				id: `${entry.providerID}/${entry.id}`,
				name: entry.name,
				provider: entry.providerID,
				status: entry.status,
				enabled: entry.enabled,
				connected: connected.has(entry.providerID),
			}))
			.sort(
				(a, b) =>
					Number(b.connected) - Number(a.connected) ||
					Number(b.enabled) - Number(a.enabled) ||
					a.name.localeCompare(b.name),
			);
		return this.modelCache;
	}

	/** The integrations that currently hold a credential. */
	private async connectedProviders(host: OpenCodeWorkerd.Interface): Promise<Set<string>> {
		const listed = await host.integration.list({ location: { directory: LOCATION } });
		return new Set(listed.data.filter((entry) => entry.connections.length > 0).map((entry) => String(entry.id)));
	}

	// --- Provider sign-in -----------------------------------------------------

	async connectKey(config: HostConfig, integrationID: string, key: string): Promise<void> {
		const host = await this.hostFor(config);
		await host.integration.connect.key({ integrationID, key, location: { directory: LOCATION } });
	}

	async oauthConnect(
		config: HostConfig,
		integrationID: string,
		methodID: string,
		answer: Record<string, string | number | boolean>,
	): Promise<OAuthAttempt | { error: string }> {
		const host = await this.hostFor(config);
		const location = { directory: LOCATION };
		const attempt = await host.integration.oauth.connect({ integrationID, methodID, answer, location });
		// Offering the flow and then bouncing the browser to a port on its own
		// machine is worse than saying no: the flow is cancelled, and the caller is
		// told what to do instead. A device-code flow never sends the browser back
		// to us, so it is exempt.
		if (attempt.data.mode !== "code" && needsLocalCallback(attempt.data.url)) {
			await host.integration.oauth
				.cancel({ integrationID, attemptID: attempt.data.attemptID, location })
				.catch(() => undefined);
			const name = await host.integration
				.get({ integrationID, location })
				.then((found) => found.data?.name)
				.catch(() => undefined);
			return {
				error: `${name ?? integrationID} signs in through a callback on your own machine, which this deployment cannot receive. Connect it with an API key instead.`,
			};
		}
		return attempt.data;
	}

	async oauthStatus(config: HostConfig, integrationID: string, attemptID: string): Promise<OAuthStatus> {
		const host = await this.hostFor(config);
		const status = await host.integration.oauth.status({ integrationID, attemptID, location: { directory: LOCATION } });
		// A finished sign-in adds a credential, which changes the catalogue.
		if (status.data.status === "complete") this.modelCache = undefined;
		return { status: status.data.status };
	}

	async oauthComplete(config: HostConfig, integrationID: string, attemptID: string, code: string | undefined): Promise<void> {
		const host = await this.hostFor(config);
		await host.integration.oauth.complete({ integrationID, attemptID, code, location: { directory: LOCATION } });
		this.modelCache = undefined;
	}

	async oauthCancel(config: HostConfig, integrationID: string, attemptID: string): Promise<void> {
		const host = await this.hostFor(config);
		await host.integration.oauth.cancel({ integrationID, attemptID, location: { directory: LOCATION } });
	}

	/**
	 * Drop every credential for one integration. A key is forgotten by removing
	 * it from storage, but an OAuth credential lives in the host's own store, so
	 * it has to be removed here too.
	 */
	async disconnect(config: HostConfig, integrationID: string): Promise<number> {
		const host = await this.hostFor(config);
		const credentials = await host.credential.list();
		let removed = 0;
		for (const entry of credentials) {
			if (String(entry.integrationID) !== integrationID) continue;
			await host.credential.remove({ credentialID: entry.id });
			removed += 1;
		}
		if (removed > 0) this.modelCache = undefined;
		return removed;
	}

	// --- A turn ---------------------------------------------------------------

	async prompt(request: PromptRequest, config: HostConfig): Promise<void> {
		const stream = new DiscordStream(this.rest, request.threadId);
		const run = this.runs.get(request.threadId) ?? {};
		const turn = createTurn(request.threadId);
		run.turn = turn;
		run.stream = stream;
		this.runs.set(request.threadId, run);

		let stopTyping: () => void = () => undefined;
		try {
			await stream.start();
			stopTyping = this.startTyping(request.threadId);

			const host = await this.hostFor(config);
			// The reply and the completion signal both arrive as events, so a stream
			// that died since the last turn has to be replaced before this one starts.
			this.startConsuming(host);
			const sessionID = await this.ensureSession(host, request.threadId, request.title ?? DEFAULT_THREAD_NAME);
			await this.applyDiscord(host, request.threadId, sessionID, request.discord);
			const baseline = await this.lastAssistantID(host, sessionID).catch(() => undefined);
			await this.applyModel(host, request.threadId, sessionID, config.model);

			await host.sessions.prompt({ sessionID, text: userMessage(request) });
			const finished = await this.wait(turn);
			if (!finished) await this.interrupt(request.threadId, false).catch(() => undefined);

			if (turn.gone) {
				// The thread was deleted mid-turn: there is nowhere to put the reply
				// and no one left to read it, so the spinner is stopped silently.
				stream.abandon();
				log("session", `thread ${request.threadId} was deleted, so the reply was dropped`);
			} else {
				const final = await this.finalText(host, sessionID, baseline).catch(() => undefined);
				const text = final ?? renderTurn(turn);
				const body = turn.error
					? failureNote(turn.error)
					: text.trim() ||
						`The model \`${config.model}\` returned no text. If it is not connected, pick one with \`/eryn setup model\`.`;
				const suffix = turn.interrupted ? "Stopped." : finished ? undefined : "Stopped after timing out.";
				await stream.finish(body, suffix);
			}
		} catch (error) {
			log("session", `prompt failed: ${describeError(error)}`);
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
				this.runs.delete(request.threadId);
			}
		}
	}

	/**
	 * Point the session at the guild's chosen model. In this SDK the config value
	 * does not reach session model selection, so switching the session explicitly
	 * is what actually applies the choice.
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
			log("session", `could not select model ${model}: ${describeError(error)}`);
		}
	}

	/**
	 * Record where the request came from on the thread's session, so the
	 * `eryn.discord` plugin can tell the agent about it.
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
				// Merged, so a context write cannot drop metadata another plugin put there.
				metadata: { ...session.metadata, [DISCORD_METADATA_KEY]: discord },
			});
			this.appliedContext.set(threadId, signature);
		} catch (error) {
			log("session", `could not record the Discord context for ${threadId}: ${describeError(error)}`);
		}
	}

	/**
	 * Cancel a thread's running turn, keeping its session for later messages.
	 * `gone` means the thread itself was deleted, so the reply is dropped rather
	 * than attempted.
	 */
	async interrupt(threadId: string | undefined, gone: boolean): Promise<boolean> {
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

	// --- Sessions -------------------------------------------------------------

	private async sessionFor(threadId: string): Promise<string | undefined> {
		const cached = this.sessionByThread.get(threadId);
		if (cached) return cached;
		const stored = await this.storage.get<unknown>(`session:${threadId}`);
		if (typeof stored === "string") this.remember(threadId, stored);
		return typeof stored === "string" ? stored : undefined;
	}

	private remember(threadId: string, sessionID: string): void {
		this.sessionByThread.set(threadId, sessionID);
		this.threadBySession.set(sessionID, threadId);
	}

	private forget(threadId: string): void {
		const sessionID = this.sessionByThread.get(threadId);
		if (sessionID !== undefined) this.threadBySession.delete(sessionID);
		this.sessionByThread.delete(threadId);
	}

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
		await this.storage.put(`session:${threadId}`, session.id);
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

	// --- Event stream ---------------------------------------------------------

	/**
	 * Subscribe to the host's event stream, which is where the streaming reply
	 * and the turn's completion signal come from. The feed is volatile: a
	 * subscription that ends has to be replaced, so `prompt` re-ensures it.
	 */
	private startConsuming(host: OpenCodeWorkerd.Interface): void {
		if (this.consuming) return;
		const loop = (async () => {
			for await (const event of host.events.subscribe({ signal: this.abort?.signal })) {
				try {
					this.handleEvent(event);
				} catch (error) {
					log("session", `event handling failed: ${describeError(error)}`);
				}
			}
		})();
		const settled = loop
			.catch((error) => log("session", `event stream stopped: ${describeError(error)}`))
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
				// The SDK puts the provider's own message here, which is the only
				// place the real reason for a failure appears.
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

/** The guild's agent as a service. */
export class GuildAgent extends Context.Service<GuildAgent, GuildAgentShape>()("eryn/bot/GuildAgent") {
	static layer(env: Env, storage: DurableObjectStorage): Layer.Layer<GuildAgent, never, Workspace | DiscordApi> {
		const timeout =
			intFromEnv(env.DISCORD_TURN_TIMEOUT_SECONDS, DEFAULT_TURN_TIMEOUT_SECONDS, 30, 3_600) * 1_000;
		return Layer.effect(
			this,
			Effect.gen(function* () {
				const workspace = yield* Workspace;
				const rest = yield* DiscordApi;
				return new GuildAgentImpl(env, storage, workspace, rest, timeout);
			}),
		);
	}
}

// Keep the model default reachable for the session object's status route.
export { DEFAULT_MODEL };

/** Convenience: the guild's configuration for a turn. */
export function toHostConfig(config: GuildConfig, links: readonly McpLink[]): HostConfig {
	return { connections: config.connections, model: config.model, links };
}

/** A tagged failure for a session operation that cannot proceed. */
export const sessionError = (message: string): Error => botError(message);
