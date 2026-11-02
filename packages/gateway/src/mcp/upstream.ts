/**
 * Talking to an upstream MCP server on a hosted server's behalf.
 *
 * A hosted server can federate other MCP servers: each connection is a URL plus
 * either fixed headers or an OAuth sign-in, and its tools are re-published on
 * this deployment's endpoint under a prefixed name. This module is the client
 * side of that — a Streamable HTTP MCP client, and the OAuth client half for
 * servers that ask for a sign-in the way RFC 9728 describes.
 *
 * Nothing here holds state: a sign-in in progress is a PKCE verifier on the
 * connection record, and the `state` the browser brings back is a signed
 * pointer to that record.
 */

import { Option, Schema } from "effect";

import { base64url, randomToken } from "../crypto";
import { CredentialRejectedError } from "../reauth";
import type { UpstreamAuth, UpstreamTool } from "../model";

/** The protocol revision this client asks for. A server may negotiate another. */
const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TOOL_PAGES = 10;

const InitializeResultSchema = Schema.Struct({
	protocolVersion: Schema.optional(Schema.String),
	serverInfo: Schema.optional(
		Schema.Struct({
			name: Schema.optional(Schema.String),
			version: Schema.optional(Schema.String),
		}),
	),
});

const ToolSchema = Schema.Struct({
	name: Schema.String,
	title: Schema.optional(Schema.String),
	description: Schema.optional(Schema.String),
	inputSchema: Schema.optional(Schema.Unknown),
	annotations: Schema.optional(
		Schema.Struct({
			readOnlyHint: Schema.optional(Schema.Boolean),
			destructiveHint: Schema.optional(Schema.Boolean),
		}),
	),
});

const ListToolsResultSchema = Schema.Struct({
	tools: Schema.Array(ToolSchema),
	nextCursor: Schema.optional(Schema.String),
});

const CallToolResultSchema = Schema.Struct({
	content: Schema.optional(
		Schema.Array(
			Schema.Struct({
				type: Schema.optional(Schema.String),
				text: Schema.optional(Schema.String),
			}),
		),
	),
	isError: Schema.optional(Schema.Boolean),
});

const JsonRpcResponseSchema = Schema.Struct({
	result: Schema.optional(Schema.Unknown),
	error: Schema.optional(
		Schema.Struct({
			code: Schema.optional(Schema.Number),
			message: Schema.optional(Schema.String),
		}),
	),
});

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
	/** Whether the server accepts a hosted document as the client's identity. */
	client_id_metadata_document_supported: Schema.optional(Schema.Boolean),
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

/** Headers to send, whether static or a bearer from a sign-in. */
export type UpstreamHeaders = Record<string, string>;

export interface UpstreamProbe {
	ok: boolean;
	error?: string;
	status?: number;
	tools: UpstreamTool[];
	serverName?: string;
	/** Set when the server asked for a Bearer sign-in. */
	needsAuth?: boolean;
	resourceMetadataUrl?: string;
	scope?: string;
}

/** Everything the flow needs from one authorization server. */
export interface UpstreamDiscovery {
	resource: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint?: string;
	scopesSupported: readonly string[];
	/** The server identifies clients by a hosted metadata document, not a registration. */
	metadataDocument: boolean;
}

export interface UpstreamTokens {
	accessToken: string;
	refreshToken?: string;
	expiresIn?: number;
	scope?: string;
}

export class UpstreamOAuthError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UpstreamOAuthError";
	}
}

// --- Talking to the server -----------------------------------------------------

/**
 * Ask an MCP server what it offers.
 *
 * Never throws: a refused connection, a bad URL, and a protocol error are all
 * answers the caller has to show someone.
 */
export async function probeUpstream(options: {
	url: string;
	headers?: UpstreamHeaders;
	timeoutMs?: number;
}): Promise<UpstreamProbe> {
	const endpoint = parseUrl(options.url);
	if (typeof endpoint === "string") return failed(endpoint);
	endpoint.hash = "";
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

	let sessionId: string | undefined;
	try {
		const initialize = await rpc(
			endpoint,
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "eryn", version: "1.0.0" },
				},
			},
			options.headers,
			undefined,
			timeoutMs,
		);

		if (initialize.response.status === 401 || initialize.response.status === 403) {
			const header = initialize.response.headers.get("www-authenticate");
			const challenge = parseChallenge(header);
			const bearer = !header || /\bbearer\b/i.test(header);
			return {
				ok: false,
				tools: [],
				needsAuth: bearer,
				...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
				...(challenge.scope ? { scope: challenge.scope } : {}),
				status: initialize.response.status,
				error:
					challenge.errorDescription ??
					challenge.error ??
					(options.headers ? "This server rejected the headers." : "This server needs authorisation before it will talk."),
			};
		}
		if (!initialize.response.ok) {
			return failed(`The server answered HTTP ${initialize.response.status}.`, initialize.response.status);
		}

		sessionId = initialize.response.headers.get("mcp-session-id") ?? undefined;
		const initialized = decode(InitializeResultSchema, initialize.message?.result);
		if (!initialized) return failed("The server's initialize response was not MCP.");
		const protocolVersion = initialized.protocolVersion ?? PROTOCOL_VERSION;

		await notify(endpoint, "notifications/initialized", options.headers, sessionId, protocolVersion, timeoutMs);

		const tools: UpstreamTool[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_TOOL_PAGES; page++) {
			const listing = await rpc(
				endpoint,
				{ jsonrpc: "2.0", id: 2 + page, method: "tools/list", params: cursor ? { cursor } : {} },
				options.headers,
				sessionId,
				timeoutMs,
				protocolVersion,
			);
			if (listing.response.status === 401) {
				return {
					ok: false,
					tools,
					needsAuth: true,
					status: 401,
					error: "This server rejected the credentials.",
				};
			}
			if (!listing.response.ok) {
				return failed(`The server answered HTTP ${listing.response.status}.`, listing.response.status);
			}
			const result = decode(ListToolsResultSchema, listing.message?.result);
			if (!result) return failed("The server's tools/list response was not MCP.");
			tools.push(
				...result.tools.map((tool) => ({
					name: tool.name,
					...(tool.title ? { title: tool.title } : {}),
					...(tool.description ? { description: tool.description } : {}),
					// A tool that does not say it is read-only is treated as able to
					// change something, which is the safe default to grant from.
					access: tool.annotations?.readOnlyHint === true ? ("read" as const) : ("write" as const),
					...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
				})),
			);
			cursor = result.nextCursor;
			if (!cursor) break;
		}

		return {
			ok: true,
			tools,
			...(initialized.serverInfo?.name ? { serverName: initialized.serverInfo.name } : {}),
		};
	} catch (error) {
		return failed(describeError(error));
	} finally {
		if (sessionId) {
			// The session is not reused, so end it rather than leave the server
			// holding state for a probe that is already over.
			await fetch(endpoint, {
				method: "DELETE",
				headers: headers(options.headers, sessionId),
				signal: AbortSignal.timeout(2_000),
			}).catch(() => undefined);
		}
	}
}

/** Call one tool on an upstream server and return its text. */
export async function callUpstreamTool(options: {
	url: string;
	headers?: UpstreamHeaders;
	name: string;
	args: Record<string, unknown>;
	timeoutMs?: number;
}): Promise<string> {
	const endpoint = parseUrl(options.url);
	if (typeof endpoint === "string") throw new Error(endpoint);
	endpoint.hash = "";
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

	let sessionId: string | undefined;
	try {
		const initialize = await rpc(
			endpoint,
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "eryn", version: "1.0.0" } },
			},
			options.headers,
			undefined,
			timeoutMs,
		);
		if (initialize.response.status === 401 || initialize.response.status === 403) {
			throw new CredentialRejectedError(`The upstream server rejected the stored sign-in (HTTP ${initialize.response.status}).`);
		}
		if (!initialize.response.ok) throw new Error(`The upstream server answered HTTP ${initialize.response.status}.`);
		sessionId = initialize.response.headers.get("mcp-session-id") ?? undefined;
		const initialized = decode(InitializeResultSchema, initialize.message?.result);
		if (!initialized) throw new Error("The upstream server's initialize response was not MCP.");
		const protocolVersion = initialized.protocolVersion ?? PROTOCOL_VERSION;
		await notify(endpoint, "notifications/initialized", options.headers, sessionId, protocolVersion, timeoutMs);

		const call = await rpc(
			endpoint,
			{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: options.name, arguments: options.args } },
			options.headers,
			sessionId,
			timeoutMs,
			protocolVersion,
		);
		if (call.response.status === 401 || call.response.status === 403) {
			throw new CredentialRejectedError(`The upstream server rejected the stored sign-in (HTTP ${call.response.status}).`);
		}
		if (!call.response.ok) throw new Error(`The upstream server answered HTTP ${call.response.status}.`);
		const result = decode(CallToolResultSchema, call.message?.result);
		if (!result) throw new Error("The upstream server's tools/call response was not MCP.");
		const text = (result.content ?? [])
			.map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : undefined))
			.filter((part): part is string => part !== undefined)
			.join("\n");
		if (result.isError) throw new Error(text || `The ${options.name} tool failed.`);
		return text || "The tool returned no text.";
	} finally {
		if (sessionId) {
			await fetch(endpoint, {
				method: "DELETE",
				headers: headers(options.headers, sessionId),
				signal: AbortSignal.timeout(2_000),
			}).catch(() => undefined);
		}
	}
}

/** The headers a connection's auth produces right now, without refreshing. */
export function staticHeaders(auth: UpstreamAuth): UpstreamHeaders {
	if (auth.kind === "headers") return { ...(auth.headers ?? {}) };
	if (auth.kind === "oauth" && auth.oauth?.accessToken) return { authorization: `Bearer ${auth.oauth.accessToken}` };
	return {};
}

/** Whether a connection has something it can authenticate with. */
export function connected(auth: UpstreamAuth): boolean {
	if (auth.kind === "none") return true;
	if (auth.kind === "headers") return Object.keys(auth.headers ?? {}).length > 0;
	return Boolean(auth.oauth?.accessToken);
}

/**
 * Whether a header can be set by a connection.
 *
 * The transport owns the framing headers, so letting a connection set them
 * would be a way to break the request rather than to authenticate.
 */
const RESERVED_HEADERS = new Set([
	"accept",
	"connection",
	"content-length",
	"content-type",
	"host",
	"mcp-protocol-version",
	"mcp-session-id",
	"transfer-encoding",
]);

/** Validate the headers a user typed, or explain why they cannot be sent. */
export function validateHeaders(headers: Record<string, string> | undefined): string | undefined {
	for (const [name, value] of Object.entries(headers ?? {})) {
		if (!/^[A-Za-z0-9_-]+$/.test(name)) return `"${name}" is not a valid header name.`;
		if (RESERVED_HEADERS.has(name.toLowerCase())) return `The ${name} header is set by Eryn and cannot be overridden.`;
		if (/[\r\n]/.test(value)) return `The ${name} header has a line break in its value.`;
	}
	return undefined;
}

// --- OAuth ---------------------------------------------------------------------

/**
 * Find the authorization server behind an MCP server.
 *
 * `resourceMetadataUrl` comes from the server's own challenge when it gave one;
 * otherwise the well-known locations from RFC 9728 are tried in order.
 */
export async function discoverUpstream(resourceUrl: string, resourceMetadataUrl?: string): Promise<UpstreamDiscovery> {
	const resource = parseUrl(resourceUrl);
	if (typeof resource === "string") throw new UpstreamOAuthError(resource);
	resource.hash = "";
	const metadataUrl = resourceMetadataUrl ?? (await findResourceMetadata(resource));
	if (!metadataUrl) throw new UpstreamOAuthError("This server did not publish OAuth metadata.");

	const protectedResource = decode(
		ProtectedResourceSchema,
		await fetchJson(metadataUrl, "the protected resource metadata"),
	);
	if (!protectedResource) throw new UpstreamOAuthError("This server's OAuth metadata could not be read.");
	const issuer = protectedResource.authorization_servers[0];
	if (!issuer) throw new UpstreamOAuthError("This server names no authorization server.");

	const metadata = await findAuthorizationServer(issuer);
	const challenges = metadata.code_challenge_methods_supported;
	if (challenges && !challenges.includes("S256")) {
		throw new UpstreamOAuthError("This server's authorization server does not support PKCE with S256.");
	}
	requireTransport(metadata.authorization_endpoint, "authorization endpoint");
	requireTransport(metadata.token_endpoint, "token endpoint");

	return {
		resource: protectedResource.resource ?? resource.toString(),
		authorizationEndpoint: metadata.authorization_endpoint,
		tokenEndpoint: metadata.token_endpoint,
		...(metadata.registration_endpoint ? { registrationEndpoint: metadata.registration_endpoint } : {}),
		scopesSupported: metadata.scopes_supported ?? protectedResource.scopes_supported ?? [],
		metadataDocument: metadata.client_id_metadata_document_supported === true,
	};
}

/** Register this deployment as an OAuth client, when the server allows it. */
export async function registerUpstreamClient(input: {
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
	const response = await fetch(requireTransport(input.registrationEndpoint, "client registration"), {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const payload = (await response.json().catch(() => undefined)) as unknown;
	if (!response.ok) {
		const code = decode(ErrorSchema, payload)?.error;
		throw new UpstreamOAuthError(
			`This server would not register Eryn as a client${code ? ` (${code})` : ""}. Use headers instead.`,
		);
	}
	const registration = decode(RegistrationSchema, payload);
	if (!registration) throw new UpstreamOAuthError("This server's client registration response could not be read.");
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
export function upstreamAuthorizationUrl(
	discovery: UpstreamDiscovery,
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

/**
 * The scope to ask for.
 *
 * The server's own challenge names what it needs; `offline_access` is added
 * when the authorization server offers it, because a connection that cannot
 * refresh its token is one that stops working an hour after it was made.
 */
export function requestedScope(discovery: UpstreamDiscovery, challengeScope?: string): string | undefined {
	const scopes: string[] = [];
	if (challengeScope) scopes.push(challengeScope);
	else if (discovery.scopesSupported.length === 1 && discovery.scopesSupported[0]) scopes.push(discovery.scopesSupported[0]);
	if (discovery.scopesSupported.includes("offline_access") && !scopes.includes("offline_access")) {
		scopes.push("offline_access");
	}
	return scopes.length ? scopes.join(" ") : undefined;
}

/** Exchange the code the browser brought back for a token pair. */
export async function exchangeUpstreamCode(input: {
	tokenEndpoint: string;
	resource?: string;
	clientId: string;
	clientSecret?: string;
	redirectUri: string;
	code: string;
	verifier: string;
}): Promise<UpstreamTokens> {
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
export async function refreshUpstreamToken(input: {
	tokenEndpoint: string;
	clientId: string;
	clientSecret?: string;
	refreshToken: string;
	resource?: string;
}): Promise<UpstreamTokens> {
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
): Promise<UpstreamTokens> {
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

	const response = await fetch(requireTransport(endpoint, "the token endpoint"), {
		method: "POST",
		headers,
		body,
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	const payload = (await response.json().catch(() => undefined)) as unknown;
	if (!response.ok) {
		const code = decode(ErrorSchema, payload)?.error;
		throw new UpstreamOAuthError(`The sign-in server refused the request${code ? ` (${code})` : ""}.`);
	}
	const tokens = decode(TokenSchema, payload);
	if (!tokens) throw new UpstreamOAuthError("The sign-in server's token response could not be read.");
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
 * at the root instead, and a few append it to the resource path.
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
			throw new UpstreamOAuthError("This server's authorization metadata names a different issuer.");
		}
		return metadata;
	}
	throw new UpstreamOAuthError("This server's authorization server metadata could not be read.");
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
		throw new UpstreamOAuthError(`The ${label ?? "metadata"} URL is not valid.`);
	}
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
		if (optional) return undefined;
		throw new UpstreamOAuthError(`The ${label ?? "metadata"} URL must use https.`);
	}
	try {
		const response = await fetch(parsed, {
			headers: { accept: "application/json" },
			redirect: "follow",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (!response.ok) {
			await response.body?.cancel().catch(() => undefined);
			if (optional) return undefined;
			throw new UpstreamOAuthError(`The ${label ?? "metadata"} request answered HTTP ${response.status}.`);
		}
		return (await response.json().catch(() => undefined)) as unknown;
	} catch (error) {
		if (optional) return undefined;
		if (error instanceof UpstreamOAuthError) throw error;
		throw new UpstreamOAuthError(`Could not read the ${label ?? "metadata"}: ${describeError(error)}`);
	}
}

// --- Plumbing ------------------------------------------------------------------

function failed(error: string, status?: number): UpstreamProbe {
	return { ok: false, tools: [], error, ...(status === undefined ? {} : { status }) };
}

/** A URL the client is allowed to talk to, or why it is not. */
function parseUrl(value: string): URL | string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return "That URL is not valid.";
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
		return "An MCP server URL must use https.";
	}
	if (url.username || url.password) return "An MCP server URL must not contain a username or password.";
	return url;
}

/** OAuth endpoints carry secrets, so only https is acceptable in production. */
function requireTransport(url: string, label: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new UpstreamOAuthError(`The ${label} URL is not valid.`);
	}
	if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback(parsed.hostname))) {
		throw new UpstreamOAuthError(`The ${label} must use https.`);
	}
	return parsed;
}

/** Loopback is allowed over http so a local server can be tried in development. */
function isLoopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function headers(auth: UpstreamHeaders | undefined, sessionId?: string, protocolVersion?: string): Record<string, string> {
	return {
		accept: "application/json, text/event-stream",
		...(auth ?? {}),
		...(sessionId ? { "mcp-session-id": sessionId } : {}),
		...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
	};
}

interface RpcResult {
	response: Response;
	message?: { result?: unknown; error?: { code?: number; message?: string } };
}

/** Send one JSON-RPC request and read the matching reply, JSON or SSE framed. */
async function rpc(
	endpoint: URL,
	body: unknown,
	auth: UpstreamHeaders | undefined,
	sessionId: string | undefined,
	timeoutMs: number,
	protocolVersion?: string,
): Promise<RpcResult> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { ...headers(auth, sessionId, protocolVersion), "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		// Drain the body so the connection can be reused; the status and headers
		// are all this call is interested in.
		await response.body?.cancel().catch(() => undefined);
		return { response };
	}

	const message = (await readReply(response, (body as { id: number }).id)) as RpcResult["message"];
	if (message?.error) {
		throw new Error(message.error.message ?? `The server returned JSON-RPC error ${message.error.code ?? "?"}.`);
	}
	return { response, message };
}

/** Send a notification; the reply is a status code and nothing worth reading. */
async function notify(
	endpoint: URL,
	method: string,
	auth: UpstreamHeaders | undefined,
	sessionId: string | undefined,
	protocolVersion: string,
	timeoutMs: number,
): Promise<void> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { ...headers(auth, sessionId, protocolVersion), "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", method }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	await response.body?.cancel().catch(() => undefined);
}

/**
 * Read one JSON-RPC reply from a Streamable HTTP response.
 *
 * A server may answer with JSON or with an SSE stream, and an SSE stream may
 * carry notifications before the reply. The reader stops at the reply and
 * cancels the body, so a server that holds the stream open cannot hold the
 * probe open with it.
 */
async function readReply(response: Response, id: unknown): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("text/event-stream")) {
		return await response.json().catch(() => undefined);
	}
	if (!response.body) throw new Error("The server returned an empty event stream.");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const data = frame
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice("data:".length).trimStart())
					.join("");
				if (!data) continue;
				let message: unknown;
				try {
					message = JSON.parse(data) as unknown;
				} catch {
					continue;
				}
				if (message && typeof message === "object" && (message as { id?: unknown }).id === id) {
					return message;
				}
				boundary = buffer.indexOf("\n\n");
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	throw new Error("The server ended the stream without answering.");
}

interface Challenge {
	scheme?: string;
	resourceMetadataUrl?: string;
	scope?: string;
	error?: string;
	errorDescription?: string;
}

/** Parse `Bearer resource_metadata="…", scope="…"` without a full HTTP parser. */
export function parseChallenge(header: string | null): Challenge {
	if (!header) return {};
	const scheme = /^\s*([A-Za-z][A-Za-z0-9_-]*)\b/.exec(header)?.[1]?.toLowerCase();
	const params: Record<string, string> = {};
	const pattern = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(header)) !== null) {
		params[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? "";
	}
	return {
		...(scheme ? { scheme } : {}),
		...(params.resource_metadata ? { resourceMetadataUrl: params.resource_metadata } : {}),
		...(params.scope ? { scope: params.scope } : {}),
		...(params.error ? { error: params.error } : {}),
		...(params.error_description ? { errorDescription: params.error_description } : {}),
	};
}

function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S["Type"] | undefined {
	if (input === undefined) return undefined;
	const parsed = Schema.decodeUnknownOption(schema)(input);
	return Option.isSome(parsed) ? parsed.value : undefined;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
