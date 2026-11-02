/**
 * The typed boundary between the Solid app and the gateway's JSON API.
 *
 * Every request is same-origin and carries the session cookie; the shapes here
 * mirror `CONTRACT.md` §5 (the routes) and §6 (the models).
 */

// --- Models (CONTRACT §6) -----------------------------------------------------

/** The providers an account can be connected through. */
export type ProviderId = "discord" | "github" | "google";

/** How much of a tool group a server exposes. `all` is read + write. */
export type ToolAccessLevel = "none" | "read" | "write" | "all";

/** The public profile of a connected account, as shown in the console. */
export interface Profile {
	id: string;
	username: string;
	name?: string;
	avatarUrl?: string;
	/** A public profile link, when the provider has one. */
	url?: string;
}

export interface AccountSummary {
	id: string;
	provider: ProviderId;
	label: string;
	profile: Profile;
	createdAt: number;
}

export interface ProviderSummary {
	id: ProviderId;
	name: string;
	/** The flows this deployment can offer for the provider. */
	connect: ("oauth" | "pat")[];
	configured: boolean;
}

/** Per-tool overrides on top of the group levels. */
export interface ToolOverride {
	include?: string[];
	exclude?: string[];
	/** What a tool counts as when its group is read or write. */
	access?: Record<string, "read" | "write">;
}

export interface ToolAccess {
	groups: Record<string, ToolAccessLevel>;
	tools?: ToolOverride;
}

export interface ToolEntry {
	name: string;
	title: string;
	description: string;
	group: string;
	access: "read" | "write";
}

export interface ToolGroup {
	id: string;
	name: string;
	tools: ToolEntry[];
}

/** An account available to a hosted server's tools. */
export interface ServerAccountRef {
	id: string;
	provider: ProviderId;
	label: string;
}

/** A Discord server Eryn has granted this hosted server to. */
export interface ServerGrant {
	guildId: string;
}

export interface ServerSummary {
	id: string;
	name: string;
	title?: string;
	enabled: boolean;
	accounts: ServerAccountRef[];
	tools: ToolAccess;
	/** Other MCP servers whose tools this one federates. */
	connections: UpstreamConnection[];
	endpoint: string;
	grants: ServerGrant[];
}

/** One tool an upstream MCP server offers, as the console lists it. */
export interface UpstreamTool {
	/** The name on the upstream server. */
	name: string;
	/** The name this hosted server exposes; a tool rule uses this one. */
	exposedName: string;
	title?: string;
	description?: string;
	access: "read" | "write";
}

/** A federated MCP server. Headers and tokens never reach the browser. */
export interface UpstreamConnection {
	id: string;
	name: string;
	title?: string;
	url: string;
	enabled: boolean;
	auth: "none" | "headers" | "oauth";
	/** Header names, without their values. */
	headerNames: string[];
	authenticated: boolean;
	pending: boolean;
	tools: UpstreamTool[];
}

export interface Grant {
	guildId: string;
	mcpServerId: string;
	toolNames: string[];
	createdAt: number;
}

export interface McpLink {
	id: string;
	kind: "eryn" | "external";
	name: string;
	url: string;
	mcpServerId?: string;
	tools: ToolAccess;
	createdAt: number;
}

// --- Wire helpers -------------------------------------------------------------

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, { credentials: "same-origin", ...init });
	const body = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new Error(body.error ?? `Request failed (HTTP ${response.status})`);
	return body;
}

// --- Runtime config and session -----------------------------------------------

/** Public runtime configuration, fetched once at boot. */
export interface ClientConfig {
	posthog: { key: string; uiHost: string } | null;
}

export function fetchConfig(): Promise<ClientConfig> {
	return request<ClientConfig>("/api/config");
}

export interface SessionAccount {
	id: string;
	name: string;
	avatarUrl?: string;
}

export interface SessionState {
	signedIn: boolean;
	account?: SessionAccount;
}

export function fetchSession(): Promise<SessionState> {
	return request<SessionState>("/api/session");
}

// --- Accounts (CONTRACT §5) ---------------------------------------------------

export interface AccountsData {
	signedIn: boolean;
	accounts: AccountSummary[];
	providers: ProviderSummary[];
}

/** The result of any account mutation. */
export interface ActionResult {
	ok?: boolean;
	message?: string;
	error?: string;
	/** Set by the OAuth actions, which hand the browser a URL to visit. */
	url?: string;
}

export type AccountsAction =
	| { action: "add-discord" }
	| { action: "start-github-oauth" }
	| { action: "add-github-pat"; token: string }
	| { action: "start-google-oauth" }
	| { action: "unlink"; id: string }
	| { action: "label"; id: string; label: string };

export function fetchAccounts(): Promise<AccountsData> {
	return request<AccountsData>("/api/accounts");
}

export function accountsAction(action: AccountsAction): Promise<ActionResult> {
	return request<ActionResult>("/api/accounts", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(action),
	});
}

// --- Tools catalogue (CONTRACT §5) --------------------------------------------

export interface ToolsData {
	groups: ToolGroup[];
}

export function fetchTools(): Promise<ToolsData> {
	return request<ToolsData>("/api/tools");
}

// --- Hosted MCP servers (CONTRACT §5) -----------------------------------------

export interface ServersData {
	signedIn: boolean;
	servers: ServerSummary[];
}

/** The result of any hosted-server mutation. */
export interface ServersResult extends ActionResult {
	/** The updated servers, when the action returns them. */
	servers?: ServerSummary[];
	/** The tools a server exposes, from the `tools-list` action. */
	tools?: ToolEntry[];
}

export type ServersAction =
	| { action: "create"; name: string; title?: string }
	| { action: "update"; id: string; name?: string; title?: string; enabled?: boolean }
	| { action: "delete"; id: string }
	| { action: "accounts"; id: string; accountIds: string[] }
	| { action: "tools"; id: string; tools: ToolAccess }
	| { action: "tools-list"; id: string }
	| { action: "revoke-grant"; id: string; guildId: string }
	| {
			action: "connection-add";
			id: string;
			url: string;
			name?: string;
			title?: string;
			auth: "none" | "headers" | "oauth";
			headers?: Record<string, string>;
	  }
	| { action: "connection-refresh"; id: string; connectionId: string }
	| { action: "connection-signin"; id: string; connectionId: string }
	| { action: "connection-update"; id: string; connectionId: string; title?: string; enabled?: boolean }
	| { action: "connection-remove"; id: string; connectionId: string };

export function fetchServers(): Promise<ServersData> {
	return request<ServersData>("/api/servers");
}

export function serversAction(action: ServersAction): Promise<ServersResult> {
	return request<ServersResult>("/api/servers", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(action),
	});
}

// --- MCP consent (CONTRACT §5) ------------------------------------------------

/** What the consent screen needs to know about a pending authorization. */
export interface AuthorizeRequest {
	ok: boolean;
	client?: string;
	scope?: string;
	resource?: string;
	/** Set when the visitor is not signed in; the page sends them to `signInUrl`. */
	needSignIn?: boolean;
	signInUrl?: string;
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
