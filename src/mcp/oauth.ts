/**
 * The OAuth client half of "add an external MCP server".
 *
 * MCP servers that need authorization advertise it the way RFC 9728 says: a
 * `401` with a `WWW-Authenticate` header naming protected-resource metadata.
 * From there the flow is ordinary OAuth 2.1 — discover the authorization
 * server, register ourselves dynamically (RFC 7591), send the user to the
 * authorization endpoint with PKCE, and exchange the code that comes back to
 * our own callback.
 *
 * Nothing here holds state: a started sign-in is a `PendingMcpAuth` record in
 * the guild's object, and the `state` that returns from the browser is a signed
 * pointer to it.
 */

import { Option, Schema } from "effect";

import { base64url, randomToken } from "../crypto";
import { describeError } from "../errors";
import { fetchWithRedirects } from "../http";

const DISCOVERY_TIMEOUT_MS = 10_000;

const ProtectedResourceSchema = Schema.Struct({
	resource: Schema.optional(Schema.String),
	authorization_servers: Schema.Array(Schema.String),
	scopes_supported: Schema.optional(Schema.Array(Schema.String)),
});

const AuthorizationServerSchema = Schema.Struct({
	issuer: Schema.optional(Schema.String),
	authorization_endpoint: Schema.String,
	token_endpoint: Schema.String,
	registration_endpoint: Schema.optional(Schema.String),
	scopes_supported: Schema.optional(Schema.Array(Schema.String)),
	code_challenge_methods_supported: Schema.optional(Schema.Array(Schema.String)),
});

const RegistrationSchema = Schema.Struct({
	client_id: Schema.String,
	client_secret: Schema.optional(Schema.String),
});

const TokenSchema = Schema.Struct({
	access_token: Schema.String,
	token_type: Schema.optional(Schema.String),
	expires_in: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
	refresh_token: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.String),
});

const ErrorSchema = Schema.Struct({
	error: Schema.optional(Schema.String),
	error_description: Schema.optional(Schema.String),
});

/** Everything the flow needs from one authorization server. */
export interface McpDiscovery {
	/** The resource indicator to send (RFC 8707). */
	resource: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint?: string;
	scopesSupported: readonly string[];
}

export interface McpTokens {
	accessToken: string;
	refreshToken?: string;
	expiresIn?: number;
	scope?: string;
}

export class McpOAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpOAuthError";
	}
}

/**
 * Find the authorization server behind an MCP server.
 *
 * `resourceMetadataUrl` comes from the server's own challenge when it gave one;
 * otherwise the well-known locations from RFC 9728 are tried in order. A server
 * that is not OAuth-protected simply has no metadata, which is an error the
 * caller turns into "use a token instead".
 */
export async function discover(resourceUrl: string, resourceMetadataUrl?: string): Promise<McpDiscovery> {
	const resource = new URL(resourceUrl);
	resource.hash = "";
	const metadataUrl = resourceMetadataUrl ?? (await findResourceMetadata(resource));
	if (!metadataUrl) throw new McpOAuthError("This server did not publish OAuth metadata.");

	const protectedResource = decode(
		ProtectedResourceSchema,
		await fetchJson(metadataUrl, "the protected resource metadata"),
	);
	if (!protectedResource) throw new McpOAuthError("This server's OAuth metadata could not be read.");
	const issuer = protectedResource.authorization_servers[0];
	if (!issuer) throw new McpOAuthError("This server names no authorization server.");

	const metadata = await findAuthorizationServer(issuer);
	const challenges = metadata.code_challenge_methods_supported;
	if (challenges && !challenges.includes("S256")) {
		throw new McpOAuthError("This server's authorization server does not support PKCE with S256.");
	}
	requireTransport(metadata.authorization_endpoint, "authorization endpoint");
	requireTransport(metadata.token_endpoint, "token endpoint");

	return {
		resource: protectedResource.resource ?? resource.toString(),
		authorizationEndpoint: metadata.authorization_endpoint,
		tokenEndpoint: metadata.token_endpoint,
		...(metadata.registration_endpoint ? { registrationEndpoint: metadata.registration_endpoint } : {}),
		scopesSupported: metadata.scopes_supported ?? protectedResource.scopes_supported ?? [],
	};
}

/** Register this deployment as an OAuth client, when the server allows it. */
export async function registerClient(input: {
	registrationEndpoint: string;
	redirectUri: string;
	scope?: string;
}): Promise<{ clientId: string; clientSecret?: string }> {
	const body: Record<string, unknown> = {
		client_name: "Eryn",
		redirect_uris: [input.redirectUri],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		...(input.scope ? { scope: input.scope } : {}),
	};
	const response = await fetchWithRedirects(requireTransport(input.registrationEndpoint, "client registration"), {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	});
	const payload = (await response.json().catch(() => undefined)) as unknown;
	if (!response.ok) {
		const code = decode(ErrorSchema, payload)?.error;
		throw new McpOAuthError(
			`This server would not register Eryn as a client${code ? ` (${code})` : ""}. Add it with a token instead.`,
		);
	}
	const registration = decode(RegistrationSchema, payload);
	if (!registration) throw new McpOAuthError("This server's client registration response could not be read.");
	return {
		clientId: registration.client_id,
		...(registration.client_secret ? { clientSecret: registration.client_secret } : {}),
	};
}

/** A PKCE verifier and its S256 challenge. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = randomToken(32);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** The URL the user is sent to, with PKCE and the resource indicator applied. */
export function authorizationUrl(
	discovery: McpDiscovery,
	input: { clientId: string; redirectUri: string; state: string; challenge: string; scope?: string },
): string {
	const url = new URL(discovery.authorizationEndpoint);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", input.clientId);
	url.searchParams.set("redirect_uri", input.redirectUri);
	url.searchParams.set("state", input.state);
	url.searchParams.set("code_challenge", input.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("resource", discovery.resource);
	if (input.scope) url.searchParams.set("scope", input.scope);
	return url.toString();
}

/** Exchange the code the browser brought back for a token pair. */
export async function exchangeCode(input: {
	tokenEndpoint: string;
	resource?: string;
	clientId: string;
	clientSecret?: string;
	redirectUri: string;
	code: string;
	verifier: string;
}): Promise<McpTokens> {
	return await tokenRequest(
		input.tokenEndpoint,
		{
			grant_type: "authorization_code",
			code: input.code,
			redirect_uri: input.redirectUri,
			code_verifier: input.verifier,
			...(input.resource ? { resource: input.resource } : {}),
		},
		{ clientId: input.clientId, clientSecret: input.clientSecret },
	);
}

/** Get a fresh access token from a stored refresh token. */
export async function refreshTokens(input: {
	tokenEndpoint: string;
	clientId: string;
	clientSecret?: string;
	refreshToken: string;
	resource?: string;
}): Promise<McpTokens> {
	return await tokenRequest(
		input.tokenEndpoint,
		{
			grant_type: "refresh_token",
			refresh_token: input.refreshToken,
			...(input.resource ? { resource: input.resource } : {}),
		},
		{ clientId: input.clientId, clientSecret: input.clientSecret },
	);
}

async function tokenRequest(
	endpoint: string,
	fields: Record<string, string>,
	client: { clientId: string; clientSecret?: string },
): Promise<McpTokens> {
	const body = new URLSearchParams(fields);
	const headers: Record<string, string> = {
		"content-type": "application/x-www-form-urlencoded",
		accept: "application/json",
	};
	if (client.clientSecret) {
		headers.authorization = `Basic ${btoa(`${client.clientId}:${client.clientSecret}`)}`;
	} else {
		body.set("client_id", client.clientId);
	}

	const response = await fetchWithRedirects(requireTransport(endpoint, "the token endpoint"), {
		method: "POST",
		headers,
		body,
		signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	});
	const payload = (await response.json().catch(() => undefined)) as unknown;
	if (!response.ok) {
		const code = decode(ErrorSchema, payload)?.error;
		throw new McpOAuthError(`The sign-in server refused the request${code ? ` (${code})` : ""}.`);
	}
	const tokens = decode(TokenSchema, payload);
	if (!tokens) throw new McpOAuthError("The sign-in server's token response could not be read.");
	return {
		accessToken: tokens.access_token,
		...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
		...(tokens.expires_in !== undefined ? { expiresIn: normaliseSeconds(tokens.expires_in) } : {}),
		...(tokens.scope ? { scope: tokens.scope } : {}),
	};
}

function normaliseSeconds(value: number | string): number {
	const seconds = typeof value === "number" ? value : Number.parseFloat(value);
	return Number.isFinite(seconds) ? seconds : 3_600;
}

/**
 * Try the well-known locations for a resource's metadata.
 *
 * RFC 9728 puts the path after the well-known segment; some servers publish it
 * at the root instead, and a few append it to the resource path. Trying all
 * three costs one request each and makes the flow work with all of them.
 */
async function findResourceMetadata(resource: URL): Promise<string | undefined> {
	const path = resource.pathname.replace(/\/+$/, "");
	const candidates = [
		`${resource.origin}/.well-known/oauth-protected-resource${path}`,
		`${resource.origin}/.well-known/oauth-protected-resource`,
		`${resource.origin}${path}/.well-known/oauth-protected-resource`,
	];
	return await firstJson(candidates);
}

async function findAuthorizationServer(issuer: string): Promise<Schema.Schema.Type<typeof AuthorizationServerSchema>> {
	const base = new URL(issuer);
	const path = base.pathname.replace(/\/+$/, "");
	const candidates = [
		`${base.origin}/.well-known/oauth-authorization-server${path}`,
		`${base.origin}/.well-known/openid-configuration${path}`,
		`${base.origin}${path}/.well-known/openid-configuration`,
	];
	for (const candidate of candidates) {
		const payload = await fetchJson(candidate, undefined, true);
		const metadata = decode(AuthorizationServerSchema, payload);
		if (!metadata) continue;
		// RFC 8414 §3.3: metadata served from one issuer must not name another,
		// which is what stops a redirect from swapping the token endpoint.
		if (metadata.issuer && trimSlash(metadata.issuer) !== trimSlash(issuer)) {
			throw new McpOAuthError("This server's authorization metadata names a different issuer.");
		}
		return metadata;
	}
	throw new McpOAuthError("This server's authorization server metadata could not be read.");
}

function trimSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

/** The first candidate URL that answers with JSON. */
async function firstJson(candidates: readonly string[]): Promise<string | undefined> {
	for (const candidate of candidates) {
		if ((await fetchJson(candidate, undefined, true)) !== undefined) return candidate;
	}
	return undefined;
}

async function fetchJson(url: string, label: string | undefined, optional = false): Promise<unknown> {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		if (optional) return undefined;
		throw new McpOAuthError(`The ${label ?? "metadata"} URL is not valid.`);
	}
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
		if (optional) return undefined;
		throw new McpOAuthError(`The ${label ?? "metadata"} URL must use https.`);
	}
	try {
		const response = await fetchWithRedirects(parsed, {
			headers: { accept: "application/json" },
			signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			if (optional) return undefined;
			throw new McpOAuthError(`The ${label ?? "metadata"} request answered HTTP ${response.status}.`);
		}
		return (await response.json().catch(() => undefined)) as unknown;
	} catch (error) {
		if (optional) return undefined;
		if (error instanceof McpOAuthError) throw error;
		throw new McpOAuthError(`Could not read the ${label ?? "metadata"}: ${describeError(error)}`);
	}
}

function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S["Type"] | undefined {
	if (input === undefined) return undefined;
	const parsed = Schema.decodeUnknownOption(schema)(input);
	return Option.isSome(parsed) ? parsed.value : undefined;
}

/** OAuth endpoints carry secrets, so only https is acceptable in production. */
function requireTransport(url: string, label: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new McpOAuthError(`The ${label} URL is not valid.`);
	}
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
		throw new McpOAuthError(`The ${label} must use https.`);
	}
	return parsed;
}

/** Loopback is allowed over http so a local server can be tried in development. */
function isLoopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}
