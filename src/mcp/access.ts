/**
 * Credentials for the Eryn MCP server.
 *
 * Everything the MCP needs to identify a caller is a signed token rather than a
 * row in a database: the registered client, the authorization code, the access
 * token, and the refresh token are all HMAC-signed blobs (`sign`/`verify`) under
 * the worker's `SESSION_SECRET`. That keeps the authorization server stateless,
 * so there is no store to provision and no cleanup to run.
 *
 * Two kinds of caller end up with the same access token shape:
 *
 * - **External harnesses** (OpenCode, Claude, Cursor, …) run the OAuth 2.1
 *   authorization-code + PKCE flow and receive tokens minted at `/oauth/token`.
 * - **Eryn's own cloud sessions** mint a token locally with `mintInternalToken`
 *   and pass it as a bearer header, so the agent can use the MCP with no setup.
 */

import { randomToken, sign, verify } from "../crypto";

/** The single scope the MCP currently exposes. Discord/GitHub will add their own. */
export const MCP_SCOPE = "mcp";

/**
 * Scopes the authorization server can grant. Today there is one global scope;
 * when the Discord and GitHub tools land, their scopes are added here and to
 * the consent screen, which is the only place a scope becomes meaningful.
 */
export const SUPPORTED_SCOPES: ReadonlyArray<string> = [MCP_SCOPE];

const ACCESS_TTL_MS = 60 * 60 * 1_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const CODE_TTL_MS = 5 * 60 * 1_000;

/** A dynamically registered OAuth client, carried by its own `client_id`. */
export interface ClientRecord {
	typ: "client";
	name: string;
	redirectUris: string[];
	scope?: string;
}

/** A one-time authorization code bound to the PKCE challenge that requested it. */
export interface CodeRecord {
	typ: "code";
	clientId: string;
	redirectUri: string;
	challenge: string;
	scope: string;
	resource?: string;
	sub: string;
	exp: number;
}

/** An issued access or refresh token. */
export interface TokenRecord {
	typ: "access" | "refresh";
	sub: string;
	scope: string[];
	clientId?: string;
	resource?: string;
	exp: number;
}

export type ParsedToken = ClientRecord | CodeRecord | TokenRecord;

/** Sign a payload into a URL-safe token with the worker's session secret. */
export function seal(payload: ParsedToken, secret: string): Promise<string> {
	return sign(payload, secret);
}

/** The verified payload of a signed token, or `undefined` when invalid. */
export async function open<T extends ParsedToken>(token: string | undefined, secret: string): Promise<T | undefined> {
	return await verify<T>(token, secret);
}

export function accessTtlMs(): number {
	return ACCESS_TTL_MS;
}

export function mintClient(input: { name: string; redirectUris: string[]; scope?: string }, secret: string): Promise<string> {
	return seal({ typ: "client", name: input.name, redirectUris: input.redirectUris, scope: input.scope }, secret);
}

export function mintCode(
	input: { clientId: string; redirectUri: string; challenge: string; scope: string; resource?: string; sub: string },
	secret: string,
): Promise<string> {
	return seal({ typ: "code", ...input, exp: Date.now() + CODE_TTL_MS }, secret);
}

/** Issue an access/refresh pair for a subject. */
export async function mintTokens(
	input: { sub: string; scope: string[]; clientId?: string; resource?: string },
	secret: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
	const now = Date.now();
	const base = { sub: input.sub, scope: input.scope, clientId: input.clientId, resource: input.resource };
	const accessToken = await seal({ typ: "access", ...base, exp: now + ACCESS_TTL_MS }, secret);
	const refreshToken = await seal({ typ: "refresh", ...base, exp: now + REFRESH_TTL_MS }, secret);
	return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1_000), scope: input.scope.join(" ") };
}

/**
 * A token Eryn's own sessions use, so the agent's MCP needs no OAuth round trip.
 *
 * The subject is the Discord user the turn acts for — the guild's owner — which
 * is what routes the call to that user's own MCP gateway.
 */
export function mintInternalToken(secret: string, subject: string): Promise<string> {
	return seal({ typ: "access", sub: subject, scope: [MCP_SCOPE], exp: Date.now() + REFRESH_TTL_MS }, secret);
}

/** A fresh, unguessable value for places that just need entropy (e.g. client ids). */
export function opaque(prefix: string): string {
	return `${prefix}_${randomToken(24)}`;
}
