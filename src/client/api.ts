/** The typed boundary between the Solid app and the Worker's JSON API. */

export interface Guild {
	id: string;
	name: string;
	icon: string | null;
	configured: boolean;
	model: string;
	updatedAt: number | null;
	githubRepo: string | null;
	githubInstalled: boolean;
	githubInstallUrl: string | null;
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
	action: "save" | "remove";
	guildId: string;
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

export function saveGuild(input: SaveGuildInput): Promise<ApiResult> {
	return request<ApiResult>("/api/setup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			action: input.action,
			guild_id: input.guildId,
			api_key: input.apiKey,
			model: input.model,
			github_repo: input.githubRepo,
		}),
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

