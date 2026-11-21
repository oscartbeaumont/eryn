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

import { AuthorizationServerMismatchError, discoverOAuthServerInfo, exchangeAuthorization, InsecureTokenEndpointError, IssuerMismatchError, OAuthError, refreshAuthorization, registerClient, RegistrationRejectedError, resolveClientMetadata, resourceUrlFromServerUrl, startAuthorization } from '@modelcontextprotocol/client';
import type { AuthorizationServerMetadata, FetchLike, OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/client';

import { describeError } from "../errors";
import { externalFetch, isSecureUrl } from "../http";

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

	const info = await discoverOAuthServerInfo(resourceUrl, discoveryOptions(resourceMetadataUrl)).catch(fail);

	const metadata = info.authorizationServerMetadata;

	if (!metadata) throw new McpOAuthError("This server's authorization server metadata could not be read.");
	requireTransport(metadata.authorization_endpoint, "authorization endpoint");
	requireTransport(metadata.token_endpoint, "token endpoint");

	if (metadata.registration_endpoint) {
		requireTransport(metadata.registration_endpoint, "client registration");
	}

	const result: McpDiscovery = {
		authorizationServerUrl: info.authorizationServerUrl,
		authorizationServerMetadata: metadata,
		resource: info.resourceMetadata?.resource ?? resourceUrlFromServerUrl(resourceUrl).href,
		scopesSupported: metadata.scopes_supported ?? info.resourceMetadata?.scopes_supported ?? [],
	};

	if (metadata.registration_endpoint) result.registrationEndpoint = metadata.registration_endpoint;

	return result;
}

/** Discovery takes an optional metadata URL only when the server's challenge gave one. */
function discoveryOptions(
	resourceMetadataUrl: string | undefined,
): NonNullable<Parameters<typeof discoverOAuthServerInfo>[1]> {
	const options: NonNullable<Parameters<typeof discoverOAuthServerInfo>[1]> = { fetchFn };

	if (resourceMetadataUrl) {
		options.resourceMetadataUrl = requireTransport(resourceMetadataUrl, "resource metadata");
	}

	return options;
}

export interface InitiateInput {
	discovery: McpDiscovery;
	redirectUri: string;
	state: string;
	scope?: string;
}

/** What the caller keeps from a started sign-in until the browser returns. */
export interface InitiatedAuthorization {
	url: string;
	clientId: string;
	clientSecret?: string;
	codeVerifier: string;
}

/**
 * Register this deployment as an OAuth client and build the authorization URL.
 *
 * The returned verifier and client credentials are the only OAuth state the
 * caller has to keep until the browser comes back.
 */
export async function initiate(input: InitiateInput): Promise<InitiatedAuthorization> {
	if (!input.discovery.registrationEndpoint) {
		throw new McpOAuthError(
			"This server does not support automatic client registration. Add it with a token instead.",
		);
	}

	requireTransport(input.discovery.registrationEndpoint, "client registration");

	const metadata = input.discovery.authorizationServerMetadata;

	const registration: NonNullable<Parameters<typeof registerClient>[1]> = {
		metadata,
		clientMetadata: resolveClientMetadata({
			clientMetadata: clientMetadata(input.redirectUri, input.scope),
			redirectUrl: input.redirectUri,
		}),
		fetchFn,
	};

	if (input.scope) registration.scope = input.scope;

	const client = await registerClient(input.discovery.authorizationServerUrl, registration).catch(fail);

	const authorization: NonNullable<Parameters<typeof startAuthorization>[1]> = {
		metadata,
		clientInformation: client,
		redirectUrl: input.redirectUri,
		state: input.state,
		resource: input.discovery.resource,
	};

	if (input.scope) authorization.scope = input.scope;

	const started = await startAuthorization(input.discovery.authorizationServerUrl, authorization).catch(fail);

	const result: InitiatedAuthorization = {
		url: started.authorizationUrl.toString(),
		clientId: client.client_id,
		codeVerifier: started.codeVerifier,
	};

	if (client.client_secret) result.clientSecret = client.client_secret;

	return result;
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

	const request: NonNullable<Parameters<typeof exchangeAuthorization>[1]> = {
		metadata,
		clientInformation: clientInformation(input.clientId, input.clientSecret),
		authorizationCode: input.code,
		codeVerifier: input.verifier,
		redirectUri: input.redirectUri,
		fetchFn,
	};

	if (input.resource) request.resource = input.resource;

	const tokens = await exchangeAuthorization(authorizationServerUrl, request).catch(fail);

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

	const request: NonNullable<Parameters<typeof refreshAuthorization>[1]> = {
		metadata,
		clientInformation: clientInformation(input.clientId, input.clientSecret),
		refreshToken: input.refreshToken,
		fetchFn,
	};

	if (input.resource) request.resource = input.resource;

	const tokens = await refreshAuthorization(authorizationServerUrl, request).catch(fail);

	return toTokens(tokens);
}

function clientMetadata(redirectUri: string, scope?: string): OAuthClientMetadata {
	const metadata: OAuthClientMetadata = {
		client_name: "Eryn",
		redirect_uris: [redirectUri],
		grant_types: ["authorization_code", "refresh_token"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	};

	if (scope) metadata.scope = scope;

	return metadata;
}

function clientInformation(clientId: string, clientSecret?: string): OAuthClientInformationMixed {
	const client: OAuthClientInformationMixed = { client_id: clientId };

	if (clientSecret) client.client_secret = clientSecret;

	return client;
}

/**
 * Rebuild the slice of authorization-server metadata a token request needs.
 *
 * The full metadata is only used while starting a sign-in. Exchange and refresh
 * happen in a later request, where the attempt record remembers the token
 * endpoint and nothing else. The SDK accepts a partial document as long as the
 * fields it reads are present.
 */
function tokenRequest(tokenEndpoint: string): TokenRequest {
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

/** What the OAuth client needs to talk to a server's token endpoint. */
interface TokenRequest {
	readonly authorizationServerUrl: string;
	readonly metadata: AuthorizationServerMetadata;
}

function toTokens(tokens: OAuthTokens): McpTokens {
	const result: McpTokens = { accessToken: tokens.access_token };

	if (tokens.refresh_token) result.refreshToken = tokens.refresh_token;

	if (tokens.expires_in !== undefined) result.expiresIn = tokens.expires_in;

	if (tokens.scope) result.scope = tokens.scope;

	return result;
}

/** Turn a library error into the one-line answer a Discord message can show. */
function fail<Thrown>(error: Thrown): never {
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
 * The fetch every request the OAuth library makes uses — discovery,
 * registration, token exchange, refresh — so an external server cannot
 * redirect the Worker somewhere it would not otherwise call.
 */
const fetchFn: FetchLike = externalFetch(DISCOVERY_TIMEOUT_MS);

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
