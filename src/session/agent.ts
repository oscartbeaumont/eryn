/**
 * The guild's agent: its embedded OpenCode host, provider connections, and turns.
 *
 * One instance per guild object. It builds the host lazily from the guild's
 * connected providers, its chosen model, and its linked MCP servers; a change
 * to any of them rebuilds it, so a rotated key or a new link takes effect on
 * the next turn. A prompt runs the agent turn and streams the reply into the
 * Discord conversation: a thread, or a subscribed channel.
 */

import { KEYS, log } from "../config";
import { describeError } from "../errors";
import { DEFAULT_THREAD_NAME, type DiscordRest } from "../discord/api";
import { renderConversation, renderFailure, renderUserMessage } from "../discord/render";
import { DISCORD_METADATA_KEY, readDiscordContext } from "../plugins";
import { fetchAttachmentFiles } from "./attachments";
import type { HostInterface } from "./host";
import { buildHost, connectionSignature, linkSignature, type HostConfig } from "./host-config";
import type {
	DiscordContext,
	IntegrationOption,
	ModelOption,
	OAuthAttempt,
	OAuthStatus,
	PromptRequest,
} from "./models";
import { describeMethods, needsLocalCallback, parseModelRef, resolveModelChoice } from "./providers";
import { applyTurnEvent, createTurn, type Turn } from "./turn";

export type { HostConfig };

/** Namespace used for every session in this Worker. The workerd profile has no real filesystem. */
const LOCATION = "/eryn";
const TURN_TIMEOUT_MS = 900_000;

/** The live state of one conversation inside this guild's object. */
interface ThreadRun {
	turn?: Turn;
}

interface Host {
	promise: Promise<HostInterface>;
	/** Signature of the provider set, at the time the host was built. */
	connections: string;
	/** Signature of the linked MCP servers, at the time the host was built. */
	mcp: string;
	/** Whether this host has the schedule runner running. */
	schedules: boolean;
}

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
	/** Build the host if it is not up, so its schedule runner is running. */
	ensureHost(config: HostConfig): Promise<void>;
	/** Whether a host is in memory and holding timers or streams. */
	hasHost(): boolean;
	/** Whether any turn is still running, including one adopted from a schedule. */
	busy(): boolean;
	/** Close the host and its background fibers, letting the object hibernate. */
	close(): Promise<void>;
}

class GuildAgentImpl implements GuildAgentShape {
	private host: Host | undefined;
	private abort: AbortController | undefined;
	private consuming: Promise<void> | undefined;
	/** The host the live event subscription belongs to. */
	private consumingHost: HostInterface | undefined;
	/** Sessions whose out-of-band turn is being adopted, so two events cannot race. */
	private readonly adopting = new Set<string>();
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
		private readonly rest: DiscordRest,
		private readonly turnTimeoutMs: number,
		private readonly guildId: string,
	) {}

	// --- Host -----------------------------------------------------------------

	/**
	 * The embedded OpenCode host for this guild, built on first use and rebuilt
	 * when the provider set, the model, or the linked MCP servers change.
	 */
	private async hostFor(config: HostConfig, excludeThreadId?: string): Promise<HostInterface> {
		const connections = connectionSignature(config.connections);
		const mcp = linkSignature(config.links);
		const schedules = this.hasSchedules();

		const changed =
			this.host !== undefined &&
			(this.host.connections !== connections ||
				this.host.mcp !== mcp ||
				(schedules && !this.host.schedules));
		// A config change must not tear down a host that has another thread's turn
		// streaming on it. The turn being started is allowed through.
		const busy = [...this.runs].some(
			([threadId, run]) => threadId !== excludeThreadId && run.turn !== undefined,
		);
		if (!this.host || (changed && !busy)) {
			const previous = this.host?.promise;
			this.abort?.abort();
			this.abort = new AbortController();
			const promise = buildHost(config, {
				env: this.env,
				storage: this.storage,
				rest: this.rest,
				guildId: this.guildId,
				directory: LOCATION,
				schedules,
			});
			this.host = { promise, connections, mcp, schedules };
			this.consuming = undefined;
			// A different provider set means a different catalogue.
			this.modelCache = undefined;
			void promise
				.then((host) => this.startConsuming(host))
				.catch((error) => log("session", `could not start the event stream: ${describeError(error)}`));
			void previous?.then((host) => host.close()).catch(() => undefined);
		}
		return this.host.promise;
	}

	// --- Catalogue ------------------------------------------------------------

	async ensureHost(config: HostConfig): Promise<void> {
		const host = await this.hostFor(config);
		// A scheduled turn starts without an HTTP prompt, so nothing else would
		// subscribe to its events and render it into Discord.
		this.startConsuming(host);
	}

	hasHost(): boolean {
		return this.host !== undefined;
	}

	/** Whether any active schedule exists, so the host needs its runner. */
	private hasSchedules(): boolean {
		try {
			return this.storage.sql.exec("SELECT 1 FROM schedule WHERE status = 'active' LIMIT 1").toArray().length > 0;
		} catch {
			// The table only exists once a host has enabled schedules.
			return false;
		}
	}

	busy(): boolean {
		if (this.adopting.size > 0) return true;
		for (const run of this.runs.values()) if (run.turn !== undefined) return true;
		return false;
	}

	/**
	 * Stop the host so the Durable Object can hibernate.
	 *
	 * The host keeps the schedule runner and event stream alive in memory, and
	 * those timers would otherwise keep this object resident and billable for
	 * the whole day. The next request builds a host again from storage.
	 */
	async close(): Promise<void> {
		if (this.busy()) return;
		this.abort?.abort();
		this.abort = undefined;
		this.consuming = undefined;
		this.consumingHost = undefined;

		const host = this.host;
		this.host = undefined;
		this.modelCache = undefined;
		this.runs.clear();
		this.sessionByThread.clear();
		this.threadBySession.clear();
		this.appliedModels.clear();
		this.appliedContext.clear();

		if (!host) return;
		await host.promise
			.then((running) => running.close())
			.catch((error) => log("session", `could not close the host: ${describeError(error)}`));
	}

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
					methods: describeMethods(entry.methods),
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
		return this.listModels(config);
	}

	/**
	 * The model a turn should use.
	 *
	 * The stored choice may name a provider this guild has not connected, in
	 * which case the turn would produce nothing. `resolveModelChoice` falls back
	 * to a model that can actually run; the switch is logged because it changes
	 * what the next turn uses.
	 */
	async resolveModel(config: HostConfig): Promise<string> {
		const provider = config.model.split("/")[0] ?? "";
		const directlyConnected = config.connections.some((connection) => connection.integrationID === provider);
		const model = await resolveModelChoice(config.model, directlyConnected, () =>
			this.listModels(config).catch(() => [] as ModelOption[]),
		);
		if (model !== config.model) log("session", `using ${model} instead of ${config.model}`);
		return model;
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

	/**
	 * The providers that are actually available.
	 *
	 * An integration connection can supply more than the provider it is named
	 * after: OpenCode Console supplies both `opencode` and `opencode-go`. The
	 * provider registry marks those as enabled and records the integration that
	 * supplied them, which is the signal the model picker needs. A provider that
	 * only has public free access is not counted until its integration is
	 * connected.
	 */
	private async connectedProviders(host: HostInterface): Promise<Set<string>> {
		const integrations = await host.integration
			.list({ location: { directory: LOCATION } })
			.catch(() => undefined);
		const connected = new Set(
			(integrations?.data ?? [])
				.filter((entry) => entry.connections.length > 0)
				.map((entry) => String(entry.id)),
		);
		const providers = await host.provider.list({ location: { directory: LOCATION } }).catch(() => undefined);
		for (const provider of providers?.data ?? []) {
			const suppliedBy = provider.integrationID;
			if (provider.activation === "enabled" && suppliedBy && connected.has(String(suppliedBy))) {
				connected.add(String(provider.id));
			}
		}
		return connected;
	}

	// --- Provider sign-in -----------------------------------------------------

	async connectKey(config: HostConfig, integrationID: string, key: string): Promise<void> {
		const host = await this.hostFor(config);
		await host.integration.connect.key({ integrationID, key, location: { directory: LOCATION } });
		this.modelCache = undefined;
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
		const turn = this.beginTurn(request.threadId);
		let failure: string | undefined;

		let stopTyping: () => void = () => undefined;
		try {
			stopTyping = this.startTyping(request.threadId);

			const host = await this.hostFor(config, request.threadId);
			// The completion signal arrives as an event, so a subscription that
			// died since the last turn has to be replaced before this one starts.
			this.startConsuming(host);
			const sessionID = await this.ensureSession(host, request.threadId, request.title ?? DEFAULT_THREAD_NAME);
			await this.applyDiscord(host, request.threadId, sessionID, request.discord);
			await this.applyModel(host, request.threadId, sessionID, config.model);

			const attached = await fetchAttachmentFiles(request.attachments);
			const message = renderUserMessage(request.author, request.mentions ?? [], request.text.trim() || "(attached files)");
			// The message carries the channel and (when there is one) the thread
			// it came from. The agent posts its reply with a Discord tool, so
			// these ids are what tell it where the reply belongs.
			const context = request.discord ? renderConversation(request.discord) : undefined;
			const body = [context, message].filter(Boolean).join("\n\n");
			const text =
				attached.notes.length > 0
					? `${body}\n\n[Attachments not included: ${attached.notes.join("; ")}]`
					: body;
			await host.sessions.prompt({
				sessionID,
				text,
				...(attached.files.length > 0 ? { files: attached.files } : {}),
			});
			const finished = await this.wait(turn);
			if (!finished) {
				await this.interrupt(request.threadId, false).catch(() => undefined);
				failure = "The turn timed out before it finished.";
			}
			if (turn.error) {
				failure = turn.error;
				log("session", `turn in ${request.threadId} failed: ${turn.error}`);
			}

			// The assistant's own text is deliberately ignored: the reply is
			// whatever it posted through discord_send_message.
		} catch (error) {
			failure = describeError(error);
			log("session", `prompt failed: ${failure}`);
		} finally {
			stopTyping();
			this.endTurn(request.threadId, turn);
			if (turn.gone) await this.discardThread(request.threadId);
		}

		// Report the failure where the turn was triggered, once the run itself
		// has been released.
		if (failure && !turn.gone) await this.postFailure(request.threadId, failure);
	}

	/** Send a turn failure to the conversation that triggered it. */
	private async postFailure(threadId: string, error: string): Promise<void> {
		await this.rest.sendMessage(threadId, renderFailure(error)).catch((sendError) => {
			log("session", `could not post the failure for ${threadId}: ${describeError(sendError)}`);
		});
	}

	/** Take ownership of a conversation's turn, so events and the prompt agree on it. */
	private beginTurn(threadId: string): Turn {
		const run = this.runs.get(threadId) ?? {};
		const turn = createTurn(threadId);
		run.turn = turn;
		this.runs.set(threadId, run);
		return turn;
	}

	/** Release a conversation's turn, leaving the run behind for the next one. */
	private endTurn(threadId: string, turn: Turn): void {
		turn.done = true;
		const run = this.runs.get(threadId);
		if (run?.turn !== turn) return;
		run.turn = undefined;
		this.runs.delete(threadId);
	}

	/**
	 * Point the session at the guild's chosen model. In this SDK the config value
	 * does not reach session model selection, so switching the session explicitly
	 * is what actually applies the choice.
	 */
	private async applyModel(
		host: HostInterface,
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
		host: HostInterface,
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
		if (!run?.turn || !this.host || !sessionID) {
			// With no turn in flight there is no completion event left to wait for,
			// so a deleted thread can be discarded now. A live turn discards itself
			// in `prompt`'s finally, once it has actually settled.
			if (gone && threadId) await this.discardThread(threadId);
			return false;
		}
		if (gone) run.turn.gone = true;
		await (await this.host.promise).sessions.interrupt({ sessionID });
		return true;
	}

	/** Forget everything about a thread whose Discord thread is gone. */
	private async discardThread(threadId: string): Promise<void> {
		this.forget(threadId);
		this.runs.delete(threadId);
		this.appliedModels.delete(threadId);
		this.appliedContext.delete(threadId);
		await this.storage.delete(KEYS.session + threadId).catch(() => undefined);
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
		const stored = await this.storage.get<unknown>(KEYS.session + threadId);
		if (typeof stored !== "string") return undefined;
		this.remember(threadId, stored);
		return stored;
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

	private async ensureSession(host: HostInterface, threadId: string, title: string): Promise<string> {
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
		await this.storage.put(KEYS.session + threadId, session.id);
		return session.id;
	}

	// --- Event stream ---------------------------------------------------------

	/**
	 * Subscribe to the host's event stream, which is where the completion
	 * signal comes from. The feed is volatile: a subscription that ends has to
	 * be replaced, so `prompt` re-ensures it.
	 */
	private startConsuming(host: HostInterface): void {
		if (this.consuming) return;
		this.consumingHost = host;
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
		if (!threadId) {
			// A schedule fires the Session directly, with no thread prompt to own
			// the turn. Adopt it so its reply still lands in the Discord
			// conversation recorded on the Session.
			if (shape.type === "session.execution.started" || shape.type === "session.step.started") {
				this.adopt(sessionID);
			}
			return;
		}

		const turn = this.runs.get(threadId)?.turn;
		if (!turn || turn.done) return;
		// Ignore events that predate this turn, such as the previous one going idle.
		if (typeof shape.created === "number" && shape.created < turn.createdAt - 1_000) return;

		applyTurnEvent(turn, shape.type, data);
	}

	/**
	 * Follow a turn this object did not start, such as one a schedule fired.
	 *
	 * The conversation is not in memory after an eviction, so it comes from the
	 * Discord context the Session carries in its metadata. The agent posts any
	 * reply through a Discord tool; this only waits for the turn to settle.
	 */
	private adopt(sessionID: string): void {
		const host = this.consumingHost;
		if (!host || this.adopting.has(sessionID)) return;
		this.adopting.add(sessionID);
		void (async () => {
			try {
				const session = await host.sessions.get({ sessionID });
				const context = readDiscordContext(session.metadata as Record<string, unknown> | undefined);
				const threadId = context?.thread.id;
				if (!threadId || this.runs.get(threadId)?.turn) return;

				this.remember(threadId, sessionID);
				const turn = this.beginTurn(threadId);
				let failure: string | undefined;

				let stopTyping: () => void = () => undefined;
				try {
					stopTyping = this.startTyping(threadId);
					if (!(await this.wait(turn))) {
						turn.interrupted = true;
						await host.sessions.interrupt({ sessionID }).catch(() => undefined);
						failure = "The turn timed out before it finished.";
					}
					if (turn.error) {
						failure = turn.error;
						log("session", `scheduled turn for ${sessionID} failed: ${turn.error}`);
					}
				} finally {
					stopTyping();
					this.endTurn(threadId, turn);
				}
				if (failure && !turn.gone) await this.postFailure(threadId, failure);
			} catch (error) {
				log("session", `scheduled turn for ${sessionID} failed: ${describeError(error)}`);
			} finally {
				this.adopting.delete(sessionID);
			}
		})();
	}
}

/** Build the guild's agent, sharing the object's storage and Discord client. */
export function createGuildAgent(
	env: Env,
	storage: DurableObjectStorage,
	rest: DiscordRest,
	guildId: string,
): GuildAgentShape {
	return new GuildAgentImpl(env, storage, rest, TURN_TIMEOUT_MS, guildId);
}
