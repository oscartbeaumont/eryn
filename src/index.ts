/**
 * The Eryn Worker entry point.
 *
 * The UI is a client-only Solid app (built by Vite into static assets and
 * served by Cloudflare); this Worker is the API and auth surface behind it:
 * Discord OAuth, the GitHub App install callback, the MCP authorization
 * server, and the JSON endpoints the console calls. It never renders HTML.
 */

import { env } from "cloudflare:workers";
import { Effect, Layer, Schema, Scheduler } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { CLIENT_ID, DEFAULT_MODEL, isValidModel } from "./config";
import { randomToken, sign, verify } from "./crypto";
import { discordRest } from "./discord/api";
import { allowedOrigins } from "./mcp/server";
import {
	AS_METADATA_PATH,
	MCP_PATH,
	OAuthError,
	PRM_PATHS,
	REGISTER_PATH,
	TOKEN_PATH,
	approveAuthorization,
	authorizationServerMetadata,
	bearerToken,
	challenge,
	denyAuthorization,
	exchangeAuthorizationCode,
	exchangeRefreshToken,
	inspectAuthorization,
	protectedResourceMetadata,
	readAuthorizeParams,
	registerClient,
	resourceUrl,
	verifyAccessToken,
	type ConsentRequest,
} from "./mcp/oauth";
import { authorizeUrl, canManage, currentUser, DiscordApiError, exchangeCode, listUserGuilds, type DiscordGuild } from "./oauth";
import type { IntegrationOption, OAuthAttempt, OAuthAttemptStatus } from "./providers";
import {
	beginAuthorization,
	discover,
	exchangeCode as exchangeMcpCode,
	newState,
	registerClient as registerMcpClient,
	type McpAuthorization,
	type McpClientRegistration,
} from "./mcp/auth";
import { listTools, McpUnauthorized } from "./mcp/client";
import { readDiscordLink, readGitHubConnection, writeDiscordLink, writeGitHubConnection } from "./mcp/link";
import { ensureToken, newServerId, readMcpServers, summarise, writeMcpServers, type McpServerRecord } from "./mcp/servers";
import {
	getGuildConfig,
	getGuildSummary,
	getUserGuilds,
	putGuild,
	putUserGuilds,
	removeGuild,
	setGuildInstallation,
} from "./registry-client";

export { ErynGateway } from "./gateway";
export { ErynSession } from "./agent";
export { ErynRegistry } from "./registry";
export { ErynMcp } from "./mcp/gateway";

const SESSION_COOKIE = "eryn_session";
const STATE_COOKIE = "eryn_state";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
const STATE_TTL_MS = 10 * 60 * 1_000;

interface Session {
	uid: string;
	name: string;
	token: string;
	exp: number;
}

const SetupRequestSchema = Schema.Struct({
	action: Schema.String,
	guild_id: Schema.String,
	integration_id: Schema.optional(Schema.String),
	api_key: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
	github_repo: Schema.optional(Schema.String),
});

const ModelsRequestSchema = Schema.Struct({
	guild_id: Schema.String,
});

const OAuthRequestSchema = Schema.Struct({
	action: Schema.String,
	guild_id: Schema.String,
	integration_id: Schema.String,
	method_id: Schema.optional(Schema.String),
	attempt_id: Schema.optional(Schema.String),
	code: Schema.optional(Schema.String),
	answer: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});

const McpServerRequestSchema = Schema.Struct({
	action: Schema.String,
	id: Schema.optional(Schema.String),
	name: Schema.optional(Schema.String),
	url: Schema.optional(Schema.String),
	/** A personal access token, when connecting GitHub that way. */
	token: Schema.optional(Schema.String),
});

/** Where an MCP server sends the browser back once the user has approved. */
const MCP_OAUTH_CALLBACK = "/oauth/mcp/callback";
/** The signed, one-shot record of a sign-in that is under way. */
const MCP_OAUTH_COOKIE = "eryn_mcp_oauth";
const MCP_OAUTH_TTL_MS = 10 * 60 * 1_000;

/**
 * A sign-in in progress.
 *
 * It is carried in a signed cookie rather than a row, like every other piece of
 * flow state here: it holds the PKCE verifier and the client we registered, and
 * it is the only thing the callback needs to finish the exchange.
 */
interface PendingMcpOAuth {
	typ: "mcp-oauth";
	userId: string;
	serverId: string;
	verifier: string;
	state: string;
	redirectUri: string;
	client: McpClientRegistration;
	authorization: McpAuthorization;
	exp: number;
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function json(body: unknown, status = 200): HttpServerResponse.HttpServerResponse {
	return HttpServerResponse.setStatus(status)(HttpServerResponse.jsonUnsafe(body));
}

/** Cookie defaults; `secure` is dropped only for a local http origin. */
function cookieOptions(origin: string) {
	return { httpOnly: true, secure: origin.startsWith("https:"), sameSite: "lax" as const, path: "/" };
}

async function readSession(request: HttpServerRequest.HttpServerRequest): Promise<Session | undefined> {
	const session = await verify<Session>(request.cookies?.[SESSION_COOKIE], env.SESSION_SECRET);
	if (!session || session.exp < Date.now()) return undefined;
	return session;
}

/** The guilds manageable by the signed-in user, cached briefly to spare Discord's rate limit. */
async function manageableGuilds(session: Session): Promise<DiscordGuild[]> {
	const cached = await getUserGuilds(env, session.uid).catch(() => undefined);
	if (cached) return cached;
	const fetched = await listUserGuilds(session.token);
	await putUserGuilds(env, session.uid, fetched).catch(() => undefined);
	return fetched;
}

// --- Auth ---------------------------------------------------------------------

function authError(origin: string, message: string): HttpServerResponse.HttpServerResponse {
	return HttpServerResponse.redirect(`${origin}/console?error=${encodeURIComponent(message)}`);
}

async function handleDiscordAuth(request: HttpServerRequest.HttpServerRequest): Promise<HttpServerResponse.HttpServerResponse> {
	const origin = new URL(request.originalUrl).origin;
	if (!env.DISCORD_CLIENT_SECRET) return authError(origin, "Discord sign-in is not configured.");
	const state = randomToken(16);
	const value = await sign({ state }, env.SESSION_SECRET);
	return HttpServerResponse.setCookieUnsafe(
		HttpServerResponse.redirect(authorizeUrl({ origin, clientId: CLIENT_ID, state })),
		STATE_COOKIE,
		value,
		{ ...cookieOptions(origin), expires: new Date(Date.now() + STATE_TTL_MS) },
	);
}

async function handleDiscordCallback(request: HttpServerRequest.HttpServerRequest): Promise<HttpServerResponse.HttpServerResponse> {
	const url = new URL(request.originalUrl);
	const origin = url.origin;
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const expected = await verify<{ state: string }>(request.cookies?.[STATE_COOKIE], env.SESSION_SECRET);
	const clientSecret = env.DISCORD_CLIENT_SECRET;
	if (!code || !state || !expected || expected.state !== state || !clientSecret) {
		return authError(origin, "That Discord sign-in could not be verified.");
	}
	const token = await exchangeCode({ origin, clientId: CLIENT_ID, clientSecret, code });
	const account = await currentUser(token.access_token);
	const session: Session = {
		uid: account.id,
		name: account.global_name || account.username,
		token: token.access_token,
		exp: Date.now() + SESSION_TTL_MS,
	};
	const response = HttpServerResponse.setCookieUnsafe(
		HttpServerResponse.redirect("/console"),
		SESSION_COOKIE,
		await sign(session, env.SESSION_SECRET),
		{ ...cookieOptions(origin), expires: new Date(session.exp) },
	);
	return HttpServerResponse.expireCookieUnsafe(STATE_COOKIE, cookieOptions(origin))(response);
}

function handleLogout(request: HttpServerRequest.HttpServerRequest): HttpServerResponse.HttpServerResponse {
	const origin = new URL(request.originalUrl).origin;
	return HttpServerResponse.expireCookieUnsafe(SESSION_COOKIE, cookieOptions(origin))(HttpServerResponse.redirect("/"));
}

/** Capture the installation id GitHub sends after the App is installed. */
async function handleGitHubCallback(request: HttpServerRequest.HttpServerRequest): Promise<HttpServerResponse.HttpServerResponse> {
	const url = new URL(request.originalUrl);
	const installationId = url.searchParams.get("installation_id");
	// The same App serves two scopes: a guild's own binding, and a user's MCP
	// tools. Which one this is comes from the state the install link carried.
	const state = await verify<{ guild?: string; user?: string; exp: number }>(
		url.searchParams.get("state") ?? undefined,
		env.SESSION_SECRET,
	);
	if (!installationId || !state || state.exp < Date.now() || (!state.guild && !state.user)) {
		return authError(url.origin, "That GitHub installation could not be verified.");
	}
	if (state.user) {
		await writeGitHubConnection(env, state.user, { kind: "app", installationId, connectedAt: Date.now() });
		await refreshGateway(state.user);
		return HttpServerResponse.redirect(`/console/mcp?ok=${encodeURIComponent("GitHub connected through the app.")}`);
	}
	await setGuildInstallation(env, state.guild!, installationId);
	return HttpServerResponse.redirect(`/console?ok=${encodeURIComponent("GitHub connected.")}`);
}

// --- API ----------------------------------------------------------------------

function handleSession(request: HttpServerRequest.HttpServerRequest): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest.HttpServerRequest> {
	return Effect.gen(function* () {
		const session = yield* Effect.promise(() => readSession(request));
		return session ? json({ signedIn: true, account: { id: session.uid, name: session.name } }) : json({ signedIn: false });
	});
}

/**
 * Public runtime configuration for the client bundle.
 *
 * The PostHog project token is a public value, and keeping it here rather than
 * compiled into the bundle means analytics can be switched off by clearing a
 * binding, with no rebuild.
 */
function handleConfig(): HttpServerResponse.HttpServerResponse {
	const key = env.POSTHOG_KEY?.trim();
	return json({
		posthog: key ? { key, uiHost: env.POSTHOG_UI_HOST?.trim() || "https://us.posthog.com" } : null,
	});
}

/**
 * The signed-in user's right to configure a guild, re-checked against Discord
 * rather than trusting the submitted id, plus the bot's own installation there.
 */
async function authorizedGuild(
	request: HttpServerRequest.HttpServerRequest,
	guildId: string,
): Promise<{ ok: true; session: Session } | { ok: false; response: HttpServerResponse.HttpServerResponse }> {
	const session = await readSession(request);
	if (!session) return { ok: false, response: json({ error: "Please sign in again." }, 401) };

	const guilds = await manageableGuilds(session);
	if (!guilds.some((guild) => guild.id === guildId && canManage(guild))) {
		return { ok: false, response: json({ error: "You cannot manage that server." }, 403) };
	}

	// A server must be installed before it can be configured.
	const bot = discordRest(env.DISCORD_BOT_TOKEN?.trim() ?? "");
	const installed = new Set((await bot.guilds()).map((guild) => guild.id));
	if (!installed.has(guildId)) {
		return { ok: false, response: json({ error: "Add Eryn to that server before configuring it." }, 400) };
	}
	return { ok: true, session };
}

/**
 * Call a route on a guild's own session object, handing it the credentials that
 * only this Worker reads out of the registry. The browser never sees them.
 */
async function providerRequest<T>(guildId: string, path: string, body: Record<string, unknown>): Promise<T> {
	const config = await getGuildConfig(env, guildId);
	const stub = env.SESSION.get(env.SESSION.idFromName(guildId));
	const response = await stub.fetch(`https://eryn${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			guildId,
			connections: config?.connections ?? [],
			model: config?.model,
			github: config?.github,
			...body,
		}),
	});
	const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new Error(payload.error ?? `The provider request failed (HTTP ${response.status}).`);
	return payload;
}

/** Every provider a guild could connect, from its own embedded OpenCode server. */
async function listIntegrations(guildId: string): Promise<{ integrations: IntegrationOption[]; error?: string }> {
	try {
		const body = await providerRequest<{ integrations?: IntegrationOption[] }>(guildId, "/session/integrations", {});
		return { integrations: Array.isArray(body.integrations) ? body.integrations : [] };
	} catch (error) {
		// A guild whose object cannot answer has no providers to offer, but saying
		// so beats an empty list that reads as "there are none".
		return { integrations: [], error: describe(error) };
	}
}

async function handleSetupGet(request: HttpServerRequest.HttpServerRequest): Promise<HttpServerResponse.HttpServerResponse> {
	const session = await readSession(request);
	if (!session) return json({ signedIn: false });

	const userGuilds = await manageableGuilds(session);
	const manageable = userGuilds.filter(canManage);
	const bot = discordRest(env.DISCORD_BOT_TOKEN?.trim() ?? "");
	const installed = new Set((await bot.guilds()).map((guild) => guild.id));
	const slug = env.GITHUB_APP_SLUG?.trim();

	const installedGuilds = manageable.filter((guild) => installed.has(guild.id));
	const available = manageable
		.filter((guild) => !installed.has(guild.id))
		.map((guild) => ({ id: guild.id, name: guild.name, icon: guild.icon ?? null }))
		.sort((a, b) => a.name.localeCompare(b.name));

	const guilds = await Promise.all(
		installedGuilds.map(async (guild) => {
			const summary = await getGuildSummary(env, guild.id);
			const installationId = summary.github?.installationId;
			return {
				id: guild.id,
				name: guild.name,
				icon: guild.icon ?? null,
				configured: summary.configured,
				model: summary.model ?? DEFAULT_MODEL,
				connections: summary.connections,
				updatedAt: summary.updatedAt ?? null,
				githubRepo: summary.github?.repo ?? null,
				githubInstalled: Boolean(installationId),
				githubInstallUrl:
					slug && !installationId
						? `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(
								await sign({ guild: guild.id, exp: Date.now() + 600_000 }, env.SESSION_SECRET),
							)}`
						: null,
			};
		}),
	);
	guilds.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));

	return json({
		signedIn: true,
		account: { id: session.uid, name: session.name },
		githubConfigured: Boolean(env.GITHUB_APP_ID?.trim() && env.GITHUB_APP_PRIVATE_KEY?.trim() && slug),
		guilds,
		available,
	});
}

async function handleSetupPost(
	request: HttpServerRequest.HttpServerRequest,
	form: Schema.Schema.Type<typeof SetupRequestSchema>,
): Promise<HttpServerResponse.HttpServerResponse> {
	const allowed = await authorizedGuild(request, form.guild_id);
	if (!allowed.ok) return allowed.response;
	const { session } = allowed;

	if (form.action === "remove") {
		await removeGuild(env, form.guild_id);
		return json({ ok: true, message: "Every provider was disconnected." });
	}

	if (form.action === "disconnect") {
		const integrationID = form.integration_id?.trim();
		if (!integrationID) return json({ error: "Which provider?" }, 400);
		// A key lives in the registry, but a signed-in provider's credential lives
		// in the guild's own object, so both have to be dropped.
		await providerRequest(form.guild_id, "/session/disconnect", { integrationID }).catch(() => undefined);
		await putGuild(env, form.guild_id, { disconnect: [integrationID], configuredBy: session.uid });
		return json({ ok: true, message: "That provider was disconnected." });
	}

	if (form.action === "connect") {
		const integrationID = form.integration_id?.trim();
		const apiKey = form.api_key?.trim();
		if (!integrationID) return json({ error: "Choose a provider." }, 400);
		if (!apiKey) return json({ error: "Paste that provider's API key." }, 400);

		// The provider has to be one this deployment's own catalogue offers, so a
		// stale browser cannot store a credential nothing will ever read.
		const integration = (await listIntegrations(form.guild_id)).integrations.find((entry) => entry.id === integrationID);
		if (!integration) return json({ error: "That provider is not one this deployment offers." }, 400);

		try {
			await putGuild(env, form.guild_id, {
				connect: [{ integrationID, method: "key", key: apiKey }],
				configuredBy: session.uid,
			});
		} catch (error) {
			return json({ error: describe(error) }, 400);
		}
		return json({ ok: true, message: `${integration.name} connected.` });
	}

	const model = form.model?.trim() || DEFAULT_MODEL;
	if (!isValidModel(model)) return json({ error: "The model must be a provider/model reference." }, 400);

	try {
		await putGuild(env, form.guild_id, {
			model,
			configuredBy: session.uid,
			githubRepo: form.github_repo,
		});
	} catch (error) {
		return json({ error: describe(error) }, 400);
	}
	return json({ ok: true, message: "Saved." });
}

/** A JSON error for the common Discord failure, or a generic one. */
function setupFailure(error: unknown): HttpServerResponse.HttpServerResponse {
	if (error instanceof DiscordApiError && error.status === 429) {
		return json({ error: "Discord rate-limited that request. Wait a moment and try again." }, 429);
	}
	return json({ error: describe(error) }, 500);
}

/** Every provider a guild could connect, and how each one would be connected. */
async function handleProviders(
	request: HttpServerRequest.HttpServerRequest,
	guildId: string,
): Promise<HttpServerResponse.HttpServerResponse> {
	const allowed = await authorizedGuild(request, guildId);
	if (!allowed.ok) return allowed.response;
	return json(await listIntegrations(guildId));
}

/**
 * The models a guild's connected providers can reach, for the console's picker.
 *
 * The catalogue comes from that guild's own embedded OpenCode server, so the
 * list is exactly what a turn would be able to use and none of the provider's
 * discovery logic is duplicated here. The keys never reach the browser: they are
 * read from the registry and forwarded over the internal Durable Object binding.
 */
async function handleModels(
	request: HttpServerRequest.HttpServerRequest,
	guildId: string,
): Promise<HttpServerResponse.HttpServerResponse> {
	const allowed = await authorizedGuild(request, guildId);
	if (!allowed.ok) return allowed.response;

	const config = await getGuildConfig(env, guildId);
	// With nothing connected there is nothing to ask a provider about, so the
	// picker stays empty rather than showing a guess.
	if (!config) return json({ models: [], default: DEFAULT_MODEL, reason: "no-provider" });

	try {
		const body = await providerRequest<{ models?: unknown }>(guildId, "/session/models", {});
		return json({ models: Array.isArray(body.models) ? body.models : [], default: config.model });
	} catch (error) {
		return json({ error: describe(error) }, 502);
	}
}

/**
 * One step of a provider sign-in, proxied to the guild's own object.
 *
 * The host performs the flow — it opens the browser round trip and keeps the
 * credential that comes back — so the console only starts it, polls it, and
 * hands over a code when the provider asks for one.
 */
async function handleOAuth(
	request: HttpServerRequest.HttpServerRequest,
	form: Schema.Schema.Type<typeof OAuthRequestSchema>,
): Promise<HttpServerResponse.HttpServerResponse> {
	const allowed = await authorizedGuild(request, form.guild_id);
	if (!allowed.ok) return allowed.response;

	try {
		const body = await providerRequest<{ attempt?: OAuthAttempt; status?: OAuthAttemptStatus; ok?: boolean }>(
			form.guild_id,
			"/session/oauth",
			{
				action: form.action,
				integrationID: form.integration_id,
				methodID: form.method_id,
				attemptID: form.attempt_id,
				code: form.code,
				answer: form.answer,
			},
		);
		// A finished sign-in leaves its credential in the guild's own object, so
		// the registry only records that the provider is now connected. Without
		// this the console would not know to show it, or to offer its models.
		if (body.status?.status === "complete" || (form.action === "complete" && body.ok)) {
			await putGuild(env, form.guild_id, {
				connect: [{ integrationID: form.integration_id, method: "oauth", key: "" }],
				configuredBy: allowed.session.uid,
			}).catch((error) =>
				console.log(`[eryn] could not record the ${form.integration_id} sign-in: ${describe(error)}`),
			);
		}
		return json(body);
	} catch (error) {
		return json({ error: describe(error) }, 502);
	}
}

// --- MCP servers (the ones a user connects) -----------------------------------

/** The servers this user has connected, without any credential in sight. */
async function handleMcpServerList(
	request: HttpServerRequest.HttpServerRequest,
): Promise<HttpServerResponse.HttpServerResponse> {
	const session = await readSession(request);
	if (!session) return json({ signedIn: false, servers: [], discord: null, github: null, githubInstallUrl: null });
	const [servers, link, github] = await Promise.all([
		readMcpServers(env, session.uid),
		readDiscordLink(env, session.uid),
		readGitHubConnection(env, session.uid),
	]);

	// The install link is only worth offering when the app itself is configured
	// and this account has not already installed it.
	const slug = env.GITHUB_APP_SLUG?.trim();
	const appConfigured = Boolean(slug && env.GITHUB_APP_ID?.trim() && env.GITHUB_APP_PRIVATE_KEY?.trim());
	const githubInstallUrl =
		appConfigured && !github
			? `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(
					await sign({ user: session.uid, exp: Date.now() + 600_000 }, env.SESSION_SECRET),
				)}`
			: null;

	return json({
		signedIn: true,
		servers: servers.map(summarise),
		discord: link ? { id: link.id, name: link.name } : null,
		github: github ? { kind: github.kind, login: github.kind === "pat" ? github.login ?? null : github.account ?? null } : null,
		githubInstallUrl,
	});
}

/**
 * The GitHub tools, and the credential they act with.
 *
 * A personal token is checked against GitHub before it is stored, so a typo is
 * caught here rather than by the first tool call a model makes, and it is the
 * only thing in this Worker that reports whose account a token belongs to.
 */
async function handleMcpGitHub(
	request: HttpServerRequest.HttpServerRequest,
	form: Schema.Schema.Type<typeof McpServerRequestSchema>,
): Promise<HttpServerResponse.HttpServerResponse> {
	const session = await readSession(request);
	if (!session) return json({ error: "Please sign in again." }, 401);

	if (form.action === "disconnect") {
		await writeGitHubConnection(env, session.uid, undefined);
		await refreshGateway(session.uid);
		return json({ ok: true, message: "The GitHub tools are off." });
	}

	const token = form.token?.trim();
	if (!token) return json({ error: "Paste a personal access token, or install the app." }, 400);

	const response = await fetch("https://api.github.com/user", {
		headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "eryn" },
	}).catch(() => undefined);
	if (!response?.ok) {
		return json({ error: `GitHub rejected that token (HTTP ${response?.status ?? "unreachable"}).` }, 400);
	}
	const user = (await response.json().catch(() => ({}))) as { login?: unknown };
	const login = typeof user.login === "string" ? user.login : undefined;

	await writeGitHubConnection(env, session.uid, {
		kind: "pat",
		token,
		...(login ? { login } : {}),
		connectedAt: Date.now(),
	});
	await refreshGateway(session.uid);
	return json({ ok: true, message: `Connected as ${login ?? "your account"}.` });
}

/**
 * Turn the Discord tools on or off for one account.
 *
 * The account is the one already signed in — the console knows who this is, so
 * connecting asks for nothing but the decision. It matters that it is a
 * decision: the tools act as the bot, so they are as visible as the bot is,
 * rather than scoped to a single Discord server.
 */
async function handleMcpDiscord(
	request: HttpServerRequest.HttpServerRequest,
	form: Schema.Schema.Type<typeof McpServerRequestSchema>,
): Promise<HttpServerResponse.HttpServerResponse> {
	const session = await readSession(request);
	if (!session) return json({ error: "Please sign in again." }, 401);

	if (form.action === "disconnect") {
		await writeDiscordLink(env, session.uid, undefined);
		await refreshGateway(session.uid);
		return json({ ok: true, message: "The Discord tools are off." });
	}

	await writeDiscordLink(env, session.uid, { id: session.uid, name: session.name, connectedAt: Date.now() });
	await refreshGateway(session.uid);
	return json({ ok: true, message: "The Discord tools are on." });
}

/**
 * The remote MCP servers the signed-in user has connected.
 *
 * These belong to the person, not to a server, so they are configured on the
 * MCP page and follow them into every Discord server they run Eryn in. Nothing
 * here talks to a guild, and no credential is ever returned to the browser.
 */
async function handleMcpServers(
	request: HttpServerRequest.HttpServerRequest,
	form: Schema.Schema.Type<typeof McpServerRequestSchema>,
): Promise<HttpServerResponse.HttpServerResponse> {
	const session = await readSession(request);
	if (!session) return json({ error: "Please sign in again." }, 401);

	const servers = await readMcpServers(env, session.uid);

	if (form.action === "add") {
		const url = form.url?.trim();
		const name = form.name?.trim() || (url ? new URL(url).hostname : "");
		if (!url) return json({ error: "A URL is needed." }, 400);
		if (!name) return json({ error: "A name is needed." }, 400);
		try {
			const parsed = new URL(url);
			// A Worker can only reach a public origin; anything else would fail at
			// the first call rather than here, which is a worse place to find out.
			if (parsed.protocol !== "https:") return json({ error: "An MCP server must be reached over https." }, 400);
		} catch {
			return json({ error: "That is not a URL." }, 400);
		}
		if (servers.some((server) => server.name === name)) {
			return json({ error: `A server named ${name} is already connected.` }, 400);
		}
		const record: McpServerRecord = { id: newServerId(), name, url, enabled: true, createdAt: Date.now() };
		await writeMcpServers(env, session.uid, [...servers, record]);
		await refreshGateway(session.uid);
		return json({ ok: true, message: `${name} added.`, servers: [...servers, record].map(summarise) });
	}

	const target = servers.find((server) => server.id === form.id);
	if (!target) return json({ error: "That server is not connected." }, 404);

	if (form.action === "remove") {
		await writeMcpServers(env, session.uid, servers.filter((server) => server.id !== target.id));
		await refreshGateway(session.uid);
		return json({ ok: true, message: `${target.name} removed.` });
	}

	if (form.action === "enable" || form.action === "disable") {
		const enabled = form.action === "enable";
		await writeMcpServers(
			env,
			session.uid,
			servers.map((server) => (server.id === target.id ? { ...server, enabled } : server)),
		);
		await refreshGateway(session.uid);
		return json({ ok: true, message: `${target.name} ${enabled ? "enabled" : "disabled"}.` });
	}

	if (form.action === "tools") {
		// A live call, so the dashboard shows what the server actually offers
		// rather than what it was believed to offer when it was added.
		try {
			const { token } = await ensureToken(target);
			const tools = await listTools({ url: target.url, token });
			return json({
				ok: true,
				tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? "" })),
			});
		} catch (error) {
			if (error instanceof McpUnauthorized) return json({ error: "That server needs a sign-in first." }, 400);
			return json({ error: describe(error) }, 502);
		}
	}

	return json({ error: "unknown action" }, 400);
}

/**
 * Start an MCP server's sign-in.
 *
 * The pending attempt is a signed cookie rather than a row: it holds the PKCE
 * verifier and the client we registered, and it is the only thing the callback
 * needs to finish the exchange.
 */
async function handleMcpOAuthStart(
	request: HttpServerRequest.HttpServerRequest,
	form: Schema.Schema.Type<typeof McpServerRequestSchema>,
): Promise<HttpServerResponse.HttpServerResponse> {
	const session = await readSession(request);
	if (!session) return json({ error: "Please sign in again." }, 401);

	const servers = await readMcpServers(env, session.uid);
	const target = servers.find((server) => server.id === form.id);
	if (!target) return json({ error: "That server is not connected." }, 404);

	const origin = new URL(request.originalUrl).origin;
	try {
		const authorization = await discover(target.url, { token: target.auth?.accessToken });
		const redirectUri = `${origin}${MCP_OAUTH_CALLBACK}`;
		// A server we have already registered with keeps the same client, so a
		// second sign-in does not litter the authorization server with clients.
		const client = target.auth
			? { clientId: target.auth.clientId, ...(target.auth.clientSecret ? { clientSecret: target.auth.clientSecret } : {}) }
			: await registerMcpClient(authorization, redirectUri);
		const state = newState();
		const { url, verifier } = await beginAuthorization({
			authorization,
			clientId: client.clientId,
			redirectUri,
			state,
			...(authorization.scopesSupported?.length ? { scope: authorization.scopesSupported.join(" ") } : {}),
		});

		const pending: PendingMcpOAuth = {
			typ: "mcp-oauth",
			userId: session.uid,
			serverId: target.id,
			verifier,
			state,
			redirectUri,
			client,
			authorization,
			exp: Date.now() + MCP_OAUTH_TTL_MS,
		};
		return HttpServerResponse.setCookieUnsafe(
			HttpServerResponse.jsonUnsafe({ ok: true, url }),
			MCP_OAUTH_COOKIE,
			await sign(pending, env.SESSION_SECRET),
			{ ...cookieOptions(origin), expires: new Date(pending.exp) },
		);
	} catch (error) {
		return json({ error: describe(error) }, 502);
	}
}

/** Finish an MCP server's sign-in, and store the tokens it issued. */
async function handleMcpOAuthCallback(
	request: HttpServerRequest.HttpServerRequest,
): Promise<HttpServerResponse.HttpServerResponse> {
	const url = new URL(request.originalUrl);
	const origin = url.origin;
	const pending = await verify<PendingMcpOAuth>(request.cookies?.[MCP_OAUTH_COOKIE], env.SESSION_SECRET);
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	if (!pending || pending.exp < Date.now() || !code || state !== pending.state) {
		return mcpRedirect(origin, "error", "That MCP sign-in could not be verified. Start it again from the console.");
	}

	try {
		const tokens = await exchangeMcpCode({
			authorization: pending.authorization,
			client: pending.client,
			code,
			verifier: pending.verifier,
			redirectUri: pending.redirectUri,
		});
		const servers = await readMcpServers(env, pending.userId);
		await writeMcpServers(
			env,
			pending.userId,
			servers.map((server) =>
				server.id === pending.serverId
					? {
							...server,
							enabled: true,
							auth: {
								...pending.client,
								authorization: pending.authorization,
								accessToken: tokens.accessToken,
								...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
								...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
							},
						}
					: server,
			),
		);
		await refreshGateway(pending.userId);
	} catch (error) {
		return mcpRedirect(origin, "error", describe(error));
	}

	return HttpServerResponse.expireCookieUnsafe(MCP_OAUTH_COOKIE, cookieOptions(origin))(
		HttpServerResponse.redirect(`/console/mcp?ok=${encodeURIComponent("Signed in to that MCP server.")}`),
	);
}

/** Back to the MCP page with a notice, which is where a sign-in starts. */
function mcpRedirect(origin: string, kind: "ok" | "error", message: string): HttpServerResponse.HttpServerResponse {
	return HttpServerResponse.redirect(`${origin}/console/mcp?${kind}=${encodeURIComponent(message)}`);
}

// --- MCP ----------------------------------------------------------------------

/** The origin a request arrived on. The MCP advertises itself per origin. */
function originOf(request: HttpServerRequest.HttpServerRequest): string {
	return new URL(request.originalUrl).origin;
}

/** JSON-shaped OAuth failures, which is what the register and token endpoints return. */
function oauthFailure(error: unknown): HttpServerResponse.HttpServerResponse {
	if (error instanceof OAuthError) return json({ error: error.code, error_description: error.message }, error.status);
	return json({ error: "server_error", error_description: describe(error) }, 500);
}

function mcpSecret(): string | undefined {
	return env.SESSION_SECRET?.trim() || undefined;
}

function mcpNotConfigured(): HttpServerResponse.HttpServerResponse {
	return json({ error: "server_error", error_description: "The MCP is not configured on this deployment." }, 500);
}

/** RFC 7591 dynamic client registration. */
async function handleRegister(text: string, secret: string): Promise<HttpServerResponse.HttpServerResponse> {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return json({ error: "invalid_client_metadata", error_description: "The body was not valid JSON." }, 400);
	}
	return json(await registerClient(body, secret), 201);
}

/** The token endpoint: authorization_code and refresh_token grants. */
async function handleToken(
	base: string,
	text: string,
	secret: string,
): Promise<HttpServerResponse.HttpServerResponse> {
	const form = new URLSearchParams(text);
	const grant = form.get("grant_type");
	if (grant === "authorization_code") return json(await exchangeAuthorizationCode(base, form, secret));
	if (grant === "refresh_token") return json(await exchangeRefreshToken(base, form, secret));
	throw new OAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported.");
}

/** Describe an authorization request so the console can render consent. */
async function handleAuthorizeDescribe(
	request: HttpServerRequest.HttpServerRequest,
): Promise<HttpServerResponse.HttpServerResponse> {
	const secret = mcpSecret();
	if (!secret) return mcpNotConfigured();
	const base = originOf(request);
	const params = readAuthorizeParams(new URL(request.originalUrl).searchParams);
	try {
		const consent = await inspectAuthorization(base, params, secret);
		return json({
			ok: true,
			client: consent.client.name,
			scope: consent.scope,
			resource: consent.resource ?? resourceUrl(base),
		});
	} catch (error) {
		if (error instanceof OAuthError) {
			return json({ ok: false, error: error.code, description: error.message }, error.status);
		}
		throw error;
	}
}

/** Approve or deny a consent request, returning the URL to hand back to the client. */
async function handleAuthorizeDecide(
	request: HttpServerRequest.HttpServerRequest,
	text: string,
): Promise<HttpServerResponse.HttpServerResponse> {
	const secret = mcpSecret();
	if (!secret) return mcpNotConfigured();
	let body: { approve?: boolean; query?: string };
	try {
		body = JSON.parse(text) as typeof body;
	} catch {
		return json({ ok: false, error: "invalid_request", description: "The body was not valid JSON." }, 400);
	}
	const base = originOf(request);
	const params = readAuthorizeParams(new URLSearchParams(body.query ?? ""));
	let consent: ConsentRequest;
	try {
		consent = await inspectAuthorization(base, params, secret);
	} catch (error) {
		if (error instanceof OAuthError) {
			return json({ ok: false, error: error.code, description: error.message }, error.status);
		}
		throw error;
	}
	if (body.approve === false) return json({ ok: true, redirect: denyAuthorization(consent) });
	// Discord sign-in is optional: the MCP is useful on its own, and the only
	// tool today is a random number generator. Once Discord/GitHub tools land,
	// approval must require the matching account to be linked.
	const session = await readSession(request);
	const { redirect } = await approveAuthorization(consent, session?.uid ?? "anonymous", secret);
	return json({ ok: true, redirect });
}

/**
 * Reject unauthenticated `/mcp` requests before they reach the MCP layer, with
 * the `WWW-Authenticate` challenge that starts OAuth discovery. Intercepting
 * here keeps the MCP layer itself free of authentication concerns.
 */
/**
 * A browser preflight carries no credential, and the object a request would
 * reach is the one its token names — so there is nothing to route it to and it
 * is answered here.
 */
function mcpPreflight(request: Request): Response {
	const origin = request.headers.get("origin");
	const headers = new Headers({
		"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
		"access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version, accept",
		"access-control-max-age": "86400",
	});
	if (origin && allowedOrigins().includes(origin)) {
		headers.set("access-control-allow-origin", origin);
		headers.set("vary", "origin");
	}
	return new Response(null, { status: 204, headers });
}

/**
 * Authenticate the MCP endpoint, then hand it to the caller's own gateway.
 *
 * The token's subject is the Discord user the caller acts for: an external
 * harness gets its own, and Eryn's sessions get the guild owner's. That is what
 * makes one URL safe — the tools a caller sees are the ones in the object it is
 * routed to, and nothing else's.
 */
async function routeMcp(request: Request): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (url.pathname !== MCP_PATH) return undefined;
	if (request.method === "OPTIONS") return mcpPreflight(request);

	const secret = mcpSecret();
	const token = bearerToken(request);
	const grant = secret ? await verifyAccessToken(token, secret).catch(() => undefined) : undefined;
	if (!grant) {
		return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }), {
			status: 401,
			headers: {
				"content-type": "application/json",
				"www-authenticate": challenge(url.origin, token ? "invalid_token" : undefined),
			},
		});
	}
	return await env.MCP.get(env.MCP.idFromName(grant.sub)).fetch(request);
}

/**
 * Tell a user's gateway that its configuration changed.
 *
 * The object re-reads the registry on its next request anyway; this is so a
 * harness holding a stream open hears about it now rather than then.
 */
async function refreshGateway(userId: string): Promise<void> {
	await env.MCP.get(env.MCP.idFromName(userId))
		.fetch("https://eryn.internal/mcp/refresh", { method: "POST" })
		.catch(() => undefined);
}

// --- PostHog proxy ------------------------------------------------------------

const POSTHOG_DEFAULT_INGEST = "https://us.i.posthog.com";
const POSTHOG_DEFAULT_ASSETS = "https://us-assets.i.posthog.com";

/**
 * Reverse-proxy PostHog ingestion through this origin.
 *
 * Pointing `api_host` at `/ingest` makes analytics requests first-party, which
 * is what keeps them out of ad blockers' blocklists. Everything under `/ingest`
 * is forwarded verbatim; `/ingest/static/*` goes to the asset host that serves
 * session replay and the toolbar, everything else to the ingestion host.
 *
 * An empty `POSTHOG_KEY` disables analytics, and with it this proxy.
 */
async function proxyPostHog(request: Request, env: Env): Promise<Response> {
	if (!env.POSTHOG_KEY?.trim()) return new Response("Not found", { status: 404 });

	const url = new URL(request.url);
	const path = `${url.pathname.slice("/ingest".length)}${url.search}`;
	const ingest = env.POSTHOG_INGEST_HOST?.trim() || POSTHOG_DEFAULT_INGEST;
	const assets = env.POSTHOG_ASSETS_HOST?.trim() || POSTHOG_DEFAULT_ASSETS;
	const upstream = new URL(path, path.startsWith("/static/") ? assets : ingest);

	// Never forward our own cookies or credentials to a third party.
	const headers = new Headers(request.headers);
	headers.delete("cookie");
	headers.delete("authorization");
	headers.delete("host");

	const init: RequestInit = { method: request.method, headers, redirect: "manual" };
	if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;

	const response = await fetch(upstream, init);
	// The runtime hands back a decoded body, so a forwarded content-encoding or
	// content-length would describe bytes that no longer match.
	const out = new Headers(response.headers);
	out.delete("content-encoding");
	out.delete("content-length");
	out.delete("transfer-encoding");
	out.delete("set-cookie");
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}

// --- Routes -------------------------------------------------------------------

const Routes = Layer.mergeAll(
	HttpRouter.add("GET", "/health", HttpServerResponse.jsonUnsafe({ ok: true, service: "eryn" })),
	HttpRouter.add("GET", "/api/session", (request) => handleSession(request)),
	HttpRouter.add("GET", "/api/config", Effect.sync(() => handleConfig())),
	HttpRouter.add("GET", "/api/setup", (request) =>
		Effect.promise(() => handleSetupGet(request).catch((error) => setupFailure(error))),
	),
	HttpRouter.add("POST", "/api/setup", (request) =>
		Effect.gen(function* () {
			const form = yield* HttpServerRequest.schemaBodyJson(SetupRequestSchema).pipe(Effect.orElseSucceed(() => undefined));
			if (!form) return json({ error: "The request could not be read." }, 400);
			return yield* Effect.promise(() => handleSetupPost(request, form).catch((error) => setupFailure(error)));
		}),
	),
	HttpRouter.add("POST", "/api/models", (request) =>
		Effect.gen(function* () {
			const form = yield* HttpServerRequest.schemaBodyJson(ModelsRequestSchema).pipe(Effect.orElseSucceed(() => undefined));
			if (!form) return json({ error: "The request could not be read." }, 400);
			return yield* Effect.promise(() => handleModels(request, form.guild_id).catch((error) => setupFailure(error)));
		}),
	),
	HttpRouter.add("POST", "/api/providers", (request) =>
		Effect.gen(function* () {
			const form = yield* HttpServerRequest.schemaBodyJson(ModelsRequestSchema).pipe(Effect.orElseSucceed(() => undefined));
			if (!form) return json({ error: "The request could not be read." }, 400);
			return yield* Effect.promise(() => handleProviders(request, form.guild_id).catch((error) => setupFailure(error)));
		}),
	),
	HttpRouter.add("POST", "/api/oauth", (request) =>
		Effect.gen(function* () {
			const form = yield* HttpServerRequest.schemaBodyJson(OAuthRequestSchema).pipe(Effect.orElseSucceed(() => undefined));
			if (!form) return json({ error: "The request could not be read." }, 400);
			return yield* Effect.promise(() => handleOAuth(request, form).catch((error) => setupFailure(error)));
		}),
	),
	HttpRouter.add("GET", "/api/mcp/servers", (request) =>
		Effect.promise(() => handleMcpServerList(request).catch((error) => setupFailure(error))),
	),
	HttpRouter.add("POST", "/api/mcp/servers", (request) =>
		Effect.gen(function* () {
			const form = yield* HttpServerRequest.schemaBodyJson(McpServerRequestSchema).pipe(Effect.orElseSucceed(() => undefined));
			if (!form) return json({ error: "The request could not be read." }, 400);
			return yield* Effect.promise(() => handleMcpServers(request, form).catch((error) => setupFailure(error)));
		}),
	),
	HttpRouter.add("POST", "/api/mcp/servers/oauth", (request) =>
		Effect.gen(function* () {
			const form = yield* HttpServerRequest.schemaBodyJson(McpServerRequestSchema).pipe(Effect.orElseSucceed(() => undefined));
			if (!form) return json({ error: "The request could not be read." }, 400);
			return yield* Effect.promise(() => handleMcpOAuthStart(request, form).catch((error) => setupFailure(error)));
		}),
	),
	HttpRouter.add("POST", "/api/mcp/discord", (request) =>
		Effect.gen(function* () {
			const form = yield* HttpServerRequest.schemaBodyJson(McpServerRequestSchema).pipe(Effect.orElseSucceed(() => undefined));
			if (!form) return json({ error: "The request could not be read." }, 400);
			return yield* Effect.promise(() => handleMcpDiscord(request, form).catch((error) => setupFailure(error)));
		}),
	),
	HttpRouter.add("POST", "/api/mcp/github", (request) =>
		Effect.gen(function* () {
			const form = yield* HttpServerRequest.schemaBodyJson(McpServerRequestSchema).pipe(Effect.orElseSucceed(() => undefined));
			if (!form) return json({ error: "The request could not be read." }, 400);
			return yield* Effect.promise(() => handleMcpGitHub(request, form).catch((error) => setupFailure(error)));
		}),
	),
	HttpRouter.add("GET", MCP_OAUTH_CALLBACK, (request) =>
		Effect.promise(() => handleMcpOAuthCallback(request).catch((error) => setupFailure(error))),
	),
	HttpRouter.add("GET", "/auth/discord", (request) =>
		Effect.promise(() => handleDiscordAuth(request).catch((error) => json({ error: describe(error) }, 500))),
	),
	HttpRouter.add("GET", "/auth/callback", (request) =>
		Effect.promise(() => handleDiscordCallback(request).catch((error) => setupFailure(error))),
	),
	HttpRouter.add("GET", "/auth/logout", (request) => Effect.sync(() => handleLogout(request))),
	HttpRouter.add("GET", "/github/callback", (request) =>
		Effect.promise(() => handleGitHubCallback(request).catch((error) => setupFailure(error))),
	),

	// --- MCP: discovery, registration, consent, and the endpoint itself -------
	// Both protected-resource URLs are published because clients disagree on
	// whether the resource path belongs in the well-known path.
	HttpRouter.add("GET", PRM_PATHS[0], (request) =>
		Effect.sync(() => json(protectedResourceMetadata(originOf(request)))),
	),
	HttpRouter.add("GET", PRM_PATHS[1], (request) =>
		Effect.sync(() => json(protectedResourceMetadata(originOf(request)))),
	),
	HttpRouter.add("GET", AS_METADATA_PATH, (request) =>
		Effect.sync(() => json(authorizationServerMetadata(originOf(request)))),
	),
	HttpRouter.add("POST", REGISTER_PATH, (request) =>
		Effect.gen(function* () {
			const secret = mcpSecret();
			if (!secret) return mcpNotConfigured();
			const text = yield* request.text;
			return yield* Effect.promise(() => handleRegister(text, secret).catch((error) => oauthFailure(error)));
		}),
	),
	HttpRouter.add("POST", TOKEN_PATH, (request) =>
		Effect.gen(function* () {
			const secret = mcpSecret();
			if (!secret) return mcpNotConfigured();
			const base = originOf(request);
			const text = yield* request.text;
			return yield* Effect.promise(() => handleToken(base, text, secret).catch((error) => oauthFailure(error)));
		}),
	),
	HttpRouter.add("GET", "/api/mcp/authorize", (request) =>
		Effect.promise(() => handleAuthorizeDescribe(request).catch((error) => oauthFailure(error))),
	),
	HttpRouter.add("POST", "/api/mcp/authorize", (request) =>
		Effect.gen(function* () {
			const text = yield* request.text;
			return yield* Effect.promise(() => handleAuthorizeDecide(request, text).catch((error) => oauthFailure(error)));
		}),
	),
).pipe(Layer.provide(HttpServer.layerServices));

// The Workers scheduler is synchronous; see the `HttpRouter.toWebHandler` notes.
const SyncScheduler = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"));
const app = HttpRouter.toWebHandler(Layer.provideMerge(Routes, SyncScheduler));

/**
 * Make sure the singleton gateway object is running and connected.
 *
 * This is the only thing that wakes the gateway, and the gateway wakes itself
 * with an alarm; there is deliberately no per-minute cron, which would pay for
 * a Durable Object request every minute of every day.
 */
async function wake(env: Env): Promise<void> {
	const [, registry] = await Promise.all([
		env.GATEWAY.get(env.GATEWAY.idFromName("gateway")).fetch("https://eryn.internal/wake"),
		// The registry runs its one-off migrations the first time it is touched, so
		// touching it here applies them without waiting for a request to arrive.
		env.REGISTRY.get(env.REGISTRY.idFromName("registry")).fetch("https://eryn.internal/registry/migrate"),
	]).catch(() => [undefined, undefined]);
	const body = (await registry?.json().catch(() => ({}))) as { moved?: number } | undefined;
	if (body?.moved) console.log(`[eryn] refiled ${body.moved} key(s) to the OpenCode Console provider`);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		// The PostHog reverse proxy is a plain pipe; it never touches the app.
		if (new URL(request.url).pathname.startsWith("/ingest/")) {
			return await proxyPostHog(request, env).catch(
				(error) => new Response(`ingest proxy failed: ${describe(error)}`, { status: 502 }),
			);
		}
		// `/mcp` is authenticated before the MCP layer sees it, so the layer stays
		// concerned only with the protocol.
		const mcp = await routeMcp(request).catch(() => undefined);
		if (mcp) return mcp;
		const response = await app.handler(request);
		if (request.method === "GET" && new URL(request.url).pathname === "/health") {
			ctx.waitUntil(wake(env).catch(() => undefined));
		}
		return response;
	},

	scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
		ctx.waitUntil(wake(env).catch(() => undefined));
	},
} satisfies ExportedHandler<Env>;
