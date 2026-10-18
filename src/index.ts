/**
 * The Eryn Worker entry point.
 *
 * HTTP is an Effect `HttpRouter` built once at module scope and adapted to the
 * Workers `fetch` handler. It serves the public site: the landing page, the
 * Discord sign-in, and the setup pages where a guild admin links their own
 * OpenCode Go key. Discord traffic never touches this surface — the gateway and
 * per-thread agents live in Durable Objects, and the editor credential registry
 * is reachable only through the Durable Object binding.
 */

import { env } from "cloudflare:workers";
import { Effect, Layer, Schema, Scheduler } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { CLIENT_ID, DEFAULT_MODEL, isValidModel } from "./config";
import { randomToken, sign, verify } from "./crypto";
import { discordRest } from "./discord/api";
import { authorizeUrl, canManage, currentUser, DiscordApiError, exchangeCode, listUserGuilds, type DiscordGuild } from "./oauth";
import { getGuildSummary, getUserGuilds, putGuild, putUserGuilds, removeGuild } from "./registry-client";
import { landingPage, noticeHtml, setupPage, signInPage, type SetupGuild } from "./views";

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

/** Fields submitted by the setup form. */
interface SetupForm {
	action: string;
	guild_id: string;
	api_key?: string;
	model?: string;
}

const SetupFormSchema = Schema.Struct({
	action: Schema.String,
	guild_id: Schema.String,
	api_key: Schema.optional(Schema.String),
	model: Schema.optional(Schema.String),
});

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A full HTML notice as an Effect HTTP response. */
function notice(title: string, message: string, status = 200): HttpServerResponse.HttpServerResponse {
	return HttpServerResponse.setStatus(status)(HttpServerResponse.html(noticeHtml(title, message)));
}

/** A friendly page for the common Discord failure, or a generic one. */
function setupFailure(error: unknown): HttpServerResponse.HttpServerResponse {
	if (error instanceof DiscordApiError && error.status === 429) {
		return notice(
			"Discord is busy",
			"Discord rate-limited that request. Wait a few seconds, then refresh this page.",
			429,
		);
	}
	return notice("Setup failed", describe(error), 500);
}

/**
 * The guilds manageable by the signed-in user. Discord rate-limits the
 * bearer-token guild route, so the result is cached for a few minutes and only
 * fetched when the cache is cold.
 */
async function manageableGuilds(session: Session): Promise<DiscordGuild[]> {
	const cached = await getUserGuilds(env, session.uid).catch(() => undefined);
	if (cached) return cached;
	const fetched = await listUserGuilds(session.token);
	await putUserGuilds(env, session.uid, fetched).catch(() => undefined);
	return fetched;
}

/** Cookie defaults; `secure` is dropped only for a local http origin. */
function cookieOptions(origin: string) {
	return {
		httpOnly: true,
		secure: origin.startsWith("https:"),
		sameSite: "lax" as const,
		path: "/",
	};
}

async function readSession(request: HttpServerRequest.HttpServerRequest): Promise<Session | undefined> {
	const session = await verify<Session>(request.cookies?.[SESSION_COOKIE], env.SESSION_SECRET);
	if (!session || session.exp < Date.now()) return undefined;
	return session;
}

function noticeFromQuery(url: URL): { kind: "ok" | "error"; message: string } | undefined {
	const ok = url.searchParams.get("ok");
	if (ok) return { kind: "ok", message: ok };
	const error = url.searchParams.get("error");
	if (error) return { kind: "error", message: error };
	return undefined;
}

// --- Handlers -----------------------------------------------------------------

async function handleDiscordAuth(request: HttpServerRequest.HttpServerRequest): Promise<HttpServerResponse.HttpServerResponse> {
	const origin = new URL(request.originalUrl).origin;
	if (!env.DISCORD_CLIENT_SECRET) {
		return notice("Not configured", "Discord sign-in is not configured on this deployment.", 503);
	}
	const state = randomToken(16);
	const value = await sign({ state }, env.SESSION_SECRET);
	const response = HttpServerResponse.redirect(authorizeUrl({ origin, clientId: CLIENT_ID, state }));
	return HttpServerResponse.setCookieUnsafe(response, STATE_COOKIE, value, {
		...cookieOptions(origin),
		expires: new Date(Date.now() + STATE_TTL_MS),
	});
}

async function handleDiscordCallback(request: HttpServerRequest.HttpServerRequest): Promise<HttpServerResponse.HttpServerResponse> {
	const url = new URL(request.originalUrl);
	const origin = url.origin;
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const expected = await verify<{ state: string }>(request.cookies?.[STATE_COOKIE], env.SESSION_SECRET);
	const clientSecret = env.DISCORD_CLIENT_SECRET;
	if (!code || !state || !expected || expected.state !== state || !clientSecret) {
		return notice("Sign-in failed", "That Discord sign-in could not be verified. Please try again.", 400);
	}

	const token = await exchangeCode({ origin, clientId: CLIENT_ID, clientSecret, code });
	const account = await currentUser(token.access_token);
	const session: Session = {
		uid: account.id,
		name: account.global_name || account.username,
		token: token.access_token,
		exp: Date.now() + SESSION_TTL_MS,
	};
	const value = await sign(session, env.SESSION_SECRET);
	const response = HttpServerResponse.setCookieUnsafe(
		HttpServerResponse.redirect("/setup"),
		SESSION_COOKIE,
		value,
		{ ...cookieOptions(origin), expires: new Date(session.exp) },
	);
	return HttpServerResponse.expireCookieUnsafe(STATE_COOKIE, cookieOptions(origin))(response);
}

async function handleLogout(request: HttpServerRequest.HttpServerRequest): Promise<HttpServerResponse.HttpServerResponse> {
	const origin = new URL(request.originalUrl).origin;
	return HttpServerResponse.expireCookieUnsafe(SESSION_COOKIE, cookieOptions(origin))(
		HttpServerResponse.redirect("/"),
	);
}

async function handleSetupGet(request: HttpServerRequest.HttpServerRequest): Promise<HttpServerResponse.HttpServerResponse> {
	const url = new URL(request.originalUrl);
	const notice = noticeFromQuery(url);
	const session = await readSession(request);
	if (!session) return HttpServerResponse.html(signInPage({ notice }));

	const userGuilds = await manageableGuilds(session);
	const manageable = userGuilds.filter(canManage);
	const bot = discordRest(env.DISCORD_BOT_TOKEN?.trim() ?? "");
	const installed = new Set((await bot.guilds()).map((guild) => guild.id));
	const guilds: SetupGuild[] = await Promise.all(
		manageable.map(async (guild) => {
			const summary = await getGuildSummary(env, guild.id);
			return {
				id: guild.id,
				name: guild.name,
				icon: guild.icon,
				installed: installed.has(guild.id),
				configured: summary.configured,
				model: summary.model,
				updatedAt: summary.updatedAt,
			};
		}),
	);
	// Configured servers first, then installed ones, then the rest by name.
	guilds.sort(
		(a, b) =>
			Number(b.configured) - Number(a.configured) ||
			Number(b.installed) - Number(a.installed) ||
			a.name.localeCompare(b.name),
	);

	return HttpServerResponse.html(setupPage({ account: { id: session.uid, name: session.name }, guilds, notice }));
}

async function handleSetupPost(
	request: HttpServerRequest.HttpServerRequest,
	form: SetupForm,
): Promise<HttpServerResponse.HttpServerResponse> {
	const session = await readSession(request);
	if (!session) return HttpServerResponse.redirect("/setup");

	// Re-check the guild against Discord rather than trusting the submitted id.
	const guilds = await manageableGuilds(session);
	if (!guilds.some((guild) => guild.id === form.guild_id && canManage(guild))) {
		return HttpServerResponse.redirect(`/setup?error=${encodeURIComponent("You cannot manage that server.")}`);
	}

	if (form.action === "remove") {
		await removeGuild(env, form.guild_id);
		return HttpServerResponse.redirect(`/setup?ok=${encodeURIComponent("The key was removed.")}`);
	}

	const model = form.model?.trim() || DEFAULT_MODEL;
	if (!isValidModel(model)) {
		return HttpServerResponse.redirect(
			`/setup?error=${encodeURIComponent("The model must be an opencode-go/<model> reference.")}`,
		);
	}

	try {
		await putGuild(env, form.guild_id, { apiKey: form.api_key?.trim(), model, configuredBy: session.uid });
	} catch (error) {
		return HttpServerResponse.redirect(`/setup?error=${encodeURIComponent(describe(error))}`);
	}
	return HttpServerResponse.redirect(`/setup?ok=${encodeURIComponent("The key was saved.")}`);
}

// --- Routes -------------------------------------------------------------------

const Routes = Layer.mergeAll(
	HttpRouter.add("GET", "/", HttpServerResponse.html(landingPage())),
	HttpRouter.add("GET", "/health", HttpServerResponse.jsonUnsafe({ ok: true, service: "eryn" })),
	HttpRouter.add("GET", "/auth/discord", (request) =>
		Effect.promise(() =>
			handleDiscordAuth(request).catch((error) =>
				notice("Sign-in failed", describe(error), 500),
			),
		),
	),
	HttpRouter.add("GET", "/auth/callback", (request) =>
		Effect.promise(() =>
			handleDiscordCallback(request).catch((error) =>
				notice("Sign-in failed", describe(error), 400),
			),
		),
	),
	HttpRouter.add("GET", "/auth/logout", (request) => Effect.promise(() => handleLogout(request))),
	HttpRouter.add("GET", "/setup", (request) =>
		Effect.promise(() => handleSetupGet(request).catch((error) => setupFailure(error))),
	),
	HttpRouter.add("POST", "/setup", (request) =>
		Effect.gen(function* () {
			const form = yield* HttpServerRequest.schemaBodyUrlParams(SetupFormSchema).pipe(
				Effect.orElseSucceed(() => undefined),
			);
			if (!form) return notice("Setup failed", "The form could not be read.", 400);
			return yield* Effect.promise(() => handleSetupPost(request, form).catch((error) => setupFailure(error)));
		}),
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
		if (request.method === "GET") {
			const { pathname } = new URL(request.url);
			if (pathname === "/" || pathname === "/health") ctx.waitUntil(wake(env).catch(() => undefined));
		}
		return response;
	},

	scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
		ctx.waitUntil(wake(env).catch(() => undefined));
	},
} satisfies ExportedHandler<Env>;
