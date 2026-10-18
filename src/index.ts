/**
 * The Eryn Worker entry point.
 *
 * The UI is a client-only Solid app (built by Vite into static assets and
 * served by Cloudflare); this Worker is the API and auth surface behind it:
 * Discord OAuth, the GitHub App install callback, and the JSON endpoints the
 * setup page calls. It never renders HTML.
 */

import { env } from "cloudflare:workers";
import { Effect, Layer, Schema, Scheduler } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { CLIENT_ID, DEFAULT_MODEL, isValidModel } from "./config";
import { randomToken, sign, verify } from "./crypto";
import { discordRest } from "./discord/api";
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

// --- Routes -------------------------------------------------------------------

const Routes = Layer.mergeAll(
	HttpRouter.add("GET", "/health", HttpServerResponse.jsonUnsafe({ ok: true, service: "eryn" })),
	HttpRouter.add("GET", "/api/session", (request) => handleSession(request)),
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
).pipe(Layer.provide(HttpServer.layerServices));

// The Workers scheduler is synchronous; see the `HttpRouter.toWebHandler` notes.
const SyncScheduler = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"));
const app = HttpRouter.toWebHandler(Layer.provideMerge(Routes, SyncScheduler));

/** Make sure the singleton gateway object is running and connected. */
async function wake(env: Env): Promise<void> {
	await env.GATEWAY.get(env.GATEWAY.idFromName("gateway")).fetch("https://eryn.internal/wake");
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
