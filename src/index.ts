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
import { mcpServer } from "./mcp/server";
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
import { getGuildSummary, getUserGuilds, putGuild, putUserGuilds, removeGuild, setGuildInstallation } from "./registry-client";

export { ErynGateway } from "./gateway";
export { ErynSession } from "./agent";
export { ErynRegistry } from "./registry";

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
	api_key: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
	github_repo: Schema.optional(Schema.String),
});

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
	const state = await verify<{ guild: string; exp: number }>(url.searchParams.get("state") ?? undefined, env.SESSION_SECRET);
	if (!installationId || !state || state.exp < Date.now()) {
		return authError(url.origin, "That GitHub installation could not be verified.");
	}
	await setGuildInstallation(env, state.guild, installationId);
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
	const session = await readSession(request);
	if (!session) return json({ error: "Please sign in again." }, 401);

	// Re-check the guild against Discord rather than trusting the submitted id.
	const guilds = await manageableGuilds(session);
	if (!guilds.some((guild) => guild.id === form.guild_id && canManage(guild))) {
		return json({ error: "You cannot manage that server." }, 403);
	}

	// A server must be installed before it can be configured.
	const bot = discordRest(env.DISCORD_BOT_TOKEN?.trim() ?? "");
	const installed = new Set((await bot.guilds()).map((guild) => guild.id));
	if (!installed.has(form.guild_id)) {
		return json({ error: "Add Eryn to that server before configuring it." }, 400);
	}

	if (form.action === "remove") {
		await removeGuild(env, form.guild_id);
		return json({ ok: true, message: "The key was removed." });
	}

	const model = form.model?.trim() || DEFAULT_MODEL;
	if (!isValidModel(model)) return json({ error: "The model must be an opencode-go/<model> reference." }, 400);

	try {
		await putGuild(env, form.guild_id, {
			apiKey: form.api_key?.trim(),
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
async function guardMcp(request: Request): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (url.pathname !== MCP_PATH) return undefined;
	if (request.method === "OPTIONS") return undefined;
	const secret = mcpSecret();
	const token = bearerToken(request);
	const grant = secret ? await verifyAccessToken(token, secret).catch(() => undefined) : undefined;
	if (grant) return undefined;
	return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }), {
		status: 401,
		headers: {
			"content-type": "application/json",
			"www-authenticate": challenge(url.origin, token ? "invalid_token" : undefined),
		},
	});
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
	mcpServer,
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
	await env.GATEWAY.get(env.GATEWAY.idFromName("gateway")).fetch("https://eryn.internal/wake");
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
		const unauthorized = await guardMcp(request).catch(() => undefined);
		if (unauthorized) return unauthorized;
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
