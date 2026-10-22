/** The typed boundary between the Solid app and the Worker's JSON API. */

export interface Guild {
	id: string;
	name: string;
	icon: string | null;
	configured: boolean;
	model: string;
	/** The providers this server has connected. */
	connections: GuildConnection[];
	updatedAt: number | null;
	githubRepo: string | null;
	githubInstalled: boolean;
	githubInstallUrl: string | null;
}

/** A provider a server has connected. The key itself never leaves the backend. */
export interface GuildConnection {
	integrationID: string;
	/** The start of the key, or undefined when it was set another way. */
	prefix?: string;
}

/** One input a flow needs before it can start, as the provider declares it. */
export interface ProviderField {
	key: string;
	type: "string" | "number" | "integer" | "boolean";
	title?: string;
	description?: string;
	placeholder?: string;
	required?: boolean;
	default?: string | number | boolean;
	/** A string field restricted to a fixed set of choices. */
	options?: { value: string; label: string; description?: string }[];
	/** Only ask for this field while these conditions hold. */
	when?: { key: string; op: "eq" | "neq"; value: string | number | boolean }[];
}

/** One way a provider can be connected, as its own OpenCode server describes it. */
export interface ProviderMethod {
	type: string;
	/** OAuth methods are addressed by id when a flow is started. */
	id?: string;
	label: string;
	/** Whether this deployment can run the flow at all. */
	supported: boolean;
	/** What the flow needs before it can start, such as a deployment type. */
	fields?: ProviderField[];
}

/** A provider a server could connect, and how connecting it would work. */
export interface Provider {
	id: string;
	name: string;
	connected: boolean;
	methods: ProviderMethod[];
}

/** A sign-in the backend has started, and where to send the user. */
export interface OAuthAttempt {
	attemptID: string;
	url: string;
	instructions: string;
	/** `auto` finishes on its own; `code` needs the code the provider showed. */
	mode: "auto" | "code";
}

export interface OAuthAttemptStatus {
	status: "pending" | "complete" | "failed" | "expired";
	message?: string;
}

/** A model the guild's key can reach, as reported by its own OpenCode server. */
export interface ModelOption {
	/** The `provider/model` reference to store, e.g. `opencode-go/kimi-k3`. */
	id: string;
	name: string;
	provider: string;
	status: string;
	enabled: boolean;
}

export interface ModelsResult {
	models: ModelOption[];
	default?: string;
	reason?: string;
	error?: string;
}

/** A manageable server Eryn is not installed in yet. */
export interface AvailableGuild {
	id: string;
	name: string;
	icon: string | null;
}

export interface Account {
	id: string;
	name: string;
}

export interface SessionState {
	signedIn: boolean;
	account?: Account;
}

export interface SetupData {
	signedIn: boolean;
	account?: Account;
	githubConfigured?: boolean;
	guilds?: Guild[];
	available?: AvailableGuild[];
}

/** Public runtime configuration, fetched once at boot. */
export interface ClientConfig {
	posthog: { key: string; uiHost: string } | null;
}

export interface SaveGuildInput {
	/** `save` stores the model and GitHub binding, `remove` drops everything. */
	action: "save" | "remove" | "connect" | "disconnect";
	guildId: string;
	integrationId?: string;
	apiKey?: string;
	model?: string;
	githubRepo?: string;
}

export interface ApiResult {
	ok?: boolean;
	message?: string;
	error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, { credentials: "same-origin", ...init });
	const body = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new Error(body.error ?? `Request failed (HTTP ${response.status})`);
	return body;
}

export function fetchSetup(): Promise<SetupData> {
	return request<SetupData>("/api/setup");
}

export function fetchSession(): Promise<SessionState> {
	return request<SessionState>("/api/session");
}

export function fetchConfig(): Promise<ClientConfig> {
	return request<ClientConfig>("/api/config");
}

/**
 * Ask the guild's own OpenCode server which models its key can reach.
 *
 * The key stays on the backend: it is read from the registry and used over the
 * internal Durable Object binding, so the browser never sees it.
 */
export function fetchModels(guildId: string): Promise<ModelsResult> {
	return request<ModelsResult>("/api/models", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ guild_id: guildId }),
	});
}

export function saveGuild(input: SaveGuildInput): Promise<ApiResult> {
	return request<ApiResult>("/api/setup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			action: input.action,
			guild_id: input.guildId,
			integration_id: input.integrationId,
			api_key: input.apiKey,
			model: input.model,
			github_repo: input.githubRepo,
		}),
	});
}

/**
 * The providers a server could connect, from its own embedded OpenCode server.
 *
 * Which providers exist, and how each one authenticates, is OpenCode's business:
 * this is the same catalogue a turn resolves against, so a provider added
 * upstream shows up here without a change to Eryn.
 */
export function fetchProviders(guildId: string): Promise<{ integrations: Provider[] }> {
	return request<{ integrations: Provider[] }>("/api/providers", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ guild_id: guildId }),
	});
}

/** One step of a provider sign-in: start it, poll it, finish it, or drop it. */
export function oauth(input: {
	action: "start" | "status" | "complete" | "cancel";
	guildId: string;
	integrationId: string;
	methodId?: string;
	attemptId?: string;
	code?: string;
	answer?: Record<string, unknown>;
}): Promise<{ attempt?: OAuthAttempt; status?: OAuthAttemptStatus; ok?: boolean }> {
	return request("/api/oauth", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			action: input.action,
			guild_id: input.guildId,
			integration_id: input.integrationId,
			method_id: input.methodId,
			attempt_id: input.attemptId,
			code: input.code,
			answer: input.answer,
		}),
	});
}

// --- MCP servers (the ones you connect) ---------------------------------------

/** A remote MCP server this user has connected. The token stays on the backend. */
export interface McpServer {
	id: string;
	name: string;
	url: string;
	enabled: boolean;
	/** Whether a sign-in is stored, so the dashboard can say so. */
	authorized: boolean;
}

export interface McpServersResult {
	signedIn: boolean;
	servers: McpServer[];
}

export interface McpServerResult extends ApiResult {
	servers?: McpServer[];
	/** What a live call to the server reported, for the "tools" action. */
	tools?: { name: string; description: string }[];
}

/** The servers this user has connected. */
export function fetchMcpServers(): Promise<McpServersResult> {
	return request<McpServersResult>("/api/mcp/servers");
}

/** Add, remove, enable, disable, or inspect one of them. */
export function mcpServerAction(input: {
	action: "add" | "remove" | "enable" | "disable" | "tools";
	id?: string;
	name?: string;
	url?: string;
}): Promise<McpServerResult> {
	return request<McpServerResult>("/api/mcp/servers", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
}

/**
 * Start a server's sign-in.
 *
 * The browser is sent to the returned URL; the authorization server brings it
 * back to Eryn, which stores the tokens and returns it here.
 */
export function startMcpSignIn(id: string): Promise<{ url?: string; error?: string }> {
	return request<{ url?: string; error?: string }>("/api/mcp/servers/oauth", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action: "oauth", id }),
	});
}

// --- MCP ----------------------------------------------------------------------

/** What the consent screen needs to know about a pending authorization. */
export interface AuthorizeRequest {
	ok: boolean;
	client?: string;
	scope?: string;
	resource?: string;
	error?: string;
	description?: string;
}

export interface AuthorizeDecision {
	ok: boolean;
	redirect?: string;
	error?: string;
	description?: string;
}

/** Validate an authorization request before rendering consent. */
export function describeAuthorization(query: string): Promise<AuthorizeRequest> {
	return request<AuthorizeRequest>(`/api/mcp/authorize?${query}`);
}

/** Approve or deny it; the response carries the URL to send the browser to. */
export function decideAuthorization(input: { approve: boolean; query: string }): Promise<AuthorizeDecision> {
	return request<AuthorizeDecision>("/api/mcp/authorize", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ approve: input.approve, query: input.query }),
	});
}

/** Register a client directly with the MCP authorization server. */
export function registerMcpClient(input: { name: string; redirectUri: string }): Promise<{ client_id: string }> {
	return request<{ client_id: string }>("/oauth/register", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_name: input.name, redirect_uris: [input.redirectUri], scope: "mcp" }),
	});
}

export interface McpTokens {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	scope?: string;
}

/** Exchange an authorization code for tokens, exactly as a harness would. */
export function exchangeMcpCode(input: {
	code: string;
	verifier: string;
	redirectUri: string;
	clientId: string;
}): Promise<McpTokens> {
	return request<McpTokens>("/oauth/token", {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code: input.code,
			code_verifier: input.verifier,
			redirect_uri: input.redirectUri,
			client_id: input.clientId,
		}).toString(),
	});
}

/** Call the MCP endpoint over Streamable HTTP. */
export async function callMcp(
	body: unknown,
	options: { token?: string; sessionId?: string; protocolVersion?: string } = {},
): Promise<{ response: Response; json: unknown }> {
	const response = await fetch("/mcp", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
			...(options.sessionId ? { "mcp-session-id": options.sessionId } : {}),
			// Required on every request after `initialize` on stateful revisions.
			...(options.protocolVersion ? { "mcp-protocol-version": options.protocolVersion } : {}),
		},
		body: JSON.stringify(body),
	});
	const text = await response.text();
	// A Streamable HTTP reply may be an SSE stream; take the last data frame.
	const payload = text.includes("data:")
		? text
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => line.slice(5).trim())
				.at(-1)
		: text;
	let json: unknown;
	try {
		json = JSON.parse(payload ?? "");
	} catch {
		json = undefined;
	}
	return { response, json };
}

