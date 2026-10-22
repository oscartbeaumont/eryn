/**
 * The remote MCP servers a user has connected.
 *
 * They belong to a Discord user rather than to a server, so a person sets them
 * up once and every server they run Eryn in gets them. They are stored in the
 * registry, encrypted, for the same reason provider keys are: the plaintext is
 * only ever read by the Worker and by the Durable Objects acting for that user.
 */

import { refreshTokens, type McpAuthorization, type McpClientRegistration } from "./auth";

/** One connected server, with everything needed to call it. */
export interface McpServerRecord {
	id: string;
	name: string;
	url: string;
	enabled: boolean;
	/** Present once the server has been signed in to. */
	auth?: McpServerAuth;
	createdAt: number;
}

/** The client we registered and the tokens it issued. */
export interface McpServerAuth {
	clientId: string;
	clientSecret?: string;
	/**
	 * The discovered endpoints, kept so a refresh does not have to re-discover
	 * them — and so a server that stops publishing its metadata still works.
	 */
	authorization: McpAuthorization;
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
}

/** What the dashboard is told. Never a token. */
export interface McpServerSummary {
	id: string;
	name: string;
	url: string;
	enabled: boolean;
	/** Whether a sign-in is stored, so the dashboard can say so. */
	authorized: boolean;
}

export function summarise(record: McpServerRecord): McpServerSummary {
	return {
		id: record.id,
		name: record.name,
		url: record.url,
		enabled: record.enabled,
		authorized: Boolean(record.auth?.accessToken),
	};
}

/** The registry's storage key for a user's servers. */
export function storageKey(userId: string): string {
	return `mcp:${userId}`;
}

/** A fresh id for a server, stable across renames. */
export function newServerId(): string {
	return `mcp_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
}

/**
 * The name a tool is exposed under.
 *
 * Tool names are flat across every server a gateway fronts, so they are prefixed
 * with the server they came from. The name is normalised because a display name
 * may hold spaces or punctuation that a tool name may not.
 */
export function namespaced(server: McpServerRecord, tool: string): string {
	const prefix = server.name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 24);
	return prefix ? `${prefix}_${tool}` : tool;
}

/**
 * A token that can be presented now, refreshing it when it has expired.
 *
 * Returns the record to store back when a refresh happened, so a caller can
 * persist the new token rather than refreshing again on the next request.
 */
export async function ensureToken(record: McpServerRecord): Promise<{ token?: string; updated?: McpServerRecord }> {
	const auth = record.auth;
	if (!auth) return {};
	// A minute of slack, so a token cannot expire mid-request.
	if (auth.expiresAt !== undefined && auth.expiresAt - 60_000 > Date.now()) return { token: auth.accessToken };
	if (!auth.refreshToken) return { token: auth.accessToken };

	try {
		const client: McpClientRegistration = { clientId: auth.clientId, ...(auth.clientSecret ? { clientSecret: auth.clientSecret } : {}) };
		const tokens = await refreshTokens({ authorization: auth.authorization, client, refreshToken: auth.refreshToken });
		const updated: McpServerRecord = {
			...record,
			auth: {
				...auth,
				accessToken: tokens.accessToken,
				...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
				...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
			},
		};
		return { token: tokens.accessToken, updated };
	} catch {
		// A refresh that fails leaves the old token in place: the call will report
		// the authorization failure, which is what tells the user to sign in again.
		return { token: auth.accessToken };
	}
}

// --- Storage -----------------------------------------------------------------

function registry(env: Env) {
	return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

/** A user's servers, tokens included. */
export async function readMcpServers(env: Env, userId: string): Promise<McpServerRecord[]> {
	const response = await registry(env).fetch(`https://eryn/registry/mcp/${encodeURIComponent(userId)}`);
	if (!response.ok) return [];
	const body = (await response.json().catch(() => ({}))) as { servers?: unknown };
	return Array.isArray(body.servers) ? (body.servers as McpServerRecord[]) : [];
}

/** Replace a user's servers. */
export async function writeMcpServers(env: Env, userId: string, servers: McpServerRecord[]): Promise<void> {
	const response = await registry(env).fetch(`https://eryn/registry/mcp/${encodeURIComponent(userId)}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ servers }),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `the registry refused the change (HTTP ${response.status})`);
	}
}
