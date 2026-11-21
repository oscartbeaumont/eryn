/**
 * Linking MCP servers to a guild, including the sign-in half.
 *
 * A link carries a bearer — supplied by an admin, or obtained through the
 * server's own OAuth flow. Keeping both behind the same record is what lets the
 * agent, the test command, and the host config treat every link the same.
 *
 * This module owns the rules around that record; the session object owns its
 * storage and its routes.
 */

import { log, sessionSecret } from "../config";
import { randomToken, sign } from "../crypto";
import { describeError } from "../errors";
import { resolveOrigin } from "../discord/application";
import type { Mutable } from '../mutable.ts';
import type { McpLink, PendingMcpAuth } from "../session/models";
import { discover, exchangeCode, initiate, refreshTokens } from './oauth';
import type { InitiateInput, McpDiscovery, McpTokens } from './oauth';
import { MCP_CALLBACK_PATH, MCP_START_PATH, AUTH_TTL_MS } from "./paths";
import { probeServer } from './probe';
import type { ProbeOptions, ProbeResult } from './probe';

/**
 * The slice of guild storage a link needs.
 *
 * Declared here rather than importing the session's full store, so this module
 * depends only on the records it actually reads and writes.
 */
export interface LinkStore {
	links(): Promise<McpLink[]>;
	getLink(id: string): Promise<McpLink | undefined>;
	putLink(link: McpLink): Promise<void>;
	authAttempts(): Promise<PendingMcpAuth[]>;
	putAuthAttempt(attempt: PendingMcpAuth): Promise<void>;
	removeAuthAttempt(id: string): Promise<void>;
}

/** Refresh a token this long before it expires, so a turn never starts on a dead one. */
const REFRESH_SKEW_MS = 60_000;

const DEFAULT_TOKEN_TTL_SECONDS = 3_600;

/** When a token pair obtained now should be considered expired. */
function expiresAt(tokens: McpTokens): number {
	return Date.now() + (tokens.expiresIn ?? DEFAULT_TOKEN_TTL_SECONDS) * 1_000;
}

/** The redirect URI this deployment registers with an external authorization server. */
export function mcpRedirectUri(origin: string): string {
	return `${origin}${MCP_CALLBACK_PATH}`;
}

export interface BeginAuthorizationInput {
	store: LinkStore;
	env: Env;
	guildId: string;
	name: string;
	url: string;
	elicitation?: McpLink["elicitation"];
	applicationId?: string;
	interactionToken?: string;
	resourceMetadataUrl?: string;
	scope?: string;
}

/**
 * Discover, register, and build the authorization URL.
 *
 * There is no state worth keeping outside the attempt record: the client
 * registration, the PKCE verifier, and the resource all travel with it, and the
 * `state` that comes back is a signed pointer to that record.
 */
export async function beginAuthorization(
	input: BeginAuthorizationInput,
): Promise<{ attemptId: string; url: string; startUrl: string }> {
	const secret = sessionSecret(input.env);

	if (!secret) throw new Error("This deployment has no session secret, so a sign-in cannot be completed.");
	const origin = await resolveOrigin(input.env);

	if (!origin) {
		throw new Error(
			"This deployment does not know its public URL yet. Open its site once, then start the sign-in again.",
		);
	}

	const discovery = await discover(input.url, input.resourceMetadataUrl);
	const redirectUri = mcpRedirectUri(origin);
	const scope = input.scope ?? requestedScope(discovery);
	const attemptId = randomToken(16);
	const state = await sign({ guildId: input.guildId, attemptId }, secret);

	const initiation: InitiateInput = { discovery, redirectUri, state };

	if (scope) initiation.scope = scope;

	const started = await initiate(initiation);

	await pruneAttempts(input.store);

	const attempt: Mutable<PendingMcpAuth> = {
		attemptId,
		name: input.name,
		url: input.url,
		state,
		authorizationUrl: started.url,
		clientId: started.clientId,
		tokenEndpoint: discovery.authorizationServerMetadata.token_endpoint,
		resource: discovery.resource,
		codeVerifier: started.codeVerifier,
		redirectUri,
		status: "pending",
		createdAt: Date.now(),
	};

	if (input.elicitation) attempt.elicitation = input.elicitation;

	if (input.applicationId) attempt.applicationId = input.applicationId;

	if (input.interactionToken) attempt.interactionToken = input.interactionToken;

	if (started.clientSecret) attempt.clientSecret = started.clientSecret;

	if (scope) attempt.scope = scope;

	await input.store.putAuthAttempt(attempt);

	return { attemptId, url: started.url, startUrl: `${origin}${MCP_START_PATH}/${state}` };
}

export interface FinishAuthorizationResult {
	status: "complete" | "failed";
	message?: string;
	link?: McpLink;
	tools?: ProbeResult["tools"];
}

/**
 * Complete a started sign-in with the code the browser brought back.
 *
 * The link is only stored once the server has accepted the token, so a failed
 * sign-in never leaves something the agent would try to use.
 */
export async function finishAuthorization(
	store: LinkStore,
	pending: PendingMcpAuth,
	input: { code?: string; error?: string },
): Promise<FinishAuthorizationResult> {
	if (pending.status === "complete" && pending.linkId) {
		const link = await store.getLink(pending.linkId);
		const result: Mutable<FinishAuthorizationResult> = { status: "complete" };

		if (link) result.link = link;

		return result;
	}

	if ((pending.status === "pending" || pending.status === "failed") && Date.now() - pending.createdAt > AUTH_TTL_MS) {
		return await fail(store, pending, "That sign-in expired. Start it again from `/eryn setup` under MCP servers.");
	}

	if (input.error) {
		return await fail(store, pending, "The sign-in was cancelled or refused.");
	}

	if (!input.code) {
		return await fail(store, pending, "The sign-in did not return a code.");
	}

	// The name was free when the sign-in started; it may not be now.
	const existing = await store.links();

	if (existing.some((link) => link.name === pending.name)) {
		return await fail(store, pending, `A server named "${pending.name}" is already linked.`);
	}

	const exchanged = await exchangeStoredCode(store, pending, input.code);

	if ("status" in exchanged) return exchanged;

	const tokens = exchanged.tokens;
	const probe = exchanged.probe;
	const link = await storeLink(store, pending, tokens);
	const storedAttempt: Mutable<PendingMcpAuth> = { ...pending, status: "complete", linkId: link.id };

	await store.putAuthAttempt(storedAttempt);

	return { status: "complete", link, tools: probe.tools };
}

/**
 * Exchange the verifier the browser's code came back with, then confirm the
 * server accepts the token it issued.
 *
 * A refusal at either step is the finished attempt, so the caller only stores a
 * link the server itself has accepted.
 */
async function exchangeStoredCode(
	store: LinkStore,
	pending: PendingMcpAuth,
	code: string,
): Promise<{ tokens: McpTokens; probe: ProbeResult } | FinishAuthorizationResult> {
	const exchange: Parameters<typeof exchangeCode>[0] = {
		tokenEndpoint: pending.tokenEndpoint,
		clientId: pending.clientId,
		redirectUri: pending.redirectUri,
		code,
		verifier: pending.codeVerifier,
	};

	if (pending.resource) exchange.resource = pending.resource;

	if (pending.clientSecret) exchange.clientSecret = pending.clientSecret;

	let tokens: McpTokens;

	try {
		tokens = await exchangeCode(exchange);
	} catch (error) {
		log("session", `MCP sign-in for ${pending.url} failed: ${describeError(error)}`);

		return await fail(store, pending, describeError(error));
	}

	const probe = await probeServer({ url: pending.url, token: tokens.accessToken });

	if (!probe.ok) {
		return await fail(
			store,
			pending,
			`The sign-in completed, but the server still refused the token: ${probe.error ?? "no reason given"}`,
		);
	}

	return { tokens, probe };
}

/**
 * Build the link from the accepted token and store it, so a failed sign-in
 * never leaves a record the agent would try to use.
 */
async function storeLink(store: LinkStore, pending: PendingMcpAuth, tokens: McpTokens): Promise<McpLink> {
	const scope = tokens.scope ?? pending.scope;

	const oauth: Mutable<NonNullable<McpLink["oauth"]>> = {
		clientId: pending.clientId,
		tokenEndpoint: pending.tokenEndpoint,
		expiresAt: expiresAt(tokens),
	};

	if (pending.clientSecret) oauth.clientSecret = pending.clientSecret;

	if (tokens.refreshToken) oauth.refreshToken = tokens.refreshToken;

	if (scope) oauth.scope = scope;

	if (pending.resource) oauth.resource = pending.resource;

	const link: Mutable<McpLink> = {
		id: crypto.randomUUID(),
		name: pending.name,
		url: pending.url,
		token: tokens.accessToken,
		oauth,
		createdAt: Date.now(),
	};

	if (pending.elicitation) link.elicitation = pending.elicitation;

	await store.putLink(link);

	return link;
}

/** Mark an attempt failed, so the interaction and the callback say the same thing. */
async function fail(
	store: LinkStore,
	pending: PendingMcpAuth,
	message: string,
): Promise<FinishAuthorizationResult> {
	await store.putAuthAttempt({ ...pending, status: "failed", message });

	return { status: "failed", message };
}

/** One refresh per link, so two routes cannot rotate the same refresh token. */
const refreshes = new Map<string, Promise<McpLink>>();

/**
 * Keep a link's bearer usable.
 *
 * A stored token is refreshed only when it is close to expiry, and a failed
 * refresh leaves the old token in place: the next turn reports the server's own
 * rejection, which is more useful than hiding the link.
 */
export async function refreshLink(store: LinkStore, link: McpLink): Promise<McpLink> {
	const running = refreshes.get(link.id);

	if (running) return await running;
	const refresh = refreshLinkOnce(store, link).finally(() => refreshes.delete(link.id));
	refreshes.set(link.id, refresh);

	return await refresh;
}

async function refreshLinkOnce(store: LinkStore, link: McpLink): Promise<McpLink> {
	const oauth = link.oauth;

	if (!oauth || !oauth.refreshToken) return link;

	if (oauth.expiresAt - Date.now() > REFRESH_SKEW_MS) return link;

	try {
		const request: Parameters<typeof refreshTokens>[0] = {
			tokenEndpoint: oauth.tokenEndpoint,
			clientId: oauth.clientId,
			refreshToken: oauth.refreshToken,
		};

		if (oauth.clientSecret) request.clientSecret = oauth.clientSecret;

		if (oauth.resource) request.resource = oauth.resource;

		const tokens = await refreshTokens(request);

		const oauthNext: Mutable<NonNullable<McpLink["oauth"]>> = {
			...oauth,
			refreshToken: tokens.refreshToken ?? oauth.refreshToken,
			expiresAt: expiresAt(tokens),
		};

		if (tokens.scope) oauthNext.scope = tokens.scope;

		const next: Mutable<McpLink> = { ...link, token: tokens.accessToken, oauth: oauthNext };

		// The admin may have removed the link while the token endpoint was busy.
		// Writing the refreshed record back would resurrect it.
		if (!(await store.getLink(link.id))) return link;
		await store.putLink(next);

		return next;
	} catch (error) {
		log("session", `could not refresh the token for ${link.name}: ${describeError(error)}`);

		return link;
	}
}

/** Refresh every link that needs it, leaving the rest untouched. */
export async function refreshLinks(store: LinkStore, links: readonly McpLink[]): Promise<McpLink[]> {
	return await Promise.all(links.map((link) => refreshLink(store, link)));
}

/** Ask a linked server what it offers, using the bearer the link carries. */
export async function testLink(link: McpLink): Promise<ProbeResult> {
	const options: ProbeOptions = { url: link.url };

	if (link.token) options.token = link.token;

	return await probeServer(options);
}

/** Drop attempts nobody will finish, so storage does not accumulate verifiers. */
async function pruneAttempts(store: LinkStore): Promise<void> {
	const attempts = await store.authAttempts().catch(() => []);
	const cutoff = Date.now() - AUTH_TTL_MS;

	for (const attempt of attempts) {
		if (attempt.createdAt < cutoff) await store.removeAuthAttempt(attempt.attemptId).catch(() => undefined);
	}
}

/** The narrowest scope the server supports, preferring one it names itself. */
function requestedScope(discovery: McpDiscovery): string | undefined {
	return discovery.scopesSupported.length === 1 ? discovery.scopesSupported[0] : undefined;
}
