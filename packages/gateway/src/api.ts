/**
 * The gateway's HTTP surface: the console's API, Discord sign-in, the account
 * OAuth callbacks, and the MCP authorization server's endpoints.
 *
 * It is an Effect `HttpRouter`. Anything that needs a user's object resolves the
 * session, picks the object by the Discord id, and calls it over the binding —
 * the session token never reaches storage, and the object never trusts a subject
 * that arrives from the internet.
 */

import { env } from "cloudflare:workers";
import { Effect, Layer, Schema, Scheduler } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
	DISCORD_CALLBACK_PATH,
	MCP_PATH,
	MCP_SCOPE,
	STATE_TTL_MS,
	TOOL_GROUPS,
	TOOL_GROUP_NAMES,
} from "./config";
import { CLIENT_ID } from "./discord-ids";
import {
	exchangeGitHubCode,
	exchangeGoogleCode,
	fetchDiscordProfile,
	fetchGitHubProfile,
	fetchGoogleProfile,
	githubAuthorizeUrl,
	googleAuthorizeUrl,
	providerName,
} from "./account-oauth";
import { authorizeUrl, canManage, currentUser, exchangeCode, listUserGuilds, type DiscordGuild } from "./discord-oauth";
import { EMPTY_ACCESS, ToolAccess, newId, slugify, type Account, type AccountSummary, type McpServer, type ServerSummary } from "./model";
import { AS_METADATA_PATH, PRM_PATHS, REGISTER_PATH, TOKEN_PATH, authorizationServerMetadata, protectedResourceMetadata } from "./mcp/oauth";
import { catalogForConsole } from "./tools/catalog";
import { cookieOptions, readSession, readState, sessionTtlMs, signSession, signState, SESSION_COOKIE, STATE_COOKIE, type Session } from "./session";
import { registerClient, exchangeAuthorizationCode, exchangeRefreshToken, inspectAuthorization, approveAuthorization, denyAuthorization, readAuthorizeParams, OAuthError } from "./mcp/oauth";

function json(body: unknown, status = 200): HttpServerResponse.HttpServerResponse {
	return HttpServerResponse.setStatus(status)(HttpServerResponse.jsonUnsafe(body));
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A JSON-shaped OAuth failure, which is what the register and token endpoints return. */
function oauthFailure(error: unknown): HttpServerResponse.HttpServerResponse {
	if (error instanceof OAuthError) return json({ error: error.code, error_description: error.message }, error.status);
	return json({ error: "server_error", error_description: describe(error) }, 500);
}

/**
 * Run an async handler so a rejection is a JSON response rather than a defect.
 *
 * An Effect that dies takes the whole response with it, which reads to a caller
 * as an empty 500; a guard keeps the message the handler actually had.
 */
function safe(run: () => Promise<HttpServerResponse.HttpServerResponse>): Effect.Effect<HttpServerResponse.HttpServerResponse> {
	return Effect.promise(async () => {
		try {
			return await run();
		} catch (error) {
			return json({ error: describe(error) }, 500);
		}
	});
}

function originOf(request: HttpServerRequest.HttpServerRequest): string {
	return new URL(request.originalUrl).origin;
}

function redirect(to: string): HttpServerResponse.HttpServerResponse {
	return HttpServerResponse.redirect(to);
}

/** The cookies a request carries, as a plain record. */
function cookies(request: HttpServerRequest.HttpServerRequest): Record<string, string> {
	return request.cookies ?? {};
}

async function sessionOf(request: HttpServerRequest.HttpServerRequest): Promise<Session | undefined> {
	return await readSession(cookies(request), env.SESSION_SECRET?.trim());
}

function userStub(uid: string): DurableObjectStub {
	const binding = env.GATEWAY_USER;
	return binding.get(binding.idFromName(uid));
}

/** Call a storage route on a user's object. */
async function callUser<T>(uid: string, path: string, init?: RequestInit): Promise<T> {
	const response = await userStub(uid).fetch(`https://gateway.internal${path}`, init);
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `the gateway refused the request (HTTP ${response.status})`);
	}
	return (await response.json()) as T;
}

// --- Request schemas -----------------------------------------------------------

const AccountsRequest = Schema.Struct({
	action: Schema.String,
	id: Schema.optional(Schema.String),
	label: Schema.optional(Schema.String),
	token: Schema.optional(Schema.String),
});

const ServersRequest = Schema.Struct({
	action: Schema.String,
	id: Schema.optional(Schema.String),
	name: Schema.optional(Schema.String),
	title: Schema.optional(Schema.String),
	enabled: Schema.optional(Schema.Boolean),
	accountIds: Schema.optional(Schema.Array(Schema.String)),
	tools: Schema.optional(ToolAccess),
	guildId: Schema.optional(Schema.String),
});

function parseBody<S extends Schema.ConstraintDecoder<unknown>>(
	request: HttpServerRequest.HttpServerRequest,
	schema: S,
): Effect.Effect<S["Type"] | undefined> {
	return request.json.pipe(
		Effect.map((body) => {
			try {
				return Schema.decodeSync(schema)(body);
			} catch {
				return undefined;
			}
		}),
		Effect.orElseSucceed(() => undefined),
	);
}

// --- Accounts ------------------------------------------------------------------

function summariseAccount(account: Account): AccountSummary {
	return { id: account.id, provider: account.provider, label: account.label, profile: account.profile, createdAt: account.createdAt };
}

function providers() {
	const githubOauth = Boolean(env.GITHUB_OAUTH_CLIENT_ID?.trim() && env.GITHUB_OAUTH_CLIENT_SECRET?.trim());
	const google = Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
	return [
		{ id: "discord", name: providerName("discord"), connect: ["oauth"], configured: true },
		{ id: "github", name: providerName("github"), connect: githubOauth ? ["oauth", "pat"] : ["pat"], configured: true },
		{ id: "google", name: providerName("google"), connect: ["oauth"], configured: google },
	];
}

function newAccount(provider: Account["provider"], label: string, profile: Account["profile"], credential: Account["credential"]): Account {
	return { id: newId("acc"), provider, label, profile, credential, createdAt: Date.now() };
}

function handleAccountsGet(request: HttpServerRequest.HttpServerRequest) {
	return safe(async () => {
		const session = await sessionOf(request);
		if (!session) return json({ signedIn: false, accounts: [], providers: providers() });
		const { accounts } = await callUser<{ accounts: Account[] }>(session.uid, "/store/accounts");
		return json({ signedIn: true, accounts: accounts.map(summariseAccount).sort(byProvider), providers: providers() });
	});
}

function byProvider(a: AccountSummary, b: AccountSummary): number {
	return a.provider.localeCompare(b.provider) || a.createdAt - b.createdAt;
}

function handleAccountsPost(request: HttpServerRequest.HttpServerRequest, form: Schema.Schema.Type<typeof AccountsRequest>) {
	return safe(async () => {
		const session = await sessionOf(request);
		if (!session) return json({ error: "Please sign in again." }, 401);
		const origin = originOf(request);

		if (form.action === "add-discord") {
			const profile = await fetchDiscordProfile(session.token);
			const account = newAccount("discord", profile.name ?? profile.username, profile, { kind: "discord", token: session.token });
			await callUser(session.uid, "/store/account", { method: "PUT", body: JSON.stringify(account) });
			return json({ ok: true, account: summariseAccount(account) });
		}

		if (form.action === "add-github-pat") {
			const token = form.token?.trim();
			if (!token) return json({ error: "Paste a personal access token." }, 400);
			const profile = await fetchGitHubProfile(token).catch((error) => error as Error);
			if (profile instanceof Error) return json({ error: profile.message }, 400);
			const account = newAccount("github", profile.name ?? profile.username, profile, { kind: "github", token });
			await callUser(session.uid, "/store/account", { method: "PUT", body: JSON.stringify(account) });
			return json({ ok: true, account: summariseAccount(account) });
		}

		if (form.action === "start-github-oauth" || form.action === "start-google-oauth") {
			const provider = form.action === "start-github-oauth" ? "github" : "google";
			const clientId = provider === "github" ? env.GITHUB_OAUTH_CLIENT_ID?.trim() : env.GOOGLE_CLIENT_ID?.trim();
			if (!clientId) return json({ error: `${providerName(provider)} is not configured on this deployment.` }, 400);
			const redirectUri = `${origin}${provider === "github" ? "/github/callback" : "/google/callback"}`;
			const state = await signState({ uid: session.uid, provider }, env.SESSION_SECRET!);
			const url =
				provider === "github"
					? githubAuthorizeUrl({ clientId, redirectUri, state })
					: googleAuthorizeUrl({ clientId, redirectUri, state });
			return HttpServerResponse.setCookieUnsafe(json({ ok: true, url }), STATE_COOKIE, state, {
				...cookieOptions(origin),
				expires: new Date(Date.now() + STATE_TTL_MS),
			});
		}

		if (form.action === "unlink") {
			if (!form.id) return json({ error: "Which account?" }, 400);
			await callUser(session.uid, `/store/account?id=${encodeURIComponent(form.id)}`, { method: "DELETE" });
			return json({ ok: true });
		}

		if (form.action === "label") {
			if (!form.id) return json({ error: "Which account?" }, 400);
			const { accounts } = await callUser<{ accounts: Account[] }>(session.uid, "/store/accounts");
			const account = accounts.find((entry) => entry.id === form.id);
			if (!account) return json({ error: "That account is not connected." }, 404);
			const updated = { ...account, label: form.label?.trim() || account.label };
			await callUser(session.uid, "/store/account", { method: "PUT", body: JSON.stringify(updated) });
			return json({ ok: true, account: summariseAccount(updated) });
		}

		return json({ error: "unknown action" }, 400);
	});
}

// --- Hosted MCP servers --------------------------------------------------------

function handleServersGet(request: HttpServerRequest.HttpServerRequest) {
	return safe(async () => {
		const session = await sessionOf(request);
		if (!session) return json({ signedIn: false, servers: [] });
		return json({ signedIn: true, servers: await summaries(session.uid, originOf(request)) });
	});
}

async function summaries(uid: string, origin: string): Promise<ServerSummary[]> {
	const [{ servers }, { accounts }, { grants }] = await Promise.all([
		callUser<{ servers: McpServer[] }>(uid, "/store/servers"),
		callUser<{ accounts: Account[] }>(uid, "/store/accounts"),
		callUser<{ grants: { guildId: string; mcpServerId: string }[] }>(uid, "/store/grants"),
	]);
	return servers.map((server) => ({
		id: server.id,
		name: server.name,
		...(server.title ? { title: server.title } : {}),
		enabled: server.enabled,
		accounts: server.accountIds
			.map((id) => accounts.find((account) => account.id === id))
			.filter((account): account is Account => account !== undefined)
			.map((account) => ({
				id: account.id,
				provider: account.provider,
				label: account.label,
				...(account.profile.avatarUrl ? { avatarUrl: account.profile.avatarUrl } : {}),
			})),
		tools: server.tools,
		endpoint: `${origin}${MCP_PATH}/${server.name}`,
		grants: grants.filter((grant) => grant.mcpServerId === server.id).map((grant) => ({ guildId: grant.guildId })),
	}));
}

function handleServersPost(request: HttpServerRequest.HttpServerRequest, form: Schema.Schema.Type<typeof ServersRequest>) {
	return safe(async () => {
		const session = await sessionOf(request);
		if (!session) return json({ error: "Please sign in again." }, 401);
		const origin = originOf(request);
		const { servers } = await callUser<{ servers: McpServer[] }>(session.uid, "/store/servers");
		const target = form.id ? servers.find((server) => server.id === form.id) : undefined;

		if (form.action === "create") {
			const name = slugify(form.name ?? form.title ?? "");
			if (!name) return json({ error: "A name is needed." }, 400);
			if (servers.some((server) => server.name === name)) return json({ error: `A server named ${name} already exists.` }, 400);
			const server: McpServer = {
				id: newId("mcp"),
				name,
				...(form.title?.trim() ? { title: form.title.trim() } : {}),
				enabled: true,
				accountIds: [],
				tools: { groups: { builtin: "all" } },
				createdAt: Date.now(),
			};
			await callUser(session.uid, "/store/server", { method: "PUT", body: JSON.stringify(server) });
			return json({ ok: true, servers: await summaries(session.uid, origin) });
		}

		if (!target) return json({ error: "That server does not exist." }, 404);

		if (form.action === "update") {
			const updated: McpServer = {
				...target,
				...(form.title !== undefined ? { title: form.title.trim() || undefined } : {}),
				...(form.enabled !== undefined ? { enabled: form.enabled } : {}),
			};
			await callUser(session.uid, "/store/server", { method: "PUT", body: JSON.stringify(updated) });
			return json({ ok: true, servers: await summaries(session.uid, origin) });
		}
		if (form.action === "delete") {
			await callUser(session.uid, `/store/server?id=${encodeURIComponent(target.id)}`, { method: "DELETE" });
			return json({ ok: true, servers: await summaries(session.uid, origin) });
		}
		if (form.action === "accounts") {
			const updated: McpServer = { ...target, accountIds: form.accountIds ?? [] };
			await callUser(session.uid, "/store/server", { method: "PUT", body: JSON.stringify(updated) });
			return json({ ok: true, servers: await summaries(session.uid, origin) });
		}
		if (form.action === "tools") {
			const updated: McpServer = { ...target, tools: form.tools ?? EMPTY_ACCESS };
			await callUser(session.uid, "/store/server", { method: "PUT", body: JSON.stringify(updated) });
			return json({ ok: true, servers: await summaries(session.uid, origin) });
		}
		if (form.action === "tools-list") {
			const result = await callUser<{ tools: unknown[] }>(session.uid, "/tools", { method: "POST", body: JSON.stringify({ slug: target.name }) });
			return json({ ok: true, tools: result.tools });
		}
		if (form.action === "revoke-grant") {
			if (!form.guildId) return json({ error: "Which guild?" }, 400);
			await callUser(session.uid, "/grant", { method: "DELETE", body: JSON.stringify({ slug: target.name, guildId: form.guildId }) });
			return json({ ok: true, servers: await summaries(session.uid, origin) });
		}
		return json({ error: "unknown action" }, 400);
	});
}

// --- Discord sign-in -----------------------------------------------------------

function handleDiscordAuth(request: HttpServerRequest.HttpServerRequest) {
	return safe(async () => {
		const origin = originOf(request);
		if (!env.DISCORD_CLIENT_SECRET?.trim()) return redirect(`/console?error=${encodeURIComponent("Discord sign-in is not configured.")}`);
		const state = newId("st");
		const back = new URL(request.originalUrl).searchParams.get("return");
		const value = await signState({ state, ...(back && back.startsWith("/") ? { return: back } : {}) }, env.SESSION_SECRET!);
		return HttpServerResponse.setCookieUnsafe(
			redirect(authorizeUrl({ origin, clientId: CLIENT_ID, state })),
			STATE_COOKIE,
			value,
			{ ...cookieOptions(origin), expires: new Date(Date.now() + STATE_TTL_MS) },
		);
	});
}

function handleDiscordCallback(request: HttpServerRequest.HttpServerRequest) {
	return safe(async () => {
		const url = new URL(request.originalUrl);
		const origin = url.origin;
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		const expected = await readState<{ state: string; return?: string; exp: number }>(cookies(request)[STATE_COOKIE], env.SESSION_SECRET!);
		const clientSecret = env.DISCORD_CLIENT_SECRET?.trim();
		if (!code || !state || !expected || expected.state !== state || !clientSecret) {
			return redirect(`/console?error=${encodeURIComponent("That Discord sign-in could not be verified.")}`);
		}
		const token = await exchangeCode({ origin, clientId: CLIENT_ID, clientSecret, code });
		const account = await currentUser(token.access_token);
		const profile = await fetchDiscordProfile(token.access_token).catch(() => undefined);
		const session: Session = {
			uid: account.id,
			name: account.global_name || account.username,
			token: token.access_token,
			...(profile?.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
			exp: Date.now() + sessionTtlMs(),
		};
		const response = HttpServerResponse.setCookieUnsafe(
			redirect(expected.return && expected.return.startsWith("/") ? expected.return : "/console"),
			SESSION_COOKIE,
			await signSession(session, env.SESSION_SECRET!),
			{ ...cookieOptions(origin), expires: new Date(session.exp) },
		);
		return HttpServerResponse.expireCookieUnsafe(STATE_COOKIE, cookieOptions(origin))(response);
	});
}

function handleLogout(request: HttpServerRequest.HttpServerRequest) {
	const origin = originOf(request);
	return HttpServerResponse.expireCookieUnsafe(SESSION_COOKIE, cookieOptions(origin))(redirect("/"));
}

// --- Account OAuth callbacks ---------------------------------------------------

function handleAccountCallback(provider: "github" | "google") {
	return (request: HttpServerRequest.HttpServerRequest) =>
		safe(async () => {
		const url = new URL(request.originalUrl);
		const origin = url.origin;
		const state = await readState<{ uid: string; provider: string; exp: number }>(cookies(request)[STATE_COOKIE], env.SESSION_SECRET!);
		const code = url.searchParams.get("code");
		if (!state || state.provider !== provider || !code) {
			return redirect(`/console/accounts?error=${encodeURIComponent("That sign-in could not be verified. Start it again.")}`);
		}
		try {
			if (provider === "github") {
				const clientId = env.GITHUB_OAUTH_CLIENT_ID?.trim();
				const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
				if (!clientId || !clientSecret) throw new Error("GitHub sign-in is not configured.");
				const tokens = await exchangeGitHubCode({ clientId, clientSecret, code, redirectUri: `${origin}/github/callback` });
				const profile = await fetchGitHubProfile(tokens.accessToken);
				const account = newAccount("github", profile.name ?? profile.username, profile, { kind: "github", token: tokens.accessToken });
				await callUser(state.uid, "/store/account", { method: "PUT", body: JSON.stringify(account) });
			} else {
				const clientId = env.GOOGLE_CLIENT_ID?.trim();
				const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
				if (!clientId || !clientSecret) throw new Error("Google sign-in is not configured.");
				const tokens = await exchangeGoogleCode({ clientId, clientSecret, code, redirectUri: `${origin}/google/callback` });
				const profile = await fetchGoogleProfile(tokens.accessToken);
				const account = newAccount("google", profile.name ?? profile.username, profile, {
					kind: "google",
					token: tokens.accessToken,
					refreshToken: tokens.refreshToken,
					expiresAt: tokens.expiresAt,
				});
				await callUser(state.uid, "/store/account", { method: "PUT", body: JSON.stringify(account) });
			}
		} catch (error) {
			return redirect(`/console/accounts?error=${encodeURIComponent(describe(error))}`);
		}
		return HttpServerResponse.expireCookieUnsafe(STATE_COOKIE, cookieOptions(origin))(
			redirect(`/console/accounts?ok=${encodeURIComponent("Account connected.")}`),
		);
	});
}
// --- MCP consent ---------------------------------------------------------------

function handleAuthorizeDescribe(request: HttpServerRequest.HttpServerRequest) {
	return safe(async () => {
		const secret = env.SESSION_SECRET?.trim();
		if (!secret) return json({ ok: false, error: "server_error", description: "not configured" }, 500);
		const base = originOf(request);
		const params = readAuthorizeParams(new URL(request.originalUrl).searchParams);
		try {
			const consent = await inspectAuthorization(base, params, secret);
			const session = await sessionOf(request);
			if (!session) {
				const back = `/console/authorize?${new URL(request.originalUrl).searchParams}`;
				return json({ ok: false, needSignIn: true, signInUrl: `/auth/discord?return=${encodeURIComponent(back)}` });
			}
			const { servers } = await callUser<{ servers: McpServer[] }>(session.uid, "/store/servers");
			const server = servers.find((entry) => entry.name === consent.mcp);
			if (!server) return json({ ok: false, error: "invalid_target", description: `You have no MCP server named ${consent.mcp}.` }, 404);
			return json({ ok: true, client: consent.client.name, scope: consent.scope, resource: consent.resource, server: server.name, title: server.title ?? server.name });
		} catch (error) {
			if (error instanceof OAuthError) return json({ ok: false, error: error.code, description: error.message }, error.status);
			return json({ ok: false, error: "server_error", description: describe(error) }, 500);
		}
	});
}

function decideAuthorization(request: HttpServerRequest.HttpServerRequest, body: { approve?: boolean; query?: string }) {
	return safe(async () => {
		const secret = env.SESSION_SECRET?.trim();
		if (!secret) return json({ ok: false, error: "server_error", description: "not configured" }, 500);
		const base = originOf(request);
		const params = readAuthorizeParams(new URLSearchParams(body.query ?? ""));
		try {
			const consent = await inspectAuthorization(base, params, secret);
			if (body.approve === false) return json({ ok: true, redirect: denyAuthorization(consent) });
			const session = await sessionOf(request);
			if (!session) return json({ ok: false, error: "access_denied", description: "Sign in first." }, 401);
			const { servers } = await callUser<{ servers: McpServer[] }>(session.uid, "/store/servers");
			if (!servers.some((entry) => entry.name === consent.mcp)) {
				return json({ ok: false, error: "invalid_target", description: `No MCP server named ${consent.mcp}.` }, 404);
			}
			const { redirect: url } = await approveAuthorization(consent, session.uid, secret);
			return json({ ok: true, redirect: url });
		} catch (error) {
			if (error instanceof OAuthError) return json({ ok: false, error: error.code, description: error.message }, error.status);
			return json({ ok: false, error: "server_error", description: describe(error) }, 500);
		}
	});
}

// --- Routes --------------------------------------------------------------------

export function gatewayRoutes() {
	const Routes = Layer.mergeAll(
		HttpRouter.add("GET", "/api/config", () =>
			Effect.sync(() => json({ posthog: env.POSTHOG_KEY?.trim() ? { key: env.POSTHOG_KEY.trim(), uiHost: env.POSTHOG_UI_HOST?.trim() || "https://us.posthog.com" } : null })),
		),
		HttpRouter.add("GET", "/api/session", (request) =>
			safe(async () => {
				const session = await sessionOf(request);
				return session
					? json({ signedIn: true, account: { id: session.uid, name: session.name, avatarUrl: session.avatarUrl ?? null } })
					: json({ signedIn: false });
			}),
		),
		HttpRouter.add("GET", "/api/tools", () => Effect.sync(() => json({ groups: TOOL_GROUPS.map((id) => ({ id, name: TOOL_GROUP_NAMES[id], tools: catalogForConsole().filter((tool) => tool.group === id) })) }))),
		HttpRouter.add("GET", "/api/accounts", (request) => handleAccountsGet(request)),
		HttpRouter.add("POST", "/api/accounts", (request) =>
			Effect.gen(function* () {
				const form = yield* parseBody(request, AccountsRequest);
				if (!form) return json({ error: "The request could not be read." }, 400);
				return yield* handleAccountsPost(request, form);
			}),
		),
		HttpRouter.add("GET", "/api/servers", (request) => handleServersGet(request)),
		HttpRouter.add("POST", "/api/servers", (request) =>
			Effect.gen(function* () {
				const form = yield* parseBody(request, ServersRequest);
				if (!form) return json({ error: "The request could not be read." }, 400);
				return yield* handleServersPost(request, form);
			}),
		),
		HttpRouter.add("GET", "/api/mcp/authorize", (request) => handleAuthorizeDescribe(request)),
		HttpRouter.add("POST", "/api/mcp/authorize", (request) =>
			Effect.gen(function* () {
				const body = (yield* request.json) as { approve?: boolean; query?: string };
				return yield* decideAuthorization(request, body);
			}),
		),
		HttpRouter.add("GET", "/auth/discord", (request) => handleDiscordAuth(request)),
		HttpRouter.add("GET", DISCORD_CALLBACK_PATH, (request) => handleDiscordCallback(request)),
		HttpRouter.add("GET", "/auth/logout", (request) => Effect.sync(() => handleLogout(request))),
		HttpRouter.add("GET", "/github/callback", (request) => handleAccountCallback("github")(request)),
		HttpRouter.add("GET", "/google/callback", (request) => handleAccountCallback("google")(request)),
		HttpRouter.add("GET", AS_METADATA_PATH, (request) => Effect.sync(() => json(authorizationServerMetadata(originOf(request))))),
		HttpRouter.add("POST", REGISTER_PATH, (request) =>
			Effect.gen(function* () {
				const secret = env.SESSION_SECRET?.trim();
				if (!secret) return json({ error: "server_error" }, 500);
				const text = yield* request.text;
				return yield* Effect.tryPromise({ try: () => registerClient(JSON.parse(text), secret), catch: (error) => error }).pipe(
					Effect.match({ onFailure: (error) => oauthFailure(error), onSuccess: (client) => json(client, 201) }),
				);
			}),
		),
		HttpRouter.add("POST", TOKEN_PATH, (request) =>
			Effect.gen(function* () {
				const secret = env.SESSION_SECRET?.trim();
				if (!secret) return json({ error: "server_error" }, 500);
				const base = originOf(request);
				const form = new URLSearchParams(yield* request.text);
				const grant = form.get("grant_type");
				const exchange =
					grant === "authorization_code"
						? () => exchangeAuthorizationCode(base, form, secret)
						: grant === "refresh_token"
							? () => exchangeRefreshToken(base, form, secret)
							: undefined;
				if (!exchange) return oauthFailure(new OAuthError("unsupported_grant_type", "Only authorization_code and refresh_token are supported."));
				return yield* Effect.tryPromise({ try: exchange, catch: (error) => error }).pipe(
					Effect.match({ onFailure: (error) => oauthFailure(error), onSuccess: (tokens) => json(tokens) }),
				);
			}),
		),
	).pipe(Layer.provide(HttpServer.layerServices));

	const scheduler = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"));
	return HttpRouter.toWebHandler(Layer.provideMerge(Routes, scheduler));
}

/** Discovery documents, handled outside the router because the path carries a server name. */
export function protectionMetadata(path: string, origin: string): Response | undefined {
	if (path === PRM_PATHS[0] || path === PRM_PATHS[1]) return Response.json(protectedResourceMetadata(origin));
	const prefix = `${PRM_PATHS[1]}/`;
	if (path.startsWith(prefix)) {
		const name = path.slice(prefix.length).replace(/\/+$/, "");
		if (name && !name.includes("/")) return Response.json(protectedResourceMetadata(origin, decodeURIComponent(name)));
	}
	return undefined;
}
