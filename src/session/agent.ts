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
import { actionButton, buttonRow, linkButton } from "../discord/components";
import { describeError } from "../errors";
import {
	DEFAULT_THREAD_NAME,
	DiscordError,
	type DiscordChannelRef,
	type DiscordRest,
} from "../discord/api";
import { DiscordAuthority } from "../discord/authority";
import { renderConversation, renderFailure, renderUserMessage } from "../discord/render";
import { DISCORD_METADATA_KEY, readDiscordContext } from "../plugins";
import { fetchAttachmentFiles } from "./attachments";
import type { HostInterface } from "./host";
import { channelProjectDirectory, LOCATION } from "./locations";
import { buildHost, connectionSignature, linkSignature, type HostConfig } from "./host-config";
import type {
	CommandInfo,
	CommandRequest,
	CommandResponse,
	CompactResponse,
	DiscordContext,
	FormField,
	FormView,
	IntegrationOption,
	InteractResponse,
	ModelOption,
	OAuthAttempt,
	OAuthStatus,
	Policy,
	PolicyEffect,
	PolicyState,
	PromptRequest,
} from "./models";
import { addScheduleToScope, scopeCoveredBy, type ChannelCapabilities } from "./schedule-scope";
import {
	compilePermissions,
	isDefaultPolicy,
	overrideFor,
	policyTitle,
	resolvePolicy,
	summaryLines,
	withOverride,
} from "./policy";
import { describeMethods, needsLocalCallback, parseModelRef, resolveModelChoice } from "./providers";
import { seedWorkspace } from "./seed";
import type { GuildStoreShape } from "./store";
import { applyTurnEvent, createTurn, type Turn } from "./turn";
import { readWorkspaceConfig, workspaceSignature } from "./workspace-config";

export type { HostConfig };

/** The JSON metadata boundary: stored scope arrays are readonly for readers. */
type SessionMetadata = NonNullable<Parameters<HostInterface["sessions"]["update"]>[0]["metadata"]>;
const TURN_TIMEOUT_MS = 900_000;
/** How long a manual compaction may take before the command answers anyway. */
const COMPACTION_TIMEOUT_MS = 120_000;

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
	/** Signature of the guild's config files, at the time the host was built. */
	workspace: string;
	/** Whether this host has the schedule runner running. */
	schedules: boolean;
}

/** A permission request waiting for a click in Discord. */
interface PendingApproval {
	readonly requestId: string;
	readonly sessionID: string;
	readonly threadId: string;
	readonly channelId: string;
	readonly kind: "thread" | "channel";
	readonly action: string;
	readonly content: string;
	readonly requesterId?: string;
	readonly messageId?: string;
	readonly timer: ReturnType<typeof setTimeout>;
}

/** An MCP form waiting for a modal reply. */
interface PendingForm {
	readonly formId: string;
	readonly sessionID: string;
	readonly threadId: string;
	readonly channelId: string;
	readonly kind: "thread" | "channel";
	readonly fields: readonly FormField[];
	readonly content: string;
	readonly requesterId?: string;
	readonly messageId?: string;
	readonly timer: ReturnType<typeof setTimeout>;
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
	/** Run one OpenCode command in a conversation. */
	command(request: CommandRequest, config: HostConfig): Promise<CommandResponse>;
	/** The commands available in a conversation's project. */
	commands(config: HostConfig, directory: string): Promise<CommandInfo[]>;
	/** Compact one conversation's history, at a member's request. */
	compact(threadId: string, config: HostConfig): Promise<CompactResponse>;
	/** The policy in effect in one channel or thread, before the menu renders it. */
	policyState(input: { channelId: string; threadId?: string }): Promise<PolicyState>;
	setPolicy(input: {
		scope: "guild" | "channel" | "thread";
		channelId: string;
		threadId?: string;
		policy: Policy;
	}): Promise<PolicyState>;
	clearPolicy(input: {
		scope: "guild" | "channel" | "thread";
		channelId: string;
		threadId?: string;
	}): Promise<PolicyState>;
	/** Decide a pending permission card and, for always/block, write a policy override. */
	replyApproval(input: {
		threadId: string;
		requestId: string;
		decision: "once" | "always" | "block";
		userId?: string;
		manager?: boolean;
	}): Promise<{ ok: boolean; message?: string }>;
	/** The fields a Discord modal must render for one MCP form. */
	formView(
		formId: string,
		auth?: { userId?: string; manager?: boolean },
	): Promise<FormView | undefined>;
	/** Answer an MCP form with the values a Discord modal collected. */
	replyForm(input: {
		formId: string;
		values: Record<string, string>;
		userId?: string;
		manager?: boolean;
	}): Promise<{ ok: boolean; message?: string }>;
	/** Dismiss an MCP form without answering it. */
	cancelForm(input: {
		formId: string;
		userId?: string;
		manager?: boolean;
	}): Promise<{ ok: boolean; message?: string }>;
	/** Correct a conversation's stored context after Discord renames it. */
	updateContext(config: HostConfig, threadId: string, discord: DiscordContext): Promise<void>;
	/** Whether one user covers every capability a scheduled conversation uses. */
	canInteract(threadId: string, userId: string): Promise<InteractResponse>;
	interrupt(threadId: string | undefined, gone: boolean, config?: HostConfig): Promise<boolean>;
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
	/** Sessions whose Discord conversation was deleted, so no event may adopt one. */
	private readonly discarded = new Set<string>();
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
	/** The policy signature already written to a thread's session. */
	private readonly appliedPolicies = new Map<string, string>();
	/** The conversation context last seen for a thread, for approvals and cards. */
	private readonly contextByThread = new Map<string, DiscordContext>();
	/** Serialises writes that decide which authority a turn acts under. */
	private readonly principalLocks = new Map<string, Promise<void>>();
	/** Host events older than this belong to a turn that was interrupted. */
	private readonly turnFloor = new Map<string, number>();
	/** The account that most recently prompted a thread, so approvals can name them. */
	private readonly requesterByThread = new Map<string, string>();
	/** Permission cards currently waiting for a click. */
	private readonly pendingApprovals = new Map<string, PendingApproval>();
	/** MCP forms currently waiting for a modal reply. */
	private readonly pendingForms = new Map<string, PendingForm>();
	/** Manual compactions waiting for the runner's end event, keyed by session. */
	private readonly compactions = new Map<
		string,
		{
			readonly resolve: (outcome: "ended" | "failed") => void;
			readonly timer: ReturnType<typeof setTimeout>;
		}
	>();
	/** The config last used to build the host, for policies and MCP modes. */
	private currentConfig: HostConfig | undefined;
	/** Per-guild Discord permission lookups, shared by tool checks and gating. */
	private readonly authority: DiscordAuthority;

	constructor(
		private readonly env: Env,
		private readonly storage: DurableObjectStorage,
		private readonly rest: DiscordRest,
		private readonly store: GuildStoreShape,
		private readonly turnTimeoutMs: number,
		private readonly guildId: string,
	) {
		this.authority = new DiscordAuthority(rest, guildId);
	}

	// --- Host -----------------------------------------------------------------

	/**
	 * The embedded OpenCode host for this guild, built on first use and rebuilt
	 * when the provider set, the model, or the linked MCP servers change.
	 */
	private async hostFor(
		config: HostConfig,
		excludeThreadId?: string,
		schedulesOverride?: boolean,
	): Promise<HostInterface> {
		this.currentConfig = config;
		const connections = connectionSignature(config.connections);
		const mcp = linkSignature(config.links);

		const changed =
			this.host !== undefined &&
			(this.host.connections !== connections ||
				this.host.mcp !== mcp ||
				this.host.workspace !== config.workspace);
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
			});
			// A rejected build must not stay cached until the idle close: the next
			// request should retry (a missing origin or a transient storage error
			// is recoverable).
			let retry: Promise<HostInterface>;
			retry = promise.catch((error) => {
				if (this.host?.promise === retry) this.host = undefined;
				throw error;
			});
			this.host = { promise: retry, connections, mcp, workspace: config.workspace, schedules: false };
			this.consuming = undefined;
			// A different provider set means a different catalogue.
			this.modelCache = undefined;
			void promise
				.then((host) => this.startConsuming(host))
				.catch((error) => log("session", `could not start the event stream: ${describeError(error)}`));
			void previous?.then((host) => host.close()).catch(() => undefined);
		}
		const current = this.host;
		const host = await current.promise;
		// A host is only rebuilt for a changed config; a schedule can appear
		// during a turn, so check the live host rather than rebuilding it.
		if (this.host === current && schedulesOverride !== false && !current.schedules) {
			const started = await host.ensureSchedules().catch((error) => {
				log("session", `could not start the schedule runner: ${describeError(error)}`);
				return false;
			});
			if (started) current.schedules = true;
		}
		return host;
	}

	/** Read the guild's current host inputs, including its editable files. */
	private async loadHostConfig(): Promise<HostConfig> {
		await seedWorkspace(this.storage);
		const settings = await this.store.settings();
		return {
			connections: await this.store.providers(),
			model: settings.model,
			links: await this.store.links(),
			workspace: await workspaceSignature(this.storage),
		};
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
		this.appliedPolicies.clear();
		this.contextByThread.clear();
		this.requesterByThread.clear();
		for (const pending of this.pendingApprovals.values()) clearTimeout(pending.timer);
		this.pendingApprovals.clear();
		for (const pending of this.pendingForms.values()) clearTimeout(pending.timer);
		this.pendingForms.clear();
		this.discarded.clear();

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
			this.models(config).catch(() => [] as ModelOption[]),
		);
		if (model !== config.model) log("session", `using ${model} instead of ${config.model}`);
		return model;
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

	/** Run one context write at a time per session, so writers cannot clobber. */
	private withPrincipalLock<T>(sessionID: string, task: () => Promise<T>): Promise<T> {
		const previous = this.principalLocks.get(sessionID) ?? Promise.resolve();
		const next = previous.then(task, task);
		const tail = next.then(
			() => undefined,
			() => undefined,
		);
		this.principalLocks.set(sessionID, tail);
		void tail.finally(() => {
			if (this.principalLocks.get(sessionID) === tail) this.principalLocks.delete(sessionID);
		});
		return next;
	}

	/**
	 * Decide who a human prompt acts as.
	 *
	 * Normally the speaker. But if a schedule wake is still waiting in the
	 * inbox, or a schedule turn did not settle (a cold start can resume one
	 * asynchronously), the message will join that schedule execution. Keep the
	 * schedule's principal then, so the scheduled instruction can never use the
	 * speaker's Discord permissions. An unreadable inbox fails closed the same
	 * way: the turn is restricted rather than granted.
	 */
	private async promptContext(
		host: HostInterface,
		sessionID: string,
		base: DiscordContext | undefined,
		authorId: string | undefined,
		considerUnsettled: boolean,
	): Promise<DiscordContext | undefined> {
		if (!base) return undefined;
		const session = await host.sessions.get({ sessionID }).catch(() => undefined);
		const stored = readDiscordContext(session?.metadata as Record<string, unknown> | undefined);
		// The stored context is authoritative. Falling back to the gateway's
		// snapshot when a session exists could resurrect a scope that was
		// cleared since that snapshot was taken.
		const scope = stored ? stored.scheduleScope : base.scheduleScope;
		const pending = await this.scheduleWakePending(host, sessionID);
		// A cold start can resume a suspended schedule execution asynchronously,
		// and `sessions.active()` does not see it yet. An unfinished turn whose
		// stored principal is a schedule is treated as still scheduled. When we
		// just stopped an execution and waited for idle, that question is moot.
		const unsettled =
			considerUnsettled &&
			session !== undefined &&
			session.time.busy !== undefined &&
			(session.time.idle === undefined || session.time.busy > session.time.idle);
		// An unfinished turn is the schedule's if it was marked as one, or if
		// the message it was running is still the latest schedule wake. The
		// latter also covers a crash before attribution could be written.
		const unfinishedSchedule =
			unsettled &&
			(stored?.scheduleTurn === true || (await this.scheduleWake(sessionID)) !== undefined);
		const keepSchedule = pending !== false || unfinishedSchedule;
		return {
			...base,
			authorId: keepSchedule ? undefined : authorId,
			scheduleTurn: keepSchedule ? true : undefined,
			...(scope ? { scheduleScope: scope } : {}),
		};
	}

	async prompt(request: PromptRequest, config: HostConfig): Promise<void> {
		const host = await this.hostFor(config, request.threadId);
		// The completion signal arrives as an event, so a subscription that
		// died since the last turn has to be replaced before this one starts.
		this.startConsuming(host);
		const sessionID = await this.ensureSession(
			host,
			request.threadId,
			request.title ?? DEFAULT_THREAD_NAME,
			channelProjectDirectory(request.discord?.channel.id),
			config.model,
		);
		// A schedule may be running in this session. A prompt is delivered with
		// `steer`, so without this the human message would join the schedule's
		// execution and the schedule's later tool calls would read this
		// speaker's id. Stop it before the human turn writes its context.
		const interrupted = await this.stopRunningTurn(host, sessionID, request.threadId);
		await this.runTurn(
			request.threadId,
			"prompt",
			async () => {
				// A rename is not replayed to the agent, and the gateway's copy can
				// predate it, so re-read the conversation rather than trusting it.
				// The speaker is recorded on the same context: the tools read it
				// back to hold the turn to that person's Discord permissions.
				const refreshed = request.discord ? await this.refreshContext(request.discord) : undefined;
				// Keep the conversation's stored context when the prompt carries
				// none, but set or clear the speaker on it. A turn with no speaker
				// (an older message watch, for example) must not borrow the previous
				// speaker's Discord authority. A session with no context stays
				// without one: this does not invent a conversation.
				const fallback =
					this.contextByThread.get(request.threadId) ??
					(await this.contextForSession(sessionID))?.context;
				const base = refreshed ?? fallback;
				// The decision and the write share a lock. A schedule wake can be
				// enqueued between them, and if it joins this turn its scope must
				// not be overwritten by the speaker's context.
				const discord = await this.withPrincipalLock(sessionID, async () => {
					const context = await this.promptContext(
						host,
						sessionID,
						base,
						request.author?.id,
						!interrupted,
					);
					await this.applyDiscord(host, request.threadId, sessionID, context);
					return context;
				});
				await this.applyPolicy(host, request.threadId, sessionID, discord, config);
				if (discord?.scheduleTurn === true) this.requesterByThread.delete(request.threadId);
				else if (request.author?.id) this.requesterByThread.set(request.threadId, request.author.id);
				else this.requesterByThread.delete(request.threadId);
				await this.applyModel(host, request.threadId, sessionID, config.model);

				const attached = await fetchAttachmentFiles(request.attachments);
				const message = renderUserMessage(
					request.author,
					request.mentions ?? [],
					request.text.trim() || "(attached files)",
				);
				// The message carries the channel and (when there is one) the thread
				// it came from. The agent posts its reply with a Discord tool, so
				// these ids are what tell it where the reply belongs.
				const conversation = discord ? renderConversation(discord) : undefined;
				const body = [conversation, request.notice, message].filter(Boolean).join("\n\n");
				const text =
					attached.notes.length > 0
						? `${body}\n\n[Attachments not included: ${attached.notes.join("; ")}]`
						: body;
				await host.sessions.prompt({
					sessionID,
					text,
					...(attached.files.length > 0 ? { files: attached.files } : {}),
				});
				// The assistant's own text is deliberately ignored: the reply is
				// whatever it posted through discord_send_message.
			},
			() => this.interrupt(request.threadId, false).catch(() => undefined),
		);
	}

	/**
	 * Run one OpenCode command in the conversation.
	 *
	 * A command is a prompt template with its own expansion rules, so it goes
	 * through `session.command` rather than `session.prompt`. The same Discord
	 * context, policy, and model setup applies, and the resulting turn streams
	 * back through the usual event path.
	 */
	async command(request: CommandRequest, config: HostConfig): Promise<CommandResponse> {
		const host = await this.hostFor(config, request.threadId);
		this.startConsuming(host);
		const sessionID = await this.ensureSession(
			host,
			request.threadId,
			request.title ?? request.command,
			channelProjectDirectory(request.discord?.channel.id),
			config.model,
		);
		const interrupted = await this.stopRunningTurn(host, sessionID, request.threadId);
		const before = await host.sessions.get({ sessionID }).catch(() => undefined);
		const workspace = await readWorkspaceConfig(this.storage);
		const defaultAgent =
			before?.agent ??
			(typeof workspace.config.default_agent === "string" ? workspace.config.default_agent : "build");
		try {
			return await this.runTurn(
				request.threadId,
				`command ${request.command}`,
				async () => {
					const refreshed = request.discord ? await this.refreshContext(request.discord) : undefined;
					const fallback =
						this.contextByThread.get(request.threadId) ??
						(await this.contextForSession(sessionID))?.context;
					const base = refreshed ?? fallback;
					const discord = await this.withPrincipalLock(sessionID, async () => {
						const context = await this.promptContext(
							host,
							sessionID,
							base,
							request.author?.id,
							!interrupted,
						);
						await this.applyDiscord(host, request.threadId, sessionID, context);
						return context;
					});
					await this.applyPolicy(host, request.threadId, sessionID, discord, config);
					if (discord?.scheduleTurn === true) this.requesterByThread.delete(request.threadId);
					else if (request.author?.id) this.requesterByThread.set(request.threadId, request.author.id);
					else this.requesterByThread.delete(request.threadId);
					await this.applyModel(host, request.threadId, sessionID, config.model);
					await host.sessions.command({
						sessionID,
						name: request.command,
						text: request.text,
					});
				},
				() => this.interrupt(request.threadId, false).catch(() => undefined),
			);
		} finally {
			// A command may switch the session model or agent. Forget the cached
			// model and restore the agent so the next prompt uses the guild's
			// choices, not the command's.
			this.appliedModels.delete(request.threadId);
			await host.sessions
				.switchAgent({ sessionID, agent: defaultAgent as never })
				.catch((error) => log("session", `could not restore the session agent: ${describeError(error)}`));
		}
	}

	/** The commands available in one conversation's project. */
	async commands(config: HostConfig, directory: string): Promise<CommandInfo[]> {
		// Read the guild files first: they work without a provider or a host, so
		// `/eryn commands` still answers when a host build fails.
		const workspace = await readWorkspaceConfig(this.storage);
		const merged = new Map<string, CommandInfo>();

		// A cold Location activates config plugins asynchronously, so the host
		// list may not have them yet. It still supplies built-ins. Skip it when
		// the live host is for older files (another turn is still busy).
		const warm = this.host !== undefined && this.host.workspace === config.workspace;
		if (!this.host || warm) {
			try {
				const host = await this.hostFor(config);
				let listed = await host.command.list({ location: { directory } });
				if (!warm) {
					// A just-built Location activates its post plugins a moment
					// after the first read. One short retry fills in built-ins.
					await new Promise((resolve) => setTimeout(resolve, 100));
					listed = await host.command.list({ location: { directory } });
				}
				for (const command of listed.data) {
					merged.set(command.name, {
						name: command.name,
						...(command.description ? { description: command.description } : {}),
					});
				}
			} catch (error) {
				log("session", `could not list the host's commands: ${describeError(error)}`);
			}
		}

		// File-backed commands win by name and are always current.
		for (const [name, info] of Object.entries(
			(workspace.config.commands ?? {}) as Record<string, { description?: unknown }>,
		)) {
			merged.set(name, {
				name,
				...(typeof info.description === "string" && info.description
					? { description: info.description }
					: {}),
			});
		}
		return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	/**
	 * Compact one conversation's history.
	 *
	 * Compaction runs as its own execution and reports `session.compaction.ended`
	 * or `.failed` rather than a normal turn, so it is tracked here instead of
	 * with `runTurn`. The command waits for that outcome so the member gets a
	 * real answer, but the timeout keeps a stuck summarisation from holding the
	 * interaction open indefinitely.
	 */
	async compact(threadId: string, config: HostConfig): Promise<CompactResponse> {
		const sessionID = await this.sessionFor(threadId);
		if (!sessionID) return { ok: false, message: "There is no Eryn conversation here yet." };
		if (this.compactions.has(sessionID)) {
			return { ok: false, message: "A compaction is already running in this conversation." };
		}
		try {
			const host = await this.hostFor(config, threadId);
			this.startConsuming(host);
			const outcome = await new Promise<"ended" | "failed" | "timeout">((resolve) => {
				const timer = setTimeout(() => {
					this.compactions.delete(sessionID);
					resolve("timeout");
				}, COMPACTION_TIMEOUT_MS);
				this.compactions.set(sessionID, {
					resolve: (result) => {
						clearTimeout(timer);
						resolve(result);
					},
					timer,
				});
				// Queue it behind any turn in progress: compacting halfway through
				// a step would rewrite the context the running turn is using.
				host.sessions.compact({ sessionID, delivery: "queue" }).catch((error) => {
					log("session", `could not compact ${threadId}: ${describeError(error)}`);
					if (this.compactions.delete(sessionID)) {
						clearTimeout(timer);
						resolve("failed");
					}
				});
			});
			if (outcome === "ended") return { ok: true };
			if (outcome === "failed") {
				return { ok: false, message: "Compaction failed; the conversation history is unchanged." };
			}
			return { ok: false, message: "Compaction is taking longer than expected. It may still finish." };
		} catch (error) {
			log("session", `could not compact ${threadId}: ${describeError(error)}`);
			return { ok: false, message: "Eryn could not compact this conversation." };
		}
	}

	/** Resolve the command waiting on a manual compaction, if there is one. */
	private settleCompaction(data: Record<string, unknown>, ended: boolean): void {
		if (data.reason !== "manual" || typeof data.sessionID !== "string") return;
		const pending = this.compactions.get(data.sessionID);
		if (!pending) return;
		this.compactions.delete(data.sessionID);
		clearTimeout(pending.timer);
		pending.resolve(ended ? "ended" : "failed");
	}

	/**
	 * Stop an execution that is already running in this session.
	 *
	 * A human prompt steers into an active execution. If a schedule is running,
	 * the human message would join it and the schedule's later tool calls would
	 * read the human's `authorId`, acting outside its scope with their
	 * permissions. Interrupting and waiting for idle keeps the turns separate.
	 * Human prompts are serialised by the gateway, so whatever is running here
	 * is not another human turn.
	 */
	private async stopRunningTurn(
		host: HostInterface,
		sessionID: string,
		threadId: string,
	): Promise<boolean> {
		let active = true;
		let known = true;
		try {
			const running = await host.sessions.active();
			active = running?.[sessionID] !== undefined;
		} catch {
			// If activity cannot be read, interrupting an idle session is
			// harmless; assume it is running and let the wait decide.
			known = false;
		}
		if (active) {
			await host.sessions.interrupt({ sessionID }).catch(() => undefined);
			let timer: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), 10_000);
			});
			const idle = await Promise.race([
				host.sessions.wait({ sessionID }).then(
					() => true,
					() => false,
				),
				timeout,
			]);
			if (timer) clearTimeout(timer);
			if (!idle) throw new Error("A scheduled turn is still running in this conversation.");
		}
		// Settle the in-memory turn that was following the old execution before a
		// new turn replaces it. Otherwise its `runTurn` waits for the full turn
		// timeout and interrupts whatever is running by then.
		const previous = this.runs.get(threadId)?.turn;
		if (previous && !previous.done) {
			let settleTimer: ReturnType<typeof setTimeout> | undefined;
			const settled = await Promise.race([
				previous.completed.then(() => true),
				new Promise<boolean>((resolve) => {
					settleTimer = setTimeout(() => resolve(false), 1_000);
				}),
			]);
			if (settleTimer) clearTimeout(settleTimer);
			if (!settled && !previous.done) {
				previous.done = true;
				previous.resolve();
			}
		}
		// The execution is idle, but its final events may still be in the event
		// loop. Drop them, or they can complete the human turn that starts next.
		this.turnFloor.set(threadId, Date.now());
		return known && active;
	}

	/**
	 * Run one turn from typing indicator to failure report.
	 *
	 * Both a prompt and a turn adopted from a schedule need the same lifecycle:
	 * show typing, wait for the completion event, stop a turn that outlives its
	 * deadline, release the conversation, and report any failure where the turn
	 * was triggered. `start` does the work that begins the turn.
	 */
	private async runTurn(
		threadId: string,
		label: string,
		start: () => Promise<void>,
		onTimeout: () => Promise<unknown>,
	): Promise<{ ok: boolean; message?: string }> {
		const turn = this.beginTurn(threadId);
		let failure: string | undefined;

		let stopTyping: () => void = () => undefined;
		try {
			stopTyping = this.startTyping(threadId);
			await start();
			if (!(await this.wait(turn))) {
				await onTimeout();
				failure = "The turn timed out before it finished.";
			}
			if (turn.error) {
				failure = turn.error;
				log("session", `${label} failed: ${turn.error}`);
			}
		} catch (error) {
			failure = describeError(error);
			log("session", `${label} failed: ${failure}`);
		} finally {
			stopTyping();
			this.cancelPendingForThread(threadId);
			this.endTurn(threadId, turn);
			if (turn.gone) await this.discardThread(threadId);
		}

		// Report the failure where the turn was triggered, once the run itself
		// has been released.
		if (failure && !turn.gone) await this.postFailure(threadId, failure);
		return failure ? { ok: false, message: failure } : { ok: true };
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
		this.contextByThread.set(threadId, discord);
		const signature = JSON.stringify(discord);
		if (this.appliedContext.get(threadId) === signature) return;
		try {
			const session = await host.sessions.get({ sessionID });
			await this.saveDiscordContext(host, sessionID, session.metadata, discord);
			this.appliedContext.set(threadId, signature);
		} catch (error) {
			log("session", `could not record the Discord context for ${threadId}: ${describeError(error)}`);
		}
	}

	// --- Policy ---------------------------------------------------------------

	private scopeKey(scope: "guild" | "channel" | "thread", channelId: string, threadId?: string): string {
		if (scope === "guild") return KEYS.policyGuild;
		if (scope === "thread") return KEYS.policyThread + (threadId ?? channelId);
		return KEYS.policyChannel + channelId;
	}

	private async patchFor(scope: "guild" | "channel" | "thread", channelId: string, threadId?: string) {
		return await this.store.policy(this.scopeKey(scope, channelId, threadId));
	}

	private async policyFor(channelId: string, threadId?: string): Promise<PolicyState> {
		const guild = await this.patchFor("guild", channelId);
		const channel = await this.patchFor("channel", channelId);
		const thread = threadId ? await this.patchFor("thread", channelId, threadId) : undefined;
		const effective = resolvePolicy([guild, channel, thread]);
		const links = await this.store.links();
		return {
			scope: threadId ? "thread" : "channel",
			channelId,
			...(threadId ? { threadId } : {}),
			...(threadId ? (thread ? { own: thread } : {}) : channel ? { own: channel } : {}),
			effective,
			mcpServers: links.map((link) => link.name),
		};
	}

	async policyState(input: { channelId: string; threadId?: string }): Promise<PolicyState> {
		return await this.policyFor(input.channelId, input.threadId);
	}

	async setPolicy(input: {
		scope: "guild" | "channel" | "thread";
		channelId: string;
		threadId?: string;
		policy: Policy;
	}): Promise<PolicyState> {
		await this.store.putPolicy(this.scopeKey(input.scope, input.channelId, input.threadId), {
			...input.policy,
			updatedAt: Date.now(),
		});
		await this.reapplyScope(input);
		await this.syncCard(input);
		return await this.policyFor(input.channelId, input.threadId);
	}

	async clearPolicy(input: {
		scope: "guild" | "channel" | "thread";
		channelId: string;
		threadId?: string;
	}): Promise<PolicyState> {
		await this.store.removePolicy(this.scopeKey(input.scope, input.channelId, input.threadId));
		await this.reapplyScope(input);
		await this.syncCard(input);
		return await this.policyFor(input.channelId, input.threadId);
	}

	/**
	 * Write the effective policy onto one session.
	 *
	 * The rules are appended after the host's allow-all base and replace the
	 * previous session rules, so tightening a conversation takes effect for the
	 * next call even when it happens mid-turn.
	 */
	private async applyPolicy(
		host: HostInterface,
		threadId: string,
		sessionID: string,
		discord: DiscordContext | undefined,
		config: HostConfig,
	): Promise<void> {
		// A prompt with no message context still belongs to a conversation. Fall
		// back to what the session already knows; if there is nothing, fail the
		// turn rather than run it under the host's allow-all base.
		const context = discord ?? this.contextByThread.get(threadId) ?? (await this.contextForSession(sessionID))?.context;
		if (!context) throw new Error("This conversation has no Discord context, so its policy could not be applied.");
		this.contextByThread.set(threadId, context);
		const state = await this.policyFor(context.channel.id, context.kind === "channel" ? undefined : threadId);
		const signature = `${JSON.stringify(state.effective)}|${config.links.map((link) => link.name).join(",")}`;
		if (this.appliedPolicies.get(threadId) === signature) return;
		const permissions = compilePermissions(state.effective, config.links);
		// Do not swallow this: a restrictive policy that failed to apply must not
		// silently turn into an unrestricted turn.
		await host.sessions.update({ sessionID, permissions });
		this.appliedPolicies.set(threadId, signature);
	}

	private async applyPolicyToThread(
		host: HostInterface,
		threadId: string,
		sessionID: string,
		discord: DiscordContext,
		config: HostConfig,
	): Promise<void> {
		this.contextByThread.set(threadId, discord);
		const state = await this.policyFor(discord.channel.id, discord.kind === "channel" ? undefined : threadId);
		const signature = `${JSON.stringify(state.effective)}|${config.links.map((link) => link.name).join(",")}`;
		if (this.appliedPolicies.get(threadId) === signature) return;
		await host.sessions.update({
			sessionID,
			permissions: compilePermissions(state.effective, config.links),
		});
		this.appliedPolicies.set(threadId, signature);
	}

	/** Push a changed policy onto every session in its scope. */
	private async reapplyScope(input: {
		scope: "guild" | "channel" | "thread";
		channelId: string;
		threadId?: string;
	}): Promise<void> {
		let config = this.currentConfig;
		if (!config) config = await this.loadHostConfig();
		if (config.connections.length === 0) return;
		let host: HostInterface | undefined;
		try {
			host = await this.hostFor(config, undefined, false);
		} catch (error) {
			log("session", `could not build a host to apply the policy: ${describeError(error)}`);
			return;
		}
		const entries = await this.storage.list({ prefix: KEYS.session });
		for (const [key, value] of entries) {
			if (typeof value !== "string") continue;
			const threadId = key.slice(KEYS.session.length);
			const session = await host.sessions.get({ sessionID: value }).catch(() => undefined);
			const context = readDiscordContext(session?.metadata as Record<string, unknown> | undefined);
			if (!context) continue;
			if (input.scope === "channel" && context.channel.id !== input.channelId) continue;
			if (input.scope === "thread" && threadId !== input.threadId) continue;
			await this.applyPolicyToThread(host, threadId, value, context, config).catch((error) =>
				log("session", `could not update ${threadId}: ${describeError(error)}`),
			);
		}
	}

	/** Post or replace the one public card that explains a non-default policy. */
	private async syncCard(input: {
		scope: "guild" | "channel" | "thread";
		channelId: string;
		threadId?: string;
	}): Promise<void> {
		// A server-wide default has no single conversation to announce it in.
		if (input.scope === "guild") return;
		const scope = input.scope;
		const id = scope === "thread" ? input.threadId ?? input.channelId : input.channelId;
		const key = KEYS.policyCard + `${scope}:${id}`;
		const state = await this.policyFor(input.channelId, input.threadId);
		const existing = await this.store.policyCard(key);
		if (isDefaultPolicy(state.effective)) {
			if (!existing) return;
			await this.rest.deleteMessage(existing.channelId, existing.messageId).catch(() => undefined);
			await this.store.removePolicyCard(key);
			return;
		}
		const content = this.policyCardText(state);
		const components = [buttonRow([actionButton("Change", "policy:menu", 2)])];
		if (existing) {
			try {
				await this.rest.editMessage(existing.channelId, existing.messageId, content, { components });
				return;
			} catch {
				// The message was deleted; fall through and post a fresh card.
			}
		}
		const channelId = scope === "thread" ? input.threadId ?? input.channelId : input.channelId;
		const sent = await this.rest
			.sendMessage(channelId, content, { components })
			.catch((error) => {
				log("session", `could not post the policy card for ${channelId}: ${describeError(error)}`);
				return undefined;
			});
		if (sent) await this.store.putPolicyCard(key, { channelId, messageId: sent.id });
	}

	private policyCardText(state: PolicyState): string {
		const text = [
			`🔒 **Permissions here: ${policyTitle(state.effective)}**`,
			summaryLines(state.effective, state.mcpServers).join(" · "),
			"`/eryn policy` to change this.",
		].join("\n");
		return text.length > 1_900 ? `${text.slice(0, 1_899)}…` : text;
	}

	// --- Approval cards -------------------------------------------------------

	async replyApproval(input: {
		threadId: string;
		requestId: string;
		decision: "once" | "always" | "block";
		userId?: string;
		manager?: boolean;
	}): Promise<{ ok: boolean; message?: string }> {
		const pending = this.pendingApprovals.get(input.requestId);
		if (!pending || pending.threadId !== input.threadId) {
			return { ok: false, message: "That request is no longer waiting." };
		}
		// The person who asked can approve their own call once; everyone else
		// needs Manage Server. Changing the policy is always a manager action.
		const trusted = input.manager === true || (pending.requesterId !== undefined && input.userId === pending.requesterId);
		if (input.decision === "once" && !trusted) {
			return { ok: false, message: "Only the person who asked, or someone with Manage Server, can approve this." };
		}
		if (input.decision !== "once" && input.manager !== true) {
			return { ok: false, message: "Only someone with Manage Server can change this conversation's policy." };
		}
		const host = this.host ? await this.host.promise.catch(() => undefined) : undefined;
		if (!host) return { ok: false, message: "Eryn is not running right now. Try again." };

		if (input.decision !== "once") {
			try {
				const effect: PolicyEffect = input.decision === "always" ? "allow" : "block";
				const key = this.scopeKey(
					pending.kind === "thread" ? "thread" : "channel",
					pending.channelId,
					pending.threadId,
				);
				const patch = withOverride(await this.store.policy(key), overrideFor(pending.action, effect));
				await this.store.putPolicy(key, patch);
				await this.reapplyScope({
					scope: pending.kind === "thread" ? "thread" : "channel",
					channelId: pending.channelId,
					...(pending.kind === "thread" ? { threadId: pending.threadId } : {}),
				});
				await this.syncCard({
					scope: pending.kind === "thread" ? "thread" : "channel",
					channelId: pending.channelId,
					...(pending.kind === "thread" ? { threadId: pending.threadId } : {}),
				});
			} catch (error) {
				return { ok: false, message: `Could not change the policy: ${describeError(error)}` };
			}
		}

		try {
			await host.permission.reply({
				sessionID: pending.sessionID,
				requestID: pending.requestId,
				decision: input.decision === "block" ? "reject" : "once",
				...(input.decision === "block" ? { message: "Blocked by a manager in this conversation." } : {}),
			});
		} catch (error) {
			this.pendingApprovals.delete(pending.requestId);
			clearTimeout(pending.timer);
			this.settleApproval(pending, `Could not answer: ${describeError(error)}`);
			return { ok: false, message: "That request is no longer waiting." };
		}

		this.pendingApprovals.delete(pending.requestId);
		clearTimeout(pending.timer);
		this.settleApproval(
			pending,
			input.decision === "block"
				? `🚫 Blocked${input.userId ? ` by <@${input.userId}>` : ""}.`
				: `✅ Approved${input.userId ? ` by <@${input.userId}>` : ""}${input.decision === "always" ? " for this conversation" : " once"}.`,
		);
		if (input.decision === "block") this.cancelPendingForSession(pending.sessionID, "another request was blocked");
		return { ok: true };
	}

	private settleApproval(pending: PendingApproval, result: string): void {
		if (!pending.messageId) return;
		void this.rest
			.editMessage(pending.threadId, pending.messageId, `${pending.content}\n\n${result}`, { components: [] })
			.catch(() => undefined);
	}

	private cancelPendingForSession(sessionID: string, reason: string): void {
		for (const [requestId, pending] of this.pendingApprovals) {
			if (pending.sessionID !== sessionID) continue;
			clearTimeout(pending.timer);
			this.pendingApprovals.delete(requestId);
			this.settleApproval(pending, `Cancelled: ${reason}.`);
		}
	}

	/** A request settled somewhere else, such as an interrupt or a timeout. */
	private onPermissionReplied(data: Record<string, unknown>): void {
		const requestID = typeof data.requestID === "string" ? data.requestID : undefined;
		if (!requestID) return;
		const pending = this.pendingApprovals.get(requestID);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pendingApprovals.delete(requestID);
		this.settleApproval(pending, data.reply === "reject" ? "🚫 Rejected." : "✅ Approved.");
	}

	private onFormSettled(data: Record<string, unknown>, status: "replied" | "cancelled"): void {
		const formID = typeof data.id === "string" ? data.id : undefined;
		if (!formID) return;
		const pending = this.pendingForms.get(formID);
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pendingForms.delete(formID);
		this.settleForm(pending, status === "replied" ? "✅ Answered." : "Cancelled.");
	}

	private cancelPendingForThread(threadId: string): void {
		for (const [requestId, pending] of this.pendingApprovals) {
			if (pending.threadId !== threadId) continue;
			clearTimeout(pending.timer);
			this.pendingApprovals.delete(requestId);
			void this.replyPermission(pending, "reject", "The turn ended before anyone answered.");
			this.settleApproval(pending, "Cancelled because the turn ended.");
		}
	}

	private async replyPermission(
		pending: Pick<PendingApproval, "sessionID" | "requestId">,
		decision: "once" | "reject",
		message?: string,
	): Promise<void> {
		const host = this.host ? await this.host.promise.catch(() => undefined) : undefined;
		if (!host) return;
		await host.permission
			.reply({
				sessionID: pending.sessionID,
				requestID: pending.requestId,
				decision,
				...(message ? { message } : {}),
			})
			.catch(() => undefined);
	}

	private async onPermissionAsked(data: Record<string, unknown>): Promise<void> {
		const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined;
		const requestId = typeof data.id === "string" ? data.id : undefined;
		const action = typeof data.action === "string" ? data.action : undefined;
		if (!sessionID || !requestId || !action) return;
		if (this.pendingApprovals.has(requestId)) return;

		const found = await this.contextForSession(sessionID);
		if (!found) {
			await this.replyPermission({ sessionID, requestId }, "reject", "There is no conversation to ask in.");
			return;
		}
		const state = await this.policyFor(found.context.channel.id, found.context.kind === "channel" ? undefined : found.threadId);
		if ((state.effective.elicitation ?? "discord") === "off") {
			await this.replyPermission(
				{ sessionID, requestId },
				"reject",
				"Approvals are turned off in this conversation, so this action was not run.",
			);
			return;
		}

		const resources = Array.isArray(data.resources) ? data.resources.map(String) : [];
		const metadata = data.metadata && typeof data.metadata === "object" ? (data.metadata as Record<string, unknown>) : undefined;
		const detail = describeApproval(action, resources, metadata, typeof data.message === "string" ? data.message : undefined);
		const requester = this.requesterByThread.get(found.threadId);
		const content = [
			"🔐 **Eryn needs approval**",
			detail,
			requester ? `Requested by <@${requester}>` : undefined,
			"_This request expires in 90 seconds._",
		]
			.filter(Boolean)
			.join("\n");

		const sent = await this.rest
			.sendMessage(found.threadId, content, {
				components: [
					buttonRow([
						actionButton("Allow once", `approval:once:${requestId}`, 3),
						actionButton("Always here", `approval:always:${requestId}`, 2),
						actionButton("Block here", `approval:block:${requestId}`, 4),
					]),
				],
			})
			.catch((error) => {
				log("session", `could not post an approval card: ${describeError(error)}`);
				return undefined;
			});
		if (!sent) {
			await this.replyPermission({ sessionID, requestId }, "reject", "Eryn could not ask for approval here.");
			return;
		}

		const pending: PendingApproval = {
			requestId,
			sessionID,
			threadId: found.threadId,
			channelId: found.context.channel.id,
			kind: found.context.kind === "channel" ? "channel" : "thread",
			action,
			content,
			...(requester ? { requesterId: requester } : {}),
			messageId: sent.id,
			timer: setTimeout(() => void this.timeoutApproval(requestId), 90_000),
		};
		this.pendingApprovals.set(requestId, pending);
	}

	private async timeoutApproval(requestId: string): Promise<void> {
		const pending = this.pendingApprovals.get(requestId);
		if (!pending) return;
		this.pendingApprovals.delete(requestId);
		await this.replyPermission(pending, "reject", "Nobody approved this in time.");
		this.settleApproval(pending, "⌛ Expired before anyone answered.");
	}

	private async contextForSession(
		sessionID: string,
	): Promise<{ threadId: string; context: DiscordContext } | undefined> {
		const known = this.threadBySession.get(sessionID);
		if (known) {
			const context = this.contextByThread.get(known);
			if (context) return { threadId: known, context };
		}
		const host = this.host ? await this.host.promise.catch(() => undefined) : undefined;
		if (!host) return undefined;
		const session = await host.sessions.get({ sessionID }).catch(() => undefined);
		const context = readDiscordContext(session?.metadata as Record<string, unknown> | undefined);
		if (!context) return undefined;
		const threadId = known ?? context.thread.id;
		this.remember(threadId, sessionID);
		this.contextByThread.set(threadId, context);
		return { threadId, context };
	}

	// --- Schedule scope -------------------------------------------------------

	/**
	 * The schedule that woke this session, or undefined when the latest message
	 * is not a schedule wake.
	 *
	 * OpenCode's schedule runner prompts the session with a user message whose
	 * metadata carries `schedule`. The schedule row stores the exact id of that
	 * message, so comparing it with the latest user message is an exact match:
	 * no time window, and no way for a nearby human message to be mistaken for
	 * a schedule. A cold object can still answer this from the message store.
	 */
	private async scheduleWake(sessionID: string): Promise<{ scheduleId: string } | undefined> {
		const host = this.consumingHost;
		if (!host) return undefined;
		let latestId: string | undefined;
		try {
			const page = await host.message.list({ sessionID, order: "desc", limit: 5, type: "user" });
			const latest = page.data[0];
			latestId = latest?.id;
			const fromMetadata = scheduleIdOf(latest?.metadata);
			if (fromMetadata) return { scheduleId: fromMetadata };
		} catch (error) {
			log("session", `could not read messages for ${sessionID}: ${describeError(error)}`);
		}
		// `execution.started` can be published before the wake message is
		// projected into the message store. The inbox item is admitted first
		// and carries the same metadata, so it closes that window.
		try {
			const inbox = await host.sessions.inbox.list({ sessionID });
			for (const item of inbox) {
				if (item.type !== "user") continue;
				const fromInbox = scheduleIdOf(item.payload.metadata);
				if (fromInbox) return { scheduleId: fromInbox };
			}
		} catch (error) {
			log("session", `could not read the inbox for ${sessionID}: ${describeError(error)}`);
		}
		if (!latestId) return undefined;
		// The metadata is the direct signal; the row's `last_message_id` is the
		// same message id, so this remains exact if the list endpoint ever omits
		// metadata or the inbox has already drained.
		try {
			const rows = this.storage.sql
				.exec(
					`SELECT id, last_message_id FROM schedule
					 WHERE session_id = ? AND last_message_id IS NOT NULL`,
					sessionID,
				)
				.toArray() as { id?: unknown; last_message_id?: unknown }[];
			const row = rows.find((entry) => entry.last_message_id === latestId);
			return typeof row?.id === "string" ? { scheduleId: row.id } : undefined;
		} catch {
			// The table only exists once a session has had schedules enabled.
			return undefined;
		}
	}

	/**
	 * Whether a schedule wake is waiting in the session inbox.
	 *
	 * A pending steer will be promoted into the next execution, so a human
	 * prompt that starts while one is pending must not claim the human
	 * principal. Undefined means the inbox could not be read; callers fail
	 * closed and keep the schedule principal.
	 */
	private async scheduleWakePending(
		host: HostInterface,
		sessionID: string,
	): Promise<boolean | undefined> {
		try {
			const inbox = await host.sessions.inbox.list({ sessionID });
			return inbox.some(
				(item) => item.type === "user" && scheduleIdOf(item.payload.metadata) !== undefined,
			);
		} catch (error) {
			log("session", `could not read the inbox for ${sessionID}: ${describeError(error)}`);
			return undefined;
		}
	}

	/**
	 * Add a fired schedule to an existing scope if its tool hook was missed.
	 *
	 * The create hook is the normal path. This only repairs an id that is
	 * already missing from a scope that exists; it never invents a scope, so a
	 * conversation whose first schedule was unrecorded still fails closed.
	 */
	private reconciled(stored: DiscordContext, scheduleId: string | undefined): DiscordContext {
		const scope = stored.scheduleScope;
		if (!scheduleId || !scope || scope.scheduleIds.includes(scheduleId)) return stored;
		return { ...stored, scheduleScope: addScheduleToScope(scope, scheduleId) };
	}

	/**
	 * Notice a schedule wake steered into a human turn that is already running.
	 *
	 * The runner delivers wakes with `steer`, so if a person is mid-turn the
	 * schedule's instruction joins their execution. Leaving the human speaker
	 * in place would let the schedule act with that person's permissions,
	 * outside its scope. Flip the turn to the schedule's scope instead. The
	 * human's already-finished steps are unaffected; later ones are restricted,
	 * and they can retry a cross-channel request after the turn.
	 */
	private async onScheduleSteered(data: Record<string, unknown>): Promise<void> {
		const sessionID = data.sessionID;
		const item = data.item as
			| { type?: unknown; payload?: { metadata?: unknown } }
			| undefined;
		if (typeof sessionID !== "string" || item?.type !== "user") return;
		const scheduleId = scheduleIdOf(item.payload?.metadata);
		if (!scheduleId) return;
		const threadId = this.threadBySession.get(sessionID);
		const turn = threadId ? this.runs.get(threadId)?.turn : undefined;
		// An idle wake is handled by the normal start attribution; only a wake
		// that is joining an active turn needs to change that turn's principal.
		if (!turn || turn.done) return;
		const host = this.consumingHost;
		if (!host) return;
		try {
			await this.withPrincipalLock(sessionID, async () => {
				const session = await host.sessions.get({ sessionID });
				const stored = readDiscordContext(session.metadata as Record<string, unknown> | undefined);
				if (!stored) return;
				if (stored.scheduleTurn === true && stored.authorId === undefined) return;
				const context = this.reconciled(
					{ ...stored, authorId: undefined, scheduleTurn: true },
					scheduleId,
				);
				await this.saveDiscordContext(host, sessionID, session.metadata, context);
				this.contextByThread.set(stored.thread.id, context);
				this.requesterByThread.delete(stored.thread.id);
				this.appliedContext.delete(stored.thread.id);
			});
		} catch (error) {
			log("session", `could not switch ${sessionID} to its schedule scope: ${describeError(error)}`);
			await host.sessions.interrupt({ sessionID }).catch(() => undefined);
		}
	}

	/**
	 * Attribute a start event with no active turn of ours.
	 *
	 * Only a message the schedule runner wrote marks the turn as scheduled.
	 * Anything else is not provably human — it may be an adopted turn or a
	 * resumed execution — so it fails closed: the stored speaker is cleared
	 * before the tools run. A real human prompt already has an active turn and
	 * never reaches this path.
	 */
	private async attributeScheduleTurn(sessionID: string): Promise<boolean> {
		const host = this.consumingHost;
		if (!host) return false;
		try {
			return await this.withPrincipalLock(sessionID, async () => {
				const session = await host.sessions.get({ sessionID });
				const stored = readDiscordContext(session.metadata as Record<string, unknown> | undefined);
				if (!stored) return false;
				const wake = await this.scheduleWake(sessionID);
				const scheduled = wake !== undefined;
				if (!scheduled && stored.authorId === undefined && stored.scheduleTurn === undefined) return false;
				const context = this.reconciled(
					{
						...stored,
						authorId: undefined,
						scheduleTurn: scheduled ? true : undefined,
					},
					wake?.scheduleId,
				);
				// Attribution wrote (or may have written) outside the prompt path,
				// so the prompt path's signature is stale: the next human prompt
				// must write its own speaker even when the names are unchanged.
				this.appliedContext.delete(stored.thread.id);
				// Later steps of an already-attributed turn reach the same answer,
				// so skip the metadata write without skipping reconciliation.
				if (JSON.stringify(context) === JSON.stringify(stored)) return scheduled;
				await this.saveDiscordContext(host, sessionID, session.metadata, context);
				this.contextByThread.set(stored.thread.id, context);
				this.requesterByThread.delete(stored.thread.id);
				return scheduled;
			});
		} catch (error) {
			log("session", `could not attribute a start for ${sessionID}: ${describeError(error)}`);
			// Do not let the turn continue with whatever speaker was stored: if
			// this is a schedule, that speaker may be a human with more access.
			await host.sessions.interrupt({ sessionID }).catch(() => undefined);
			return false;
		}
	}

	/**
	 * Whether one Discord user may take part in a conversation whose schedules
	 * have a capability scope.
	 *
	 * The schedule owner gets no exemption: the question is whether the user's
	 * own effective permissions cover every capability the scope uses. A normal
	 * conversation has no scope and is unchanged.
	 */
	async canInteract(threadId: string, userId: string): Promise<InteractResponse> {
		const sessionID = await this.sessionFor(threadId);
		if (!sessionID) return { ok: true };
		try {
			let host = this.host ? await this.host.promise.catch(() => undefined) : undefined;
			if (!host) {
				const config = await this.loadHostConfig();
				if (config.connections.length === 0) return { ok: true };
				host = await this.hostFor(config, undefined, false);
			}
			const session = await host.sessions.get({ sessionID });
			const context = readDiscordContext(session.metadata as Record<string, unknown> | undefined);
			const scope = context?.scheduleScope;
			if (!scope || scope.scheduleIds.length === 0) return { ok: true };

			const actual: Record<string, ChannelCapabilities | undefined> = {};
			const missing: string[] = [];
			for (const channelId of Object.keys(scope.channels)) {
				let info: DiscordChannelRef | undefined;
				try {
					info = await this.rest.channel(channelId);
				} catch (error) {
					// A 403/404 means the bot cannot use the channel at all, so it
					// grants nothing; drop it instead of blocking every member of
					// the conversation forever. Anything else is transient: keep
					// the requirement and deny this attempt.
					if (
						error instanceof DiscordError &&
						(error.status === 403 || error.status === 404)
					) {
						missing.push(channelId);
						continue;
					}
					return { ok: false, message: "Eryn could not verify your access to this conversation." };
				}
				if (!info) {
					missing.push(channelId);
					continue;
				}
				actual[channelId] = await this.authority.scopeCapabilities(userId, info);
			}

			// The conversation itself is not a channel the scope may drop: if it
			// cannot be read, the conversation is over as far as Discord is
			// concerned, and everyone should get the denial instead.
			const conversationIds = new Set([context.thread.id, context.channel.id]);
			if (missing.some((channelId) => conversationIds.has(channelId))) {
				return { ok: false, message: "Eryn could not verify your access to this conversation." };
			}

			let effective: typeof scope | undefined = scope;
			if (missing.length > 0) {
				// Re-read under the write lock so a concurrent scope expansion or
				// a deleted last schedule is not overwritten by this prune.
				effective = await this.withPrincipalLock(sessionID, async () => {
					const fresh = await host.sessions.get({ sessionID }).catch(() => undefined);
					if (!fresh) return undefined;
					const freshContext = readDiscordContext(
						fresh.metadata as Record<string, unknown> | undefined,
					);
					// The last schedule was deleted while this check ran. Do not
					// write the old scope back; there is nothing left to enforce.
					if (!freshContext?.scheduleScope) return undefined;
					const channels = { ...freshContext.scheduleScope.channels };
					for (const channelId of missing) delete channels[channelId];
					const pruned = {
						...freshContext.scheduleScope,
						channels,
						updatedAt: Date.now(),
					};
					await this.saveDiscordContext(host, sessionID, fresh.metadata, {
						...freshContext,
						scheduleScope: pruned,
					}).catch((error) =>
						log(
							"session",
							`could not prune deleted scope channels for ${threadId}: ${describeError(error)}`,
						),
					);
					this.appliedContext.delete(threadId);
					return pruned;
				});
				if (!effective) return { ok: true };
			}

			if (scopeCoveredBy(effective, actual)) return { ok: true };
			return {
				ok: false,
				message: "Only people who can access every channel this schedule uses can talk to Eryn here.",
			};
		} catch (error) {
			log("session", `could not check access to ${threadId}: ${describeError(error)}`);
			return { ok: false, message: "Eryn could not verify your access to this conversation." };
		}
	}

	// --- MCP forms ------------------------------------------------------------

	async formView(
		formId: string,
		auth: { userId?: string; manager?: boolean } = {},
	): Promise<FormView | undefined> {
		const pending = this.pendingForms.get(formId);
		if (!pending || !this.mayAnswer(pending, auth.userId, auth.manager)) return undefined;
		return { id: pending.formId, title: "Eryn needs some information", fields: [...pending.fields] };
	}

	/** The requester or a manager may answer a form, the same rule as an approval. */
	private mayAnswer(
		pending: { requesterId?: string },
		userId: string | undefined,
		manager: boolean | undefined,
	): boolean {
		return manager === true || (pending.requesterId !== undefined && userId === pending.requesterId);
	}

	/** Dismiss an MCP form from its card, without answering it. */
	async cancelForm(input: {
		formId: string;
		userId?: string;
		manager?: boolean;
	}): Promise<{ ok: boolean; message?: string }> {
		const pending = this.pendingForms.get(input.formId);
		if (!pending) return { ok: false, message: "That form is no longer waiting." };
		if (!this.mayAnswer(pending, input.userId, input.manager)) {
			return { ok: false, message: "Only the person who asked, or someone with Manage Server, can cancel this." };
		}
		await this.cancelPendingForm(pending, "cancelled in Discord.");
		return { ok: true };
	}

	async replyForm(input: {
		formId: string;
		values: Record<string, string>;
		userId?: string;
		manager?: boolean;
	}): Promise<{ ok: boolean; message?: string }> {
		const pending = this.pendingForms.get(input.formId);
		if (!pending) return { ok: false, message: "That form is no longer waiting." };
		if (!this.mayAnswer(pending, input.userId, input.manager)) {
			return { ok: false, message: "Only the person who asked, or someone with Manage Server, can answer this." };
		}
		const host = this.host ? await this.host.promise.catch(() => undefined) : undefined;
		if (!host) return { ok: false, message: "Eryn is not running right now. Try again." };

		const answer: Record<string, string | number | boolean | readonly string[]> = {};
		for (const [index, field] of pending.fields.entries()) {
			const raw = input.values[`f${index}`]?.trim() ?? "";
			if (field.type === "external") {
				answer[field.key] = true;
				continue;
			}
			if (!raw) {
				if (field.required) return { ok: false, message: `**${field.title}** is required.` };
				continue;
			}
			if (field.type === "boolean") {
				answer[field.key] = /^(yes|true|1|y)$/i.test(raw);
			} else if (field.type === "number" || field.type === "integer") {
				const value = Number(raw);
				if (!Number.isFinite(value)) return { ok: false, message: `**${field.title}** must be a number.` };
				answer[field.key] = field.type === "integer" ? Math.trunc(value) : value;
			} else if (field.type === "multiselect") {
				answer[field.key] = raw.split(",").map((part) => part.trim()).filter(Boolean);
			} else {
				answer[field.key] = raw;
			}
		}

		try {
			await host.sessions.form.reply({ sessionID: pending.sessionID, formID: pending.formId, answer });
		} catch (error) {
			return { ok: false, message: `That form could not be answered: ${describeError(error)}` };
		}
		this.pendingForms.delete(pending.formId);
		clearTimeout(pending.timer);
		this.settleForm(pending, "✅ Answered.");
		return { ok: true };
	}

	private settleForm(pending: PendingForm, result: string): void {
		if (!pending.messageId) return;
		void this.rest
			.editMessage(pending.threadId, pending.messageId, `${pending.content}\n\n${result}`, { components: [] })
			.catch(() => undefined);
	}

	private async cancelPendingForm(pending: PendingForm, message: string): Promise<void> {
		this.pendingForms.delete(pending.formId);
		clearTimeout(pending.timer);
		const host = this.host ? await this.host.promise.catch(() => undefined) : undefined;
		await host?.sessions.form
			.cancel({ sessionID: pending.sessionID, formID: pending.formId, message })
			.catch(() => undefined);
		this.settleForm(pending, `Cancelled: ${message}`);
	}

	private async onFormCreated(data: Record<string, unknown>): Promise<void> {
		const form = data.form as
			| {
					id?: unknown;
					sessionID?: unknown;
					title?: unknown;
					metadata?: unknown;
					fields?: unknown;
			  }
			| undefined;
		if (!form || typeof form.id !== "string" || typeof form.sessionID !== "string") return;
		const formId = form.id;
		const formSessionID = form.sessionID;
		if (this.pendingForms.has(formId)) return;

		let found: { threadId: string; context: DiscordContext } | undefined;
		if (formSessionID === "global") {
			const active = [...this.runs].filter(([, run]) => run.turn && !run.turn.done);
			if (active.length !== 1) {
				// OpenCode attributes MCP forms to a global owner, not the session
				// that called the tool. With more than one live turn there is no
				// honest way to pick a conversation, so fail closed.
				const host = this.host ? await this.host.promise.catch(() => undefined) : undefined;
				await host?.sessions.form
					.cancel({ sessionID: "global", formID: formId, message: "Eryn could not tell which conversation asked." })
					.catch(() => undefined);
				return;
			}
			const threadId = active[0]?.[0];
			const context = threadId ? this.contextByThread.get(threadId) : undefined;
			if (threadId && context) found = { threadId, context };
		} else {
			found = await this.contextForSession(formSessionID);
		}
		if (!found) return;

		const metadata = form.metadata && typeof form.metadata === "object" ? (form.metadata as Record<string, unknown>) : undefined;
		const isMcp = metadata?.kind === "mcp-elicitation";
		const server = isMcp && typeof metadata?.server === "string" ? metadata.server : "Eryn";
		const links = this.currentConfig?.links ?? (await this.store.links());
		const mode = isMcp ? (links.find((link) => link.name === server)?.elicitation ?? "discord") : "discord";
		const fields = Array.isArray(form.fields) ? form.fields.map(formField).filter(Boolean) as FormField[] : [];
		const message = typeof metadata?.message === "string" ? metadata.message : undefined;

		const requester = this.requesterByThread.get(found.threadId);
		const base: Omit<PendingForm, "content" | "timer" | "messageId"> = {
			formId: formId,
			sessionID: formSessionID,
			threadId: found.threadId,
			channelId: found.context.channel.id,
			kind: found.context.kind === "channel" ? "channel" : "thread",
			fields,
			...(requester ? { requesterId: requester } : {}),
		};

		if (mode === "off") {
			const pending: PendingForm = {
				...base,
				content: `**${server} asked for input**`,
				timer: setTimeout(() => undefined, 0),
			};
			await this.cancelPendingForm(pending, "approvals are turned off in this conversation.");
			return;
		}
		if (fields.length > 5) {
			const pending: PendingForm = {
				...base,
				content: `**${server} asked for input**`,
				timer: setTimeout(() => undefined, 0),
			};
			await this.cancelPendingForm(pending, "the form has more fields than Discord can show.");
			return;
		}

		const external = fields.find((field) => field.type === "external");
		const content =
			fields.length === 0
				? [`✅ **${server} is ready to continue**`, message].filter(Boolean).join("\n")
				: external
					? [`🔗 **${server} needs you to open a link**`, message, external.url ?? ""].filter(Boolean).join("\n")
					: [
							`📝 **${server} needs some information**`,
							message,
							"_Open the form and answer it to continue._",
						]
							.filter(Boolean)
							.join("\n");
		const components = [
			buttonRow(
				fields.length === 0
					? [actionButton("Continue", `form:done:${formId}`, 3)]
					: external
						? [
								...(external.url && external.url.length <= 512 ? [linkButton("Open link", external.url)] : []),
								// A URL-mode elicitation is confirmed by the server out of
								// band. Never turn a Discord click into an `accept`.
								actionButton("Cancel", `form:cancel:${formId}`, 2),
							]
						: [actionButton("Open form", `form:open:${formId}`, 1)],
			),
		];
		const sent = await this.rest
			.sendMessage(found.threadId, content, { components })
			.catch((error) => {
				log("session", `could not post an MCP form card: ${describeError(error)}`);
				return undefined;
			});
		if (!sent) {
			const pending: PendingForm = { ...base, content, timer: setTimeout(() => undefined, 0) };
			await this.cancelPendingForm(pending, "Eryn could not ask here.");
			return;
		}

		this.pendingForms.set(formId, {
			...base,
			content,
			messageId: sent.id,
			timer: setTimeout(() => void this.expireForm(formId), 300_000),
		});
	}

	private async expireForm(formId: string): Promise<void> {
		const pending = this.pendingForms.get(formId);
		if (!pending) return;
		await this.cancelPendingForm(pending, "nobody answered in time.");
	}

	/**
	 * Write a conversation's Discord context into its session metadata.
	 *
	 * Merged, so a context write cannot drop metadata another plugin put there.
	 */
	private async saveDiscordContext(
		host: HostInterface,
		sessionID: string,
		metadata: Record<string, unknown> | undefined,
		discord: DiscordContext,
	): Promise<void> {
		await host.sessions.update({
			sessionID,
			metadata: { ...metadata, [DISCORD_METADATA_KEY]: discord } as unknown as SessionMetadata,
		});
	}

	/**
	 * Correct a conversation's stored context after a rename.
	 *
	 * The next prompt refreshes it anyway, but a scheduled turn starts from
	 * metadata alone: writing now means a schedule that fires before the next
	 * message still knows the current name. A conversation with no session yet
	 * needs nothing, because its first prompt writes the context from scratch.
	 */
	async updateContext(config: HostConfig, threadId: string, discord: DiscordContext): Promise<void> {
		const sessionID = await this.sessionFor(threadId);
		if (!sessionID) return;
		const host = await this.hostFor(config);
		const session = await host.sessions.get({ sessionID }).catch((error) => {
			log("session", `could not read ${sessionID} to record a rename: ${describeError(error)}`);
			return undefined;
		});
		if (!session) return;
		// A rename event carries no speaker or scope. Keep what the stored
		// context already has so a rename between two messages neither erases
		// who may act nor drops the schedules' capability scope.
		const existing = readDiscordContext(session.metadata as Record<string, unknown> | undefined);
		const merged: DiscordContext = {
			...discord,
			...(!discord.authorId && existing?.authorId ? { authorId: existing.authorId } : {}),
			...(discord.scheduleTurn === undefined && existing?.scheduleTurn !== undefined
				? { scheduleTurn: existing.scheduleTurn }
				: {}),
			...(!discord.scheduleScope && existing?.scheduleScope ? { scheduleScope: existing.scheduleScope } : {}),
		};
		await this.saveDiscordContext(host, sessionID, session.metadata, merged);
		// The prompt path keeps the last signature it wrote; drop it so a stale
		// value cannot make the next prompt skip a needed write.
		this.appliedContext.delete(threadId);
	}

	/**
	 * Re-read the names of a conversation from Discord.
	 *
	 * Ids never change, so only the names are refreshed. This is the fallback
	 * for a rename event that arrived while this object had no gateway
	 * connection, and it is what a scheduled turn relies on when it starts from
	 * metadata without a gateway event in front of it.
	 */
	private async refreshContext(context: DiscordContext): Promise<DiscordContext> {
		const conversation = await this.rest.channel(context.thread.id).catch(() => undefined);
		if (!conversation) return context;

		const thread = conversation.name
			? { id: conversation.id, name: conversation.name }
			: context.thread;
		let channel = context.channel;
		if (conversation.parent_id) {
			const parent = await this.rest.channel(conversation.parent_id).catch(() => undefined);
			if (parent?.name) channel = { id: parent.id, name: parent.name };
		} else if (conversation.name) {
			// A subscribed channel is its own conversation, so there is no parent
			// whose name would be the room the agent is in.
			channel = { id: conversation.id, name: conversation.name };
		}
		return { ...context, channel, thread };
	}

	/**
	 * Cancel a thread's running turn, keeping its session for later messages.
	 * `gone` means the thread itself was deleted, so the reply is dropped rather
	 * than attempted, and the conversation's schedules and session go with it.
	 */
	async interrupt(threadId: string | undefined, gone: boolean, config?: HostConfig): Promise<boolean> {
		if (!threadId) return false;
		this.cancelPendingForThread(threadId);
		const run = this.runs.get(threadId);
		const sessionID = await this.sessionFor(threadId);

		if (gone) {
			// A deleted conversation can never show a reply, so no schedule may
			// wake this guild to run a turn for it. Delete them before anything
			// else, in case the current turn takes a while to settle.
			if (sessionID) await this.clearSchedules(sessionID, config);
			if (run?.turn) run.turn.gone = true;
			// Stop inference now. A scheduled turn can be running without an
			// in-memory run for it, so this cannot depend on `run.turn`.
			const stopped = await this.interruptSession(sessionID);
			// A tracked turn discards the thread once it has settled; with no turn
			// there is nothing left to wait for, so clean up immediately.
			if (!run?.turn) await this.discardThread(threadId, config);
			return stopped;
		}

		if (!run?.turn || !this.host || !sessionID) return false;
		await (await this.host.promise).sessions.interrupt({ sessionID });
		return true;
	}

	/**
	 * Stop whatever a Session is running, even a turn this object does not track.
	 *
	 * A schedule can start a turn after an eviction, before this object has
	 * adopted it, so the in-memory run map is not enough to know whether there
	 * is inference to cancel.
	 */
	private async interruptSession(sessionID: string | undefined): Promise<boolean> {
		if (!sessionID || !this.host) return false;
		try {
			const result = await (await this.host.promise).sessions.interrupt({ sessionID });
			return result.interrupted;
		} catch (error) {
			log("session", `could not interrupt ${sessionID}: ${describeError(error)}`);
			return false;
		}
	}

	/**
	 * Delete every schedule that would fire into a conversation that no longer
	 * exists.
	 *
	 * Uses the host's schedule API rather than the `schedule` table so a change
	 * to OpenCode's schema does not break the cleanup. A cold object builds a
	 * host with the runner disabled: there is no reason to start it just to
	 * delete the schedules it would have run.
	 */
	private async clearSchedules(sessionID: string, config?: HostConfig): Promise<void> {
		const host = await this.cleanupHost(config);
		if (!host) return;
		try {
			const schedules = await host.experimental.schedule.list({ sessionID });
			await Promise.all(
				schedules.map((schedule) =>
					host.experimental.schedule.delete({ scheduleID: schedule.id }).catch((error) =>
						log("session", `could not delete schedule ${schedule.id}: ${describeError(error)}`),
					),
				),
			);
		} catch (error) {
			log("session", `could not delete the schedules for ${sessionID}: ${describeError(error)}`);
		}
	}

	/**
	 * The host to use for cleaning up a deleted conversation.
	 *
	 * A cold object builds one with the schedule runner disabled, so cleanup
	 * does not start the runner only to delete what it would have fired.
	 */
	private async cleanupHost(config?: HostConfig): Promise<HostInterface | undefined> {
		try {
			if (this.host) return await this.host.promise;
			return config ? await this.hostFor(config, undefined, false) : undefined;
		} catch (error) {
			log("session", `could not build a host for cleanup: ${describeError(error)}`);
			return undefined;
		}
	}

	/**
	 * Forget everything about a thread whose Discord conversation is gone.
	 *
	 * Schedules are deleted explicitly because Durable Object SQLite does not
	 * enable foreign keys, so deleting the Session never cascades to them.
	 * Removing the Session also cancels work it still has running and releases
	 * its messages and child sessions.
	 */
	private async discardThread(threadId: string, config?: HostConfig): Promise<void> {
		const sessionID = await this.sessionFor(threadId);
		this.forget(threadId);
		this.runs.delete(threadId);
		this.appliedModels.delete(threadId);
		this.appliedContext.delete(threadId);
		await this.storage.delete(KEYS.session + threadId).catch(() => undefined);
		if (!sessionID) return;
		this.discarded.add(sessionID);
		// The turn that just settled may have created a schedule after the first
		// pass, so clear them again before the Session is removed.
		await this.clearSchedules(sessionID, config);
		await this.removeSession(sessionID, config);
	}

	/**
	 * Delete a conversation's Session once its Discord conversation is gone.
	 *
	 * A host that is not in memory has no running work to stop, but it may have
	 * left a suspended Session that the next boot would resume, so it is built
	 * from `config` to remove the Session properly. That also releases the
	 * Session's messages and child sessions.
	 */
	private async removeSession(sessionID: string, config?: HostConfig): Promise<void> {
		const host = await this.cleanupHost(config);
		if (!host) return;
		try {
			await host.sessions.remove({ sessionID });
		} catch (error) {
			log("session", `could not remove the session for a deleted conversation: ${describeError(error)}`);
		}
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
		this.turnFloor.delete(threadId);
	}

	private async ensureSession(
		host: HostInterface,
		threadId: string,
		title: string,
		directory: string,
		model: string,
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

		// The location groups the session into the channel's project. It is not a
		// filesystem boundary: the agent's files live in the shared workspace.
		// The model is set on the session itself rather than in the host config,
		// so the user-editable config is not shadowed by Eryn's guild choice.
		const ref = parseModelRef(model);
		const session = await host.sessions.create({
			title,
			location: { directory },
			...(ref ? { model: ref } : {}),
		});
		if (ref) this.appliedModels.set(threadId, model);
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
					await this.handleEvent(event);
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

	private async handleEvent(event: unknown): Promise<void> {
		const shape = event as { type?: unknown; created?: unknown; data?: unknown };
		if (typeof shape.type !== "string" || !shape.data || typeof shape.data !== "object") return;
		const data = shape.data as Record<string, unknown>;
		if (shape.type === "form.created") {
			void this.onFormCreated(data).catch((error) =>
				log("session", `could not show an MCP form: ${describeError(error)}`),
			);
			return;
		}
		if (shape.type === "permission.replied") {
			this.onPermissionReplied(data);
			return;
		}
		if (shape.type === "form.replied" || shape.type === "form.cancelled") {
			this.onFormSettled(data, shape.type === "form.replied" ? "replied" : "cancelled");
			return;
		}
		if (shape.type === "session.inbox.enqueued") {
			await this.onScheduleSteered(data);
			return;
		}
		const sessionID = data.sessionID;
		if (typeof sessionID !== "string") return;
		if (shape.type === "session.compaction.ended" || shape.type === "session.compaction.failed") {
			this.settleCompaction(data, shape.type === "session.compaction.ended");
			return;
		}
		if (shape.type === "permission.asked") {
			void this.onPermissionAsked(data).catch((error) =>
				log("session", `could not show an approval: ${describeError(error)}`),
			);
			return;
		}
		// A start event with no turn of ours is either a schedule firing or a
		// prompt this object did not see. Attribute or clear the speaker before
		// adopting, so the tools never read the previous speaker's access.
		if (shape.type === "session.execution.started" || shape.type === "session.step.started") {
			const mapped = this.threadBySession.get(sessionID);
			const active = mapped ? this.runs.get(mapped)?.turn : undefined;
			if (!active) await this.attributeScheduleTurn(sessionID);
		}
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
		// Ignore events from an execution that was interrupted just before this
		// turn: its late `execution.interrupted` must not complete the new turn.
		const floor = this.turnFloor.get(threadId);
		if (floor !== undefined && typeof shape.created === "number" && shape.created < floor) return;
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
		if (!host || this.adopting.has(sessionID) || this.discarded.has(sessionID)) return;
		this.adopting.add(sessionID);
		void (async () => {
			try {
				const session = await host.sessions.get({ sessionID });
				const stored = readDiscordContext(session.metadata as Record<string, unknown> | undefined);
				// A scheduled turn starts from metadata with no message to carry a
				// rename, so correct the names before following the turn.
				const refreshed = stored ? await this.refreshContext(stored) : undefined;
				// A turn this object did not start has no speaker of its own. Only
				// a schedule wake message may claim its stored scope; anything else
				// clears the speaker and refuses cross-channel actions.
				const wake = stored ? await this.scheduleWake(sessionID) : undefined;
				const scheduled = wake !== undefined;
				const context = refreshed
					? this.reconciled(
							{
								...refreshed,
								authorId: undefined,
								scheduleTurn: scheduled ? true : undefined,
							},
							wake?.scheduleId,
						)
					: undefined;
				const threadId = context?.thread.id;
				if (!threadId || this.runs.get(threadId)?.turn || this.discarded.has(sessionID)) return;
				if (stored && context && JSON.stringify(stored) !== JSON.stringify(context)) {
					try {
						await this.saveDiscordContext(host, sessionID, session.metadata, context);
					} catch (error) {
						// Without the attribution write the tools would read the
						// previous speaker. Stop the turn instead of running it with
						// authority that may not belong to it.
						log("session", `could not record the renamed context for ${sessionID}: ${describeError(error)}`);
						await host.sessions.interrupt({ sessionID }).catch(() => undefined);
						return;
					}
				}
				// This context was written outside the prompt path, so the next
				// human prompt must not trust a matching signature.
				this.appliedContext.delete(threadId);

				this.remember(threadId, sessionID);
				// Approvals during a scheduled turn must not name, or be approved
				// by, whoever happened to speak last.
				this.requesterByThread.delete(threadId);
				if (context) {
					this.contextByThread.set(threadId, context);
					if (this.currentConfig) await this.applyPolicy(host, threadId, sessionID, context, this.currentConfig);
				}
				await this.runTurn(
					threadId,
					`scheduled turn for ${sessionID}`,
					async () => undefined,
					() => host.sessions.interrupt({ sessionID }).catch(() => undefined),
				);
			} catch (error) {
				log("session", `scheduled turn for ${sessionID} failed: ${describeError(error)}`);
			} finally {
				this.adopting.delete(sessionID);
			}
		})();
	}
}

/**
 * The schedule id on a wake message's metadata, if this is one.
 *
 * The runner writes `{ schedule: { id, run, dueAt, ... } }` when it prompts a
 * session. A human message has no such key.
 */
function scheduleIdOf(metadata: unknown): string | undefined {
	if (!metadata || typeof metadata !== "object") return undefined;
	const schedule = (metadata as { schedule?: unknown }).schedule;
	if (!schedule || typeof schedule !== "object") return undefined;
	const id = (schedule as { id?: unknown }).id;
	return typeof id === "string" ? id : undefined;
}

/** A one-line, human-readable description of what an approval is for. */
function describeApproval(
	action: string,
	resources: readonly string[],
	metadata: Record<string, unknown> | undefined,
	message: string | undefined,
): string {
	const input = metadata?.input && typeof metadata.input === "object" ? (metadata.input as Record<string, unknown>) : undefined;
	const first = resources.find((resource) => resource !== "*");
	const command = typeof input?.command === "string" ? input.command : undefined;
	const path = typeof input?.filePath === "string" ? input.filePath : first;
	let detail: string;
	if (action === "discord.cross-channel" && typeof metadata?.targetChannelId === "string") {
		detail = `Act in another Discord channel: <#${metadata.targetChannelId}>`;
	} else if ((action === "bash" || action === "shell") && command) detail = `Run \`${command}\``;
	else if ((action === "edit" || action === "write" || action === "read") && path) detail = `${action === "read" ? "Read" : "Change"} \`${path}\``;
	else if (message) detail = message;
	else detail = `Use **${action}**${first ? ` on \`${first}\`` : ""}`;
	return detail.length > 400 ? `${detail.slice(0, 399)}…` : detail;
}

/** Normalise one OpenCode form field for Discord. */
function formField(raw: unknown): FormField | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const field = raw as Record<string, unknown>;
	if (typeof field.key !== "string") return undefined;
	const options = Array.isArray(field.options)
		? field.options
				.map((option) =>
					option && typeof option === "object" && typeof (option as { value?: unknown }).value === "string"
						? (option as { value: string }).value
						: typeof option === "string"
							? option
							: undefined,
				)
				.filter((option): option is string => option !== undefined)
		: undefined;
	return {
		key: field.key,
		title: typeof field.title === "string" ? field.title : field.key,
		type: typeof field.type === "string" ? field.type : "string",
		required: field.required === true,
		...(typeof field.description === "string" ? { description: field.description } : {}),
		...(typeof field.placeholder === "string" ? { placeholder: field.placeholder } : {}),
		...(typeof field.url === "string" ? { url: field.url } : {}),
		...(options?.length ? { options } : {}),
	};
}

/** Build the guild's agent, sharing the object's storage and Discord client. */
export function createGuildAgent(
	env: Env,
	storage: DurableObjectStorage,
	rest: DiscordRest,
	store: GuildStoreShape,
	guildId: string,
): GuildAgentShape {
	return new GuildAgentImpl(env, storage, rest, store, TURN_TIMEOUT_MS, guildId);
}
