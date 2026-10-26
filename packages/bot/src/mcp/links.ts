/**
 * Linking MCP servers to a guild, including the sign-in half.
 *
 * A link is stored in the guild's object either way: Eryn-hosted servers get an
 * internally minted grant token (no browser involved), and external servers get
 * a bearer — supplied by an admin, or obtained through the server's own OAuth
 * flow. Keeping both behind the same record is what lets the agent, the test
 * command, and the host config treat every link the same.
 *
 * This module owns the rules around that record; the session object owns its
 * storage and its routes.
 */

import { log, publicOrigin } from "../config";
import { randomToken, sign } from "../crypto";
import { describeError } from "../errors";
import type { GuildStoreShape } from "../session/store";
import type { McpLink, PendingMcpAuth } from "../session/models";
import { probeServer, type ProbeResult } from "./client";
import {
	authorizationUrl,
	discover,
	exchangeCode,
	pkce,
	refreshTokens,
	registerClient,
	type McpDiscovery,
} from "./oauth";

/** Where an authorization server sends the browser back to. */
export const MCP_CALLBACK_PATH = "/api/bot/mcp/callback";

/** A started sign-in is valid for this long, which is how long a browser tab has. */
export const AUTH_TTL_MS = 15 * 60_000;

/** Refresh a token this long before it expires, so a turn never starts on a dead one. */
const REFRESH_SKEW_MS = 60_000;
const DEFAULT_TOKEN_TTL_SECONDS = 3_600;

/** The redirect URI this deployment registers with an external authorization server. */
export function mcpRedirectUri(env: Env): string {
	return `${publicOrigin(env)}${MCP_CALLBACK_PATH}`;
}

export interface BeginAuthorizationInput {
	store: GuildStoreShape;
	env: Env;
	guildId: string;
	name: string;
	url: string;
	channelId?: string;
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
): Promise<{ attemptId: string; url: string }> {
	const secret = input.env.SESSION_SECRET?.trim();
	if (!secret) throw new Error("This deployment has no session secret, so a sign-in cannot be completed.");

	const discovery = await discover(input.url, input.resourceMetadataUrl);
	if (!discovery.registrationEndpoint) {
		throw new Error(
			"This server does not support automatic client registration. Add it with a token instead.",
		);
	}

	const redirectUri = mcpRedirectUri(input.env);
	const scope = input.scope ?? requestedScope(discovery);
	const client = await registerClient({
		registrationEndpoint: discovery.registrationEndpoint,
		redirectUri,
		...(scope ? { scope } : {}),
	});
	const { verifier, challenge } = await pkce();
	const attemptId = randomToken(16);
	const state = await sign({ guildId: input.guildId, attemptId }, secret);
	const url = authorizationUrl(discovery, {
		clientId: client.clientId,
		redirectUri,
		state,
		challenge,
		...(scope ? { scope } : {}),
	});

	await pruneAttempts(input.store);
	await input.store.putAuthAttempt({
		attemptId,
		name: input.name,
		url: input.url,
		...(input.channelId ? { channelId: input.channelId } : {}),
		state,
		clientId: client.clientId,
		...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
		tokenEndpoint: discovery.tokenEndpoint,
		...(discovery.resource ? { resource: discovery.resource } : {}),
		...(scope ? { scope } : {}),
		codeVerifier: verifier,
		redirectUri,
		status: "pending",
		createdAt: Date.now(),
	});

	return { attemptId, url };
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
	store: GuildStoreShape,
	pending: PendingMcpAuth,
	input: { code?: string; error?: string },
): Promise<FinishAuthorizationResult> {
	if (pending.status === "complete" && pending.linkId) {
		const link = await store.getLink(pending.linkId);
		return { status: "complete", ...(link ? { link } : {}) };
	}
	if ((pending.status === "pending" || pending.status === "failed") && Date.now() - pending.createdAt > AUTH_TTL_MS) {
		return await fail(store, pending, "That sign-in expired. Start it again from `/eryn mcp add`.");
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

	let tokens;
	try {
		tokens = await exchangeCode({
			tokenEndpoint: pending.tokenEndpoint,
			...(pending.resource ? { resource: pending.resource } : {}),
			clientId: pending.clientId,
			...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
			redirectUri: pending.redirectUri,
			code: input.code,
			verifier: pending.codeVerifier,
		});
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

	const scope = tokens.scope ?? pending.scope;
	const link: McpLink = {
		id: crypto.randomUUID(),
		kind: "external",
		name: pending.name,
		url: pending.url,
		token: tokens.accessToken,
		oauth: {
			clientId: pending.clientId,
			...(pending.clientSecret ? { clientSecret: pending.clientSecret } : {}),
			tokenEndpoint: pending.tokenEndpoint,
			expiresAt: Date.now() + (tokens.expiresIn ?? DEFAULT_TOKEN_TTL_SECONDS) * 1_000,
			...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
			...(scope ? { scope } : {}),
			...(pending.resource ? { resource: pending.resource } : {}),
		},
		tools: { groups: {} },
		createdAt: Date.now(),
	};
	await store.putLink(link);
	await store.putAuthAttempt({
		...pending,
		status: "complete",
		linkId: link.id,
	});
	return { status: "complete", link, tools: probe.tools };
}

/** Mark an attempt failed, so the interaction and the callback say the same thing. */
async function fail(
	store: GuildStoreShape,
	pending: PendingMcpAuth,
	message: string,
): Promise<FinishAuthorizationResult> {
	await store.putAuthAttempt({ ...pending, status: "failed", message });
	return { status: "failed", message };
}

/**
 * Keep a link's bearer usable.
 *
 * A stored token is refreshed only when it is close to expiry, and a failed
 * refresh leaves the old token in place: the next turn reports the server's own
 * rejection, which is more useful than hiding the link.
 */
export async function refreshLink(store: GuildStoreShape, link: McpLink): Promise<McpLink> {
	const oauth = link.oauth;
	if (!oauth || !oauth.refreshToken) return link;
	if (oauth.expiresAt - Date.now() > REFRESH_SKEW_MS) return link;
	try {
		const tokens = await refreshTokens({
			tokenEndpoint: oauth.tokenEndpoint,
			clientId: oauth.clientId,
			...(oauth.clientSecret ? { clientSecret: oauth.clientSecret } : {}),
			refreshToken: oauth.refreshToken,
			...(oauth.resource ? { resource: oauth.resource } : {}),
		});
		const next: McpLink = {
			...link,
			token: tokens.accessToken,
			oauth: {
				...oauth,
				refreshToken: tokens.refreshToken ?? oauth.refreshToken,
				expiresAt: Date.now() + (tokens.expiresIn ?? DEFAULT_TOKEN_TTL_SECONDS) * 1_000,
				...(tokens.scope ? { scope: tokens.scope } : {}),
			},
		};
		await store.putLink(next);
		return next;
	} catch (error) {
		log("session", `could not refresh the token for ${link.name}: ${describeError(error)}`);
		return link;
	}
}

/** Refresh every link that needs it, leaving the rest untouched. */
export async function refreshLinks(store: GuildStoreShape, links: readonly McpLink[]): Promise<McpLink[]> {
	return await Promise.all(links.map((link) => refreshLink(store, link)));
}

/** Ask a linked server what it offers, using the bearer the link carries. */
export async function testLink(link: McpLink): Promise<ProbeResult> {
	return await probeServer({ url: link.url, ...(link.token ? { token: link.token } : {}) });
}

/** Drop attempts nobody will finish, so storage does not accumulate verifiers. */
async function pruneAttempts(store: GuildStoreShape): Promise<void> {
	const attempts = await store.authAttempts().catch(() => []);
	const cutoff = Date.now() - AUTH_TTL_MS;
	for (const attempt of attempts) {
		if (attempt.createdAt < cutoff) await store.removeAuthAttempt(attempt.attemptId).catch(() => undefined);
	}
}

/** A one-line account of what a server offers, for a Discord message. */
export function describeTools(tools: readonly { name: string }[]): string {
	if (!tools.length) return "It advertises no tools.";
	const shown = tools
		.slice(0, 8)
		.map((tool) => tool.name.slice(0, 40))
		.join(", ");
	return `It offers ${tools.length} tool${tools.length === 1 ? "" : "s"}: ${shown}${tools.length > 8 ? ", …" : ""}.`;
}

/** The narrowest scope the server supports, preferring one it names itself. */
function requestedScope(discovery: McpDiscovery): string | undefined {
	return discovery.scopesSupported.length === 1 ? discovery.scopesSupported[0] : undefined;
}
