/**
 * An MCP OAuth client.
 *
 * The MCP authorization spec is OAuth 2.1 with three additions: the server
 * publishes protected-resource metadata naming its authorization server, the
 * client registers itself dynamically, and the request carries a `resource`
 * indicator. Eryn implements all three because it has to: OpenCode's own MCP
 * client receives the callback on a `127.0.0.1` listener, and a Worker has no
 * inbound sockets, so the browser round trip belongs here and the agent is
 * handed a bearer token afterwards.
 *
 * Tokens are the caller's to store; nothing in this module persists anything.
 */

import { McpError, McpUnauthorized } from "./client";

/** Where to send a user to authorize, and where to exchange the result. */
export interface McpAuthorization {
	/** The authorization server's issuer, for display. */
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint?: string;
	scopesSupported?: string[];
	/** The resource indicator to send, which binds the token to this server. */
	resource: string;
}

/** What a token endpoint hands back. */
export interface McpTokens {
	accessToken: string;
	refreshToken?: string;
	/** Absolute time, so an expiry needs no clock arithmetic at the call site. */
	expiresAt?: number;
	scope?: string;
}

/** What a dynamically registered client looks like. */
export interface McpClientRegistration {
	clientId: string;
	clientSecret?: string;
}

const DISCOVERY_TIMEOUT_MS = 15_000;

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** A fresh PKCE verifier and the challenge derived from it. */
async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** An unguessable state value, which is what binds the callback to this attempt. */
export function newState(): string {
	return base64url(crypto.getRandomValues(new Uint8Array(24)));
}

/**
 * The well-known locations to try for a metadata document.
 *
 * RFC 8414 and RFC 9728 disagree about where the path goes, and servers in the
 * wild follow both, so every arrangement is attempted in the order the spec
 * prefers: the path-suffixed form first, then the bare one.
 */
function wellKnownCandidates(issuer: string, document: string): string[] {
	const url = new URL(issuer);
	const path = url.pathname.replace(/\/$/, "");
	const base = `${url.origin}/.well-known/${document}`;
	const candidates = path ? [`${base}${path}`, base, `${url.origin}${path}/.well-known/${document}`] : [base];
	return [...new Set(candidates)];
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown> | undefined> {
	const response = await fetch(url, {
		...init,
		headers: { accept: "application/json", ...(init?.headers ?? {}) },
		signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	}).catch(() => undefined);
	if (!response?.ok) return undefined;
	return (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined;
}

async function firstJson(urls: string[]): Promise<Record<string, unknown> | undefined> {
	for (const url of urls) {
		const found = await fetchJson(url);
		if (found) return found;
	}
	return undefined;
}

/** The `resource_metadata` a 401 points at, when it names one. */
function metadataFromChallenge(challenge: string | undefined): string | undefined {
	if (!challenge) return undefined;
	const match = /resource_metadata="([^"]+)"/i.exec(challenge);
	return match?.[1];
}

/**
 * Find out how to authorize against an MCP server.
 *
 * The server's protected-resource metadata names its authorization server; the
 * authorization server's own metadata names the endpoints. A server that
 * publishes neither is one we cannot sign in to, and saying so is better than
 * sending the user somewhere that will not work.
 */
export async function discover(url: string, options: { token?: string; challenge?: string } = {}): Promise<McpAuthorization> {
	// Ask the server itself first: a 401 carries the metadata URL, and a
	// successful call means there is nothing to authorize at all.
	let challenge = options.challenge;
	if (!challenge) {
		const probe = await fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
			},
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "eryn", version: "1.0.0" } } }),
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
		}).catch(() => undefined);
		if (probe && probe.status !== 401 && probe.status !== 403) {
			throw new McpError("that server does not ask for a sign-in");
		}
		challenge = probe?.headers.get("www-authenticate") ?? undefined;
	}

	const explicit = metadataFromChallenge(challenge);
	const resourceMetadata = explicit
		? await fetchJson(explicit)
		: await firstJson(wellKnownCandidates(url, "oauth-protected-resource"));

	const servers = resourceMetadata?.authorization_servers;
	const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : new URL(url).origin;

	const serverMetadata = await firstJson([
		...wellKnownCandidates(issuer, "oauth-authorization-server"),
		...wellKnownCandidates(issuer, "openid-configuration"),
	]);
	const authorizationEndpoint = serverMetadata?.authorization_endpoint;
	const tokenEndpoint = serverMetadata?.token_endpoint;
	if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string") {
		throw new McpError(`could not find an authorization server for ${url}`);
	}

	return {
		issuer,
		authorizationEndpoint,
		tokenEndpoint,
		...(typeof serverMetadata?.registration_endpoint === "string"
			? { registrationEndpoint: serverMetadata.registration_endpoint }
			: {}),
		...(Array.isArray(serverMetadata?.scopes_supported)
			? { scopesSupported: serverMetadata.scopes_supported.filter((scope): scope is string => typeof scope === "string") }
			: {}),
		resource: typeof resourceMetadata?.resource === "string" ? resourceMetadata.resource : url,
	};
}

/** Register this deployment as a client, which is how a server learns our callback. */
export async function registerClient(
	authorization: McpAuthorization,
	redirectUri: string,
): Promise<McpClientRegistration> {
	if (!authorization.registrationEndpoint) {
		throw new McpError("that server does not allow clients to register themselves");
	}
	const body = await fetchJson(authorization.registrationEndpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			client_name: "Eryn",
			redirect_uris: [redirectUri],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		}),
	});
	const clientId = body?.client_id;
	if (typeof clientId !== "string" || !clientId) throw new McpError("that server did not register a client");
	return { clientId, ...(typeof body?.client_secret === "string" ? { clientSecret: body.client_secret } : {}) };
}

/** Where to send the browser, and the verifier the callback will need. */
export async function beginAuthorization(input: {
	authorization: McpAuthorization;
	clientId: string;
	redirectUri: string;
	state: string;
	scope?: string;
}): Promise<{ url: string; verifier: string }> {
	const { verifier, challenge } = await pkce();
	const url = new URL(input.authorization.authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", input.clientId);
	url.searchParams.set("redirect_uri", input.redirectUri);
	url.searchParams.set("state", input.state);
	url.searchParams.set("code_challenge", challenge);
	url.searchParams.set("code_challenge_method", "S256");
	// The resource indicator is what binds the token to this one MCP server.
	url.searchParams.set("resource", input.authorization.resource);
	if (input.scope) url.searchParams.set("scope", input.scope);
	return { url: url.toString(), verifier };
}

/** Turn an authorization code into tokens. */
export async function exchangeCode(input: {
	authorization: McpAuthorization;
	client: McpClientRegistration;
	code: string;
	verifier: string;
	redirectUri: string;
}): Promise<McpTokens> {
	return await tokenRequest(input.authorization, {
		grant_type: "authorization_code",
		code: input.code,
		code_verifier: input.verifier,
		redirect_uri: input.redirectUri,
		client_id: input.client.clientId,
		...(input.client.clientSecret ? { client_secret: input.client.clientSecret } : {}),
		resource: input.authorization.resource,
	});
}

/** Exchange a refresh token for a new access token. */
export async function refreshTokens(input: {
	authorization: McpAuthorization;
	client: McpClientRegistration;
	refreshToken: string;
}): Promise<McpTokens> {
	return await tokenRequest(input.authorization, {
		grant_type: "refresh_token",
		refresh_token: input.refreshToken,
		client_id: input.client.clientId,
		...(input.client.clientSecret ? { client_secret: input.client.clientSecret } : {}),
		resource: input.authorization.resource,
	});
}

async function tokenRequest(authorization: McpAuthorization, params: Record<string, string>): Promise<McpTokens> {
	const response = await fetch(authorization.tokenEndpoint, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
		body: new URLSearchParams(params).toString(),
		signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	}).catch((error) => {
		throw new McpError(`the token endpoint could not be reached: ${error instanceof Error ? error.message : String(error)}`);
	});
	const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
	if (!response.ok || typeof body.access_token !== "string") {
		const detail = typeof body.error_description === "string" ? body.error_description : body.error;
		throw new McpError(`the token endpoint refused the request${typeof detail === "string" ? `: ${detail}` : ""}`);
	}
	const expiresIn = typeof body.expires_in === "number" ? body.expires_in : undefined;
	return {
		accessToken: body.access_token,
		...(typeof body.refresh_token === "string" ? { refreshToken: body.refresh_token } : {}),
		...(expiresIn ? { expiresAt: Date.now() + expiresIn * 1_000 } : {}),
		...(typeof body.scope === "string" ? { scope: body.scope } : {}),
	};
}

export { McpError, McpUnauthorized };
