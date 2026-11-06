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
 * The protocol work belongs to `@modelcontextprotocol/client`: discovery,
 * dynamic registration, PKCE, the authorization URL, and token exchange and
 * refresh all come from the official client library. This module only adapts
 * it to Eryn's split browser flow. A started sign-in is a `PendingMcpAuth`
 * record in the guild's object, and the `state` that returns from the browser
 * is a signed pointer to it, so the start request and the callback do not need
 * to share memory.
 */

import {
	AuthorizationServerMismatchError,
	type AuthorizationServerMetadata,
	discoverOAuthServerInfo,
	exchangeAuthorization,
	type FetchLike,
	InsecureTokenEndpointError,
	IssuerMismatchError,
	OAuthError,
	type OAuthClientInformationMixed,
	type OAuthClientMetadata,
	type OAuthTokens,
	refreshAuthorization,
	registerClient,
	RegistrationRejectedError,
	resolveClientMetadata,
	resourceUrlFromServerUrl,
	startAuthorization,
} from "@modelcontextprotocol/client";

import { describeError } from "../errors";
import { fetchWithRedirects, isSecureUrl } from "../http";

const DISCOVERY_TIMEOUT_MS = 10_000;

/** Everything the flow needs from a discovery result, before it is stored. */
export interface McpDiscovery {
	/** The authorization server that issued the metadata. */
	authorizationServerUrl: string;
	/** The full metadata, used immediately by registration and the authorization URL. */
	authorizationServerMetadata: AuthorizationServerMetadata;
	registrationEndpoint?: string;
	/** The RFC 8707 resource indicator to send. */
	resource: string;
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
 * otherwise the well-known locations from RFC 9728 are tried. A server that is
 * not OAuth-protected simply has no metadata, which is an error the caller
 * turns into "use a token instead".
 */
export async function discover(resourceUrl: string, resourceMetadataUrl?: string): Promise<McpDiscovery> {
	requireTransport(resourceUrl, "MCP server URL");
	const info = await discoverOAuthServerInfo(resourceUrl, {
		...(resourceMetadataUrl
			? { resourceMetadataUrl: requireTransport(resourceMetadataUrl, "resource metadata") }
			: {}),
		fetchFn,
	}).catch(fail);

	const metadata = info.authorizationServerMetadata;
	if (!metadata) throw new McpOAuthError("This server's authorization server metadata could not be read.");
	requireTransport(metadata.authorization_endpoint, "authorization endpoint");
	requireTransport(metadata.token_endpoint, "token endpoint");
	if (metadata.registration_endpoint) {
		requireTransport(metadata.registration_endpoint, "client registration");
	}

	return {
		authorizationServerUrl: info.authorizationServerUrl,
		authorizationServerMetadata: metadata,
		...(metadata.registration_endpoint ? { registrationEndpoint: metadata.registration_endpoint } : {}),
		resource: info.resourceMetadata?.resource ?? resourceUrlFromServerUrl(resourceUrl).href,
		scopesSupported: metadata.scopes_supported ?? info.resourceMetadata?.scopes_supported ?? [],
	};
}

export interface InitiateInput {
	discovery: McpDiscovery;
	redirectUri: string;
	state: string;
	scope?: string;
}

/**
 * Register this deployment as an OAuth client and build the authorization URL.
 *
 * The returned verifier and client credentials are the only OAuth state the
 * caller has to keep until the browser comes back.
 */
export async function initiate(
	input: InitiateInput,
): Promise<{ url: string; clientId: string; clientSecret?: string; codeVerifier: string }> {
	if (!input.discovery.registrationEndpoint) {
		throw new McpOAuthError(
			"This server does not support automatic client registration. Add it with a token instead.",
		);
	}
	requireTransport(input.discovery.registrationEndpoint, "client registration");

	const metadata = input.discovery.authorizationServerMetadata;
	const client = await registerClient(input.discovery.authorizationServerUrl, {
		metadata,
		clientMetadata: resolveClientMetadata({
			clientMetadata: clientMetadata(input.redirectUri, input.scope),
			redirectUrl: input.redirectUri,
		}),
		...(input.scope ? { scope: input.scope } : {}),
		fetchFn,
	}).catch(fail);

	const started = await startAuthorization(input.discovery.authorizationServerUrl, {
		metadata,
		clientInformation: client,
		redirectUrl: input.redirectUri,
		state: input.state,
		...(input.scope ? { scope: input.scope } : {}),
		resource: input.discovery.resource,
	}).catch(fail);

	return {
		url: started.authorizationUrl.toString(),
		clientId: client.client_id,
		...(client.client_secret ? { clientSecret: client.client_secret } : {}),
		codeVerifier: started.codeVerifier,
	};
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
	const { authorizationServerUrl, metadata } = tokenRequest(input.tokenEndpoint);
	const tokens = await exchangeAuthorization(authorizationServerUrl, {
		metadata,
		clientInformation: clientInformation(input.clientId, input.clientSecret),
		authorizationCode: input.code,
		codeVerifier: input.verifier,
		redirectUri: input.redirectUri,
		...(input.resource ? { resource: input.resource } : {}),
		fetchFn,
	}).catch(fail);
	return toTokens(tokens);
}

/** Get a fresh access token from a stored refresh token. */
export async function refreshTokens(input: {
	tokenEndpoint: string;
	clientId: string;
	clientSecret?: string;
	refreshToken: string;
	resource?: string;
}): Promise<McpTokens> {
	const { authorizationServerUrl, metadata } = tokenRequest(input.tokenEndpoint);
	const tokens = await refreshAuthorization(authorizationServerUrl, {
		metadata,
		clientInformation: clientInformation(input.clientId, input.clientSecret),
		refreshToken: input.refreshToken,
		...(input.resource ? { resource: input.resource } : {}),
		fetchFn,
	}).catch(fail);
	return toTokens(tokens);
}

function clientMetadata(redirectUri: string, scope?: string): OAuthClientMetadata {
	return {
		client_name: "Eryn",
		redirect_uris: [redirectUri],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
		...(scope ? { scope } : {}),
	};
}

function clientInformation(clientId: string, clientSecret?: string): OAuthClientInformationMixed {
	return {
		client_id: clientId,
		...(clientSecret ? { client_secret: clientSecret } : {}),
	};
}

/**
 * Rebuild the slice of authorization-server metadata a token request needs.
 *
 * The full metadata is only used while starting a sign-in. Exchange and refresh
 * happen in a later request, where the attempt record remembers the token
 * endpoint and nothing else. The SDK accepts a partial document as long as the
 * fields it reads are present.
 */
function tokenRequest(tokenEndpoint: string): {
	authorizationServerUrl: string;
	metadata: AuthorizationServerMetadata;
} {
	const endpoint = requireTransport(tokenEndpoint, "the token endpoint");
	return {
		authorizationServerUrl: endpoint.origin,
		metadata: {
			issuer: endpoint.origin,
			authorization_endpoint: endpoint.origin,
			token_endpoint: endpoint.href,
			response_types_supported: ["code"],
		},
	};
}

function toTokens(tokens: OAuthTokens): McpTokens {
	return {
		accessToken: tokens.access_token,
		...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
		...(tokens.expires_in !== undefined ? { expiresIn: tokens.expires_in } : {}),
		...(tokens.scope ? { scope: tokens.scope } : {}),
	};
}

/** Turn a library error into the one-line answer a Discord message can show. */
function fail(error: unknown): never {
	if (error instanceof McpOAuthError) throw error;
	if (error instanceof RegistrationRejectedError) {
		throw new McpOAuthError(
			"This server would not register Eryn as a client. Add it with a token instead.",
		);
	}
	if (error instanceof IssuerMismatchError) {
		throw new McpOAuthError("This server's authorization metadata names a different issuer.");
	}
	if (error instanceof AuthorizationServerMismatchError) {
		throw new McpOAuthError("The sign-in came back from a different authorization server.");
	}
	if (error instanceof InsecureTokenEndpointError) {
		throw new McpOAuthError("This server's token endpoint must use https.");
	}
	if (error instanceof OAuthError) {
		throw new McpOAuthError(`The sign-in server refused the request (${error.code}).`);
	}
	throw new McpOAuthError(describeError(error));
}

/**
 * A fetch that applies the deployment's redirect and transport rules.
 *
 * Every request the OAuth library makes — discovery, registration, token
 * exchange, refresh — goes through here, so an external server cannot redirect
 * the Worker somewhere it would not otherwise call.
 */
const fetchFn: FetchLike = async (input, init) => {
	const url = typeof input === "string" ? new URL(input) : input;
	return await fetchWithRedirects(url, {
		...init,
		signal: init?.signal ?? AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
	});
};

/** OAuth endpoints carry secrets, so only https is acceptable in production. */
function requireTransport(url: string, label: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new McpOAuthError(`The ${label} URL is not valid.`);
	}
	if (!isSecureUrl(parsed)) throw new McpOAuthError(`The ${label} must use https.`);
	return parsed;
}
