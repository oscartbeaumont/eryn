/**
 * Credentials for the MCP endpoints.
 *
 * Everything is a signed token rather than a row: the registered client, the
 * authorization code, and both tokens are HMAC-signed blobs under
 * `SESSION_SECRET`, so the authorization server stays stateless and there is
 * nothing to provision or expire.
 *
 * A token names the hosted server it was issued for (`mcp`, by slug). That is
 * what makes one origin safe: a request is routed by its subject to that user's
 * object, which serves only the server the token names.
 */

import { randomToken, sign, verify } from "../crypto";

/** The single scope the endpoint exposes. */
export const MCP_SCOPE = "mcp";
export const SUPPORTED_SCOPES: ReadonlyArray<string> = [MCP_SCOPE];

const ACCESS_TTL_MS = 60 * 60 * 1_000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
/** How long a guild token lasts, which is how long a guild link survives unrevoked. */
const GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const CODE_TTL_MS = 5 * 60 * 1_000;

export interface ClientRecord {
	typ: "client";
	name: string;
	redirectUris: string[];
	scope?: string;
}

export interface CodeRecord {
	typ: "code";
	clientId: string;
	redirectUri: string;
	challenge: string;
	scope: string;
	resource?: string;
	sub: string;
	/** The hosted server (slug) the code is for. */
	mcp: string;
	exp: number;
}

export interface TokenRecord {
	typ: "access" | "refresh";
	sub: string;
	scope: string[];
	clientId?: string;
	resource?: string;
	/** The hosted server (slug) the token is for. */
	mcp: string;
	/** Set on a guild link's token, and checked against the grant on every call. */
	guild?: string;
	exp: number;
}

export type ParsedToken = ClientRecord | CodeRecord | TokenRecord;

export function seal(payload: ParsedToken, secret: string): Promise<string> {
	return sign(payload, secret);
}

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
	input: { clientId: string; redirectUri: string; challenge: string; scope: string; resource?: string; sub: string; mcp: string },
	secret: string,
): Promise<string> {
	return seal({ typ: "code", ...input, exp: Date.now() + CODE_TTL_MS }, secret);
}

/** Issue an access/refresh pair for a subject and one hosted server. */
export async function mintTokens(
	input: { sub: string; scope: string[]; mcp: string; guild?: string; clientId?: string; resource?: string },
	secret: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number; scope: string }> {
	const now = Date.now();
	const base = {
		sub: input.sub,
		scope: input.scope,
		mcp: input.mcp,
		clientId: input.clientId,
		resource: input.resource,
		guild: input.guild,
	};
	const accessToken = await seal({ typ: "access", ...base, exp: now + ACCESS_TTL_MS }, secret);
	const refreshToken = await seal({ typ: "refresh", ...base, exp: now + REFRESH_TTL_MS }, secret);
	return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1_000), scope: input.scope.join(" ") };
}

/**
 * A long-lived token for a guild link.
 *
 * It is what the bot presents for a server an admin linked, so it lasts until
 * the link is revoked rather than an hour; revocation is enforced by the grant
 * record, not the token's lifetime.
 */
export async function mintGrantToken(input: { sub: string; mcp: string; guild: string }, secret: string): Promise<string> {
	return seal({ typ: "access", ...input, scope: [MCP_SCOPE], exp: Date.now() + GRANT_TTL_MS }, secret);
}

export function opaque(prefix: string): string {
	return `${prefix}_${randomToken(24)}`;
}
