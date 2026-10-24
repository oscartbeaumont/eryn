/**
 * The OAuth 2.1 authorization server that protects the MCP endpoints.
 *
 * A remote MCP client discovers this server from the `WWW-Authenticate` header a
 * `/mcp/<name>` request returns, then follows the standard chain:
 *
 *   /.well-known/oauth-protected-resource/mcp/<name> → names the authorization server
 *   /.well-known/oauth-authorization-server          → endpoints, DCR, PKCE
 *   POST /oauth/register                             → dynamic client registration
 *   GET  /console/authorize                          → user consent (the console SPA)
 *   POST /oauth/token                                → authorization_code / refresh_token
 *
 * The `resource` indicator names the exact hosted server, which is what binds a
 * token to one server rather than to the account.
 */

import { base64url } from "../crypto";
import { AUTHORIZE_PATH, MCP_PATH, MCP_SCOPE } from "../config";
import {
	SUPPORTED_SCOPES,
	mintClient,
	mintCode,
	mintTokens,
	open,
	type ClientRecord,
	type CodeRecord,
	type TokenRecord,
} from "./access";

export { MCP_PATH, AUTHORIZE_PATH } from "../config";

/** Where protected-resource metadata is published. */
export const PRM_PATHS = ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"] as const;
export const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const REGISTER_PATH = "/oauth/register";
export const TOKEN_PATH = "/oauth/token";

const encoder = new TextEncoder();

export class OAuthError extends Error {
	readonly code: string;
	readonly status: number;

	constructor(code: string, message: string, status = 400) {
		super(message);
		this.name = "OAuthError";
		this.code = code;
		this.status = status;
	}
}

/** The resource identifier for a hosted server, or the endpoint as a whole. */
export function resourceUrl(base: string, name?: string): string {
	return name ? `${base}${MCP_PATH}/${name}` : `${base}${MCP_PATH}`;
}

/** The metadata path a client discovers for one hosted server. */
export function protectedResourcePath(name: string): string {
	return `${PRM_PATHS[1]}/${name}`;
}

export function protectedResourceMetadata(base: string, name?: string): Record<string, unknown> {
	return {
		resource: resourceUrl(base, name),
		authorization_servers: [base],
		scopes_supported: SUPPORTED_SCOPES,
		bearer_methods_supported: ["header"],
		resource_name: name ? `Eryn MCP (${name})` : "Eryn MCP",
		resource_documentation: `${base}/console`,
	};
}

export function authorizationServerMetadata(base: string): Record<string, unknown> {
	return {
		issuer: base,
		authorization_endpoint: `${base}${AUTHORIZE_PATH}`,
		token_endpoint: `${base}${TOKEN_PATH}`,
		registration_endpoint: `${base}${REGISTER_PATH}`,
		scopes_supported: SUPPORTED_SCOPES,
		response_types_supported: ["code"],
		response_modes_supported: ["query"],
		grant_types_supported: ["authorization_code", "refresh_token"],
		token_endpoint_auth_methods_supported: ["none"],
		code_challenge_methods_supported: ["S256"],
		service_documentation: `${base}/console`,
	};
}

function isSafeRedirect(uri: string): boolean {
	let url: URL;
	try {
		url = new URL(uri);
	} catch {
		return false;
	}
	if (url.protocol === "https:") return true;
	// RFC 8252 §7.3: native apps use a loopback redirect over plain http.
	return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname);
}

function requireRedirectUris(value: unknown): string[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new OAuthError("invalid_redirect_uri", "At least one redirect_uri is required.");
	}
	const uris = value.map((entry) => String(entry));
	if (!uris.every(isSafeRedirect)) {
		throw new OAuthError("invalid_redirect_uri", "redirect_uris must be https, or http on a loopback address.");
	}
	return uris;
}

// --- Dynamic client registration (RFC 7591) ------------------------------------

export interface ClientResponse {
	client_id: string;
	client_name?: string;
	redirect_uris: string[];
	token_endpoint_auth_method: "none";
	grant_types: string[];
	response_types: string[];
	client_id_issued_at: number;
}

export async function registerClient(body: unknown, secret: string): Promise<ClientResponse> {
	const input = (body ?? {}) as Record<string, unknown>;
	const redirectUris = requireRedirectUris(input.redirect_uris);
	const name = typeof input.client_name === "string" && input.client_name.trim() ? input.client_name.trim() : "MCP client";
	const scope = typeof input.scope === "string" && input.scope.trim() ? input.scope.trim() : MCP_SCOPE;
	return {
		client_id: await mintClient({ name, redirectUris, scope }, secret),
		client_name: name,
		redirect_uris: redirectUris,
		token_endpoint_auth_method: "none",
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		client_id_issued_at: Math.floor(Date.now() / 1_000),
	};
}

// --- Authorization -------------------------------------------------------------

export interface AuthorizeParams {
	response_type: string;
	client_id: string;
	redirect_uri: string;
	state?: string;
	code_challenge: string;
	code_challenge_method: string;
	scope?: string;
	resource?: string;
}

export function readAuthorizeParams(params: URLSearchParams): AuthorizeParams {
	return {
		response_type: params.get("response_type") ?? "",
		client_id: params.get("client_id") ?? "",
		redirect_uri: params.get("redirect_uri") ?? "",
		state: params.get("state") ?? undefined,
		code_challenge: params.get("code_challenge") ?? "",
		code_challenge_method: params.get("code_challenge_method") ?? "",
		scope: params.get("scope") ?? undefined,
		resource: params.get("resource") ?? undefined,
	};
}

export interface ConsentRequest {
	clientId: string;
	client: ClientRecord;
	redirectUri: string;
	state?: string;
	scope: string;
	resource?: string;
	codeChallenge: string;
	/** The hosted server (slug) the client asked for. */
	mcp: string;
}

/** Pull the hosted server slug out of a `resource` indicator. */
export function serverFromResource(base: string, resource: string | undefined): string | undefined {
	if (!resource) return undefined;
	const prefix = `${base}${MCP_PATH}/`;
	if (!resource.startsWith(prefix)) return undefined;
	const name = resource.slice(prefix.length).replace(/\/+$/, "");
	return name && !name.includes("/") ? decodeURIComponent(name) : undefined;
}

export async function inspectAuthorization(base: string, params: AuthorizeParams, secret: string): Promise<ConsentRequest> {
	if (params.response_type !== "code") {
		throw new OAuthError("unsupported_response_type", "Only the authorization_code flow is supported.");
	}
	if (params.code_challenge_method !== "S256") {
		throw new OAuthError("invalid_request", "PKCE with the S256 code_challenge_method is required.");
	}
	if (!params.code_challenge) throw new OAuthError("invalid_request", "A code_challenge is required.");
	const client = await open<ClientRecord>(params.client_id, secret);
	if (!client || client.typ !== "client") throw new OAuthError("invalid_client", "Unknown client_id.");
	if (!params.redirect_uri || !client.redirectUris.includes(params.redirect_uri)) {
		throw new OAuthError("invalid_redirect_uri", "redirect_uri was not registered for this client.");
	}
	const mcp = serverFromResource(base, params.resource);
	if (!mcp) {
		throw new OAuthError(
			"invalid_target",
			`Name the server with resource="${base}${MCP_PATH}/<name>", the resource this endpoint protects.`,
		);
	}
	const requested = (params.scope?.trim() || client.scope || MCP_SCOPE).split(/\s+/).filter(Boolean);
	const scope = requested.filter((value) => SUPPORTED_SCOPES.includes(value));
	if (scope.length === 0) {
		throw new OAuthError("invalid_scope", `Requested scope must be one of: ${SUPPORTED_SCOPES.join(", ")}.`);
	}
	return {
		clientId: params.client_id,
		client,
		redirectUri: params.redirect_uri,
		state: params.state,
		scope: scope.join(" "),
		resource: params.resource,
		codeChallenge: params.code_challenge,
		mcp,
	};
}

export async function approveAuthorization(
	consent: ConsentRequest,
	subject: string,
	secret: string,
): Promise<{ code: string; redirect: string }> {
	const code = await mintCode(
		{
			clientId: consent.clientId,
			redirectUri: consent.redirectUri,
			challenge: consent.codeChallenge,
			scope: consent.scope,
			resource: consent.resource,
			sub: subject,
			mcp: consent.mcp,
		},
		secret,
	);
	return { code, redirect: redirectWith(consent.redirectUri, { code, state: consent.state }) };
}

export function denyAuthorization(consent: ConsentRequest): string {
	return redirectWith(consent.redirectUri, { error: "access_denied", state: consent.state });
}

function redirectWith(uri: string, params: Record<string, string | undefined>): string {
	const url = new URL(uri);
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) url.searchParams.set(key, value);
	}
	return url.toString();
}

// --- Token endpoint ------------------------------------------------------------

export interface TokenResponse {
	access_token: string;
	token_type: "Bearer";
	expires_in: number;
	refresh_token: string;
	scope: string;
}

async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
	if (!verifier || verifier.length < 43 || verifier.length > 128) return false;
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
	return base64url(new Uint8Array(digest)) === challenge;
}

export async function exchangeAuthorizationCode(base: string, form: URLSearchParams, secret: string): Promise<TokenResponse> {
	const code = form.get("code");
	const verifier = form.get("code_verifier") ?? "";
	const redirectUri = form.get("redirect_uri") ?? "";
	const clientId = form.get("client_id") ?? "";
	const record = await open<CodeRecord>(code ?? undefined, secret);
	if (!record || record.typ !== "code") throw new OAuthError("invalid_grant", "That authorization code is not valid.");
	if (record.exp < Date.now()) throw new OAuthError("invalid_grant", "That authorization code has expired.");
	if (record.clientId !== clientId) throw new OAuthError("invalid_grant", "The code was issued to a different client.");
	if (record.redirectUri !== redirectUri) throw new OAuthError("invalid_grant", "redirect_uri does not match the code.");
	if (!(await pkceMatches(verifier, record.challenge))) {
		throw new OAuthError("invalid_grant", "The PKCE code_verifier did not match.");
	}
	if (record.resource && record.resource !== resourceUrl(base, record.mcp)) {
		throw new OAuthError("invalid_target", "The code was issued for a different resource.");
	}
	const scope = record.scope.split(/\s+/).filter(Boolean);
	const tokens = await mintTokens(
		{ sub: record.sub, mcp: record.mcp, scope: scope.length ? scope : [MCP_SCOPE], clientId, resource: record.resource },
		secret,
	);
	return {
		access_token: tokens.accessToken,
		token_type: "Bearer",
		expires_in: tokens.expiresIn,
		refresh_token: tokens.refreshToken,
		scope: tokens.scope,
	};
}

export async function exchangeRefreshToken(base: string, form: URLSearchParams, secret: string): Promise<TokenResponse> {
	const clientId = form.get("client_id") ?? "";
	const record = await open<TokenRecord>(form.get("refresh_token") ?? undefined, secret);
	if (!record || record.typ !== "refresh") throw new OAuthError("invalid_grant", "That refresh token is not valid.");
	if (record.exp < Date.now()) throw new OAuthError("invalid_grant", "That refresh token has expired.");
	if (record.clientId !== undefined && record.clientId !== clientId) {
		throw new OAuthError("invalid_grant", "The token was issued to a different client.");
	}
	if (record.resource && record.resource !== resourceUrl(base, record.mcp)) {
		throw new OAuthError("invalid_target", "The token was issued for a different resource.");
	}
	const tokens = await mintTokens(
		{ sub: record.sub, mcp: record.mcp, scope: record.scope, clientId: record.clientId, resource: record.resource },
		secret,
	);
	return {
		access_token: tokens.accessToken,
		token_type: "Bearer",
		expires_in: tokens.expiresIn,
		refresh_token: tokens.refreshToken,
		scope: tokens.scope,
	};
}

// --- Bearer authentication -----------------------------------------------------

export function bearerToken(request: Request): string | undefined {
	const header = request.headers.get("authorization");
	if (!header) return undefined;
	const [scheme, value] = header.split(" ");
	return scheme?.toLowerCase() === "bearer" && value ? value : undefined;
}

export async function verifyAccessToken(token: string | undefined, secret: string): Promise<TokenRecord | undefined> {
	const record = await open<TokenRecord>(token, secret);
	if (!record || record.typ !== "access") return undefined;
	if (record.exp < Date.now()) return undefined;
	return record;
}

/** The `WWW-Authenticate` challenge that starts discovery, per hosted server. */
export function challenge(base: string, name: string | undefined, error?: string): string {
	const metadata = name ? `${base}${protectedResourcePath(name)}` : `${base}${PRM_PATHS[0]}`;
	const params = [`resource_metadata="${metadata}"`, `scope="${MCP_SCOPE}"`];
	if (error) params.unshift(`error="${error}"`);
	return `Bearer ${params.join(", ")}`;
}

/** Origins allowed to call an endpoint from a browser. */
export function allowedOrigins(origin: string | undefined): string[] {
	const configured = origin?.trim().replace(/\/$/, "");
	return configured ? [configured] : [];
}
