/**
 * The guild session object.
 *
 * **One object per Discord guild.** The guild id is the object name, so a
 * guild's OpenCode database, virtual filesystem, provider credentials, and
 * linked MCP tokens all live in storage that no other guild can be routed to.
 *
 * It is a thin shell: it composes layers over its own storage and delegates to
 * `GuildStore` and `GuildAgent`. It exposes the internal routes the gateway
 * calls (`CONTRACT.md` §3), and holds no Discord socket and no timer of its own.
 */

import { DurableObject } from "cloudflare:workers";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";

import { DEFAULT_MODEL, isValidModel, log } from "../config";
import { DEPLOY_HEADER, currentDeploy } from "../deploy";
import { BotError, ParseError, describeError } from "../errors";
import { DiscordApi, type DiscordRest } from "../discord/api";
import { beginAuthorization, describeTools, finishAuthorization, refreshLink, refreshLinks, testLink, AUTH_TTL_MS } from "../mcp/links";
import { probeServer } from "../mcp/client";
import { Workspace } from "../opencode/store";
import { GuildAgent, type GuildAgentShape, type HostConfig } from "./agent";
import {
	GuildRefSchema,
	InterruptRequestSchema,
	LinkAddRequestSchema,
	LinkRemoveRequestSchema,
	McpAuthAttemptRequestSchema,
	McpAuthCompleteRequestSchema,
	McpAuthStartRequestSchema,
	McpProbeRequestSchema,
	McpTestRequestSchema,
	ModelRequestSchema,
	PromptRequestSchema,
	ProviderConnectRequestSchema,
	type McpLink,
	type PublicLink,
} from "./models";
import { GuildStore, type GuildStoreShape } from "./store";

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

/** The secrets a link carries are the bearer and, for OAuth, the refresh pair. */
function publicLink(link: McpLink): PublicLink {
	const { token: _token, oauth: _oauth, ...rest } = link;
	return rest;
}

/** Run a promise, turning a rejection into a tagged error rather than a defect. */
function attempt<A>(run: () => Promise<A>): Effect.Effect<A, BotError> {
	return Effect.tryPromise({ try: run, catch: (error) => new BotError({ message: describeError(error) }) });
}

/** Parse a request body with `Schema`, or fail with a {@link ParseError}. */
function decodeBody<S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	request: Request,
): Effect.Effect<S["Type"], ParseError> {
	return Effect.tryPromise({
		try: async () =>
			Schema.decodeUnknownSync(schema)((await request.json()) as unknown),
		catch: (error) => new ParseError({ message: `could not read the request: ${describeError(error)}` }),
	});
}

/** Parse a request body, or produce the `400` response it should get instead. */
function readBody<S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	request: Request,
): Effect.Effect<S["Type"] | Response> {
	return decodeBody(schema, request).pipe(Effect.catch((error) => Effect.succeed(json({ error: error.message }, 400))));
}

export class BotSessionV4 extends DurableObject<Env> {
	private readonly guildId: string;
	private readonly runtime: ManagedRuntime.ManagedRuntime<GuildStore | GuildAgent | Workspace | DiscordApi, never>;
	/** Requests currently running, so a deploy restart does not cut a turn in half. */
	private inFlight = 0;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.guildId = state.id.name ?? "";
		// The agent's dependencies are built once and shared, so the host, the
		// filesystem, and the Discord client are all the same instances.
		const base = Layer.mergeAll(
			Workspace.layer(state.storage),
			DiscordApi.layer(env.DISCORD_BOT_TOKEN?.trim() ?? ""),
		);
		const layer = Layer.mergeAll(
			GuildStore.layer(state.storage, env.ENCRYPTION_KEY),
			base,
			GuildAgent.layer(env, state.storage).pipe(Layer.provide(base)),
		);
		this.runtime = ManagedRuntime.make(layer);
		log("session", `guild ${this.guildId} object created`);
	}

	async fetch(request: Request): Promise<Response> {
		await this.ensureCurrentVersion(request);
		this.inFlight += 1;
		try {
			return await this.runtime.runPromise(this.route(request));
		} catch (error) {
			log("session", `internal route failed: ${describeError(error)}`);
			return json({ error: describeError(error) }, 500);
		} finally {
			this.inFlight -= 1;
		}
	}

	/**
	 * Restart this object when a deploy has moved on, once the current request is
	 * done. A live object keeps the code it started with, so a fix is invisible
	 * until it restarts; the caller tells it which deploy is current.
	 */
	private async ensureCurrentVersion(request: Request): Promise<void> {
		const version = request.headers.get(DEPLOY_HEADER) ?? currentDeploy(this.env);
		if (!version) return;
		const stored = await this.ctx.storage.get<string>("deploy:version");
		if (stored !== version) {
			await this.ctx.storage.put("deploy:version", version);
			if (stored !== undefined) await this.ctx.storage.put("deploy:restart", true);
		}
		// A pending restart must own an alarm, even if one was lost.
		if (await this.ctx.storage.get<boolean>("deploy:restart")) {
			await this.ctx.storage.setAlarm(Date.now() + 1_000);
		}
	}

	async alarm(): Promise<void> {
		if (!(await this.ctx.storage.get<boolean>("deploy:restart"))) return;
		if (this.inFlight > 0) {
			// A turn is still running. Restarting now would drop the reply, so wait
			// for it to finish and check again.
			await this.ctx.storage.setAlarm(Date.now() + 5_000);
			return;
		}
		await this.ctx.storage.delete("deploy:restart");
		// An interrupted alarm retries by default; this restart is deliberate.
		this.ctx.abort("deploy changed", { retryAlarm: false });
	}

	private route(request: Request): Effect.Effect<Response, never, GuildStore | GuildAgent | DiscordApi> {
		const guildId = this.guildId;
		const env = this.env;
		return Effect.gen(function* () {
			const store = yield* GuildStore;
			const agent = yield* GuildAgent;
			const rest: DiscordRest = yield* DiscordApi;
			const url = new URL(request.url);

			/** Everything the host needs, read once from this guild's own storage. */
			const loadConfig = async (): Promise<HostConfig> => {
				const settings = await store.settings();
				const connections = await store.providers();
				const links = await refreshLinks(store, await store.links());
				return { connections, model: settings.model, links };
			};

			/**
			 * Point the guild at a model it can actually run.
			 *
			 * Connecting a provider does not change the stored model, and the default
			 * names `opencode-go` even when a guild connects `opencode`. Without this
			 * the first turn runs a model whose provider has no credential and
			 * produces nothing.
			 */
			const reconcileModel = async (config: HostConfig): Promise<HostConfig> => {
				try {
					const model = await agent.resolveModel(config);
					if (model === config.model) return config;
					const settings = await store.settings();
					await store.putSettings({ ...settings, model, updatedAt: Date.now() });
					log("session", `using ${model} instead of the unavailable ${config.model}`);
					return { ...config, model };
				} catch (error) {
					log("session", `could not reconcile the model: ${describeError(error)}`);
					return config;
				}
			};

			if (request.method === "POST" && url.pathname === "/config") {
				const body = yield* readBody(GuildRefSchema, request);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				return yield* attempt(async () => {
					const settings = await store.settings();
					const connections = await store.providers();
					// A status read does not need a live token; the turn does, and
					// refreshing here would put network calls in front of a reply.
					const links = await store.links();
					return json({
						ready: connections.length > 0,
						model: settings.model,
						providers: connections.map((connection) => ({
							integrationID: connection.integrationID,
							method: connection.method,
							...(connection.key ? { prefix: connection.key.slice(0, 8) } : {}),
						})),
						links: links.map(publicLink),
					});
				}).pipe(Effect.catch((error) => Effect.succeed(json({ error: error.message }, 500))));
			}

			if (request.method === "POST" && url.pathname === "/providers") {
				const body = yield* readBody(GuildRefSchema, request);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				return yield* attempt(async () => json({ integrations: await agent.integrations(await loadConfig()) })).pipe(
					Effect.catch((error) => Effect.succeed(json({ error: error.message }, 502))),
				);
			}

			if (request.method === "POST" && url.pathname === "/models") {
				const body = yield* readBody(GuildRefSchema, request);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				return yield* attempt(async () => json({ models: await agent.models(await loadConfig()) })).pipe(
					Effect.catch((error) => Effect.succeed(json({ error: error.message }, 502))),
				);
			}

			if (request.method === "POST" && url.pathname === "/provider/connect") {
				const body = yield* readBody(ProviderConnectRequestSchema, request);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				return yield* attempt(async () => {
					const config = await loadConfig();
					// A key connection is a single step: replay the key, then record
					// the connection so the next turn rebuilds the host with it.
					if (body.key !== undefined && body.action === undefined) {
						await agent.connectKey(config, body.integrationID, body.key);
						await store.putProvider({ integrationID: body.integrationID, method: body.methodID ?? "key", key: body.key });
						await reconcileModel(await loadConfig());
						return json({ ok: true });
					}
					const action = body.action ?? "start";
					if (action === "start") {
						const result = await agent.oauthConnect(
							config,
							body.integrationID,
							body.methodID ?? "",
							body.answer ?? {},
						);
						if ("error" in result) return json({ error: result.error }, 400);
						await store.putPendingOAuth({
							integrationID: body.integrationID,
							attemptID: result.attemptID,
							createdAt: Date.now(),
						});
						return json({
							url: result.url,
							attemptID: result.attemptID,
							mode: result.mode,
							instructions: result.instructions,
						});
					}
					// A device-code flow finishes from a modal that only carries the
					// provider id, so the attempt is read back from storage.
					const pending = await store.pendingOAuth();
					const attemptID =
						body.attemptID ??
						(pending && pending.integrationID === body.integrationID ? pending.attemptID : undefined);
					if (!attemptID) return json({ error: "Start the sign-in again." }, 400);
					if (action === "status") {
						const status = await agent.oauthStatus(config, body.integrationID, attemptID);
						if (status.status === "complete") {
							await store.putProvider({ integrationID: body.integrationID, method: "oauth", key: "" });
							await store.clearPendingOAuth();
							await reconcileModel(await loadConfig());
						}
						return json({ status });
					}
					if (action === "complete") {
						await agent.oauthComplete(config, body.integrationID, attemptID, body.code);
						await store.putProvider({ integrationID: body.integrationID, method: "oauth", key: "" });
						await store.clearPendingOAuth();
						await reconcileModel(await loadConfig());
						return json({ ok: true });
					}
					await agent.oauthCancel(config, body.integrationID, attemptID);
					await store.clearPendingOAuth();
					return json({ ok: true });
				}).pipe(Effect.catch((error) => Effect.succeed(json({ error: error.message }, 502))));
			}

			if (request.method === "POST" && url.pathname === "/disconnect") {
				const body = yield* readBody(
					Schema.Struct({ guildId: Schema.String, integrationID: Schema.String }),
					request,
				);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				return yield* attempt(async () => {
					await agent.disconnect(await loadConfig(), body.integrationID);
					await store.removeProvider(body.integrationID);
					return json({ ok: true });
				}).pipe(Effect.catch((error) => Effect.succeed(json({ error: error.message }, 502))));
			}

			if (request.method === "POST" && url.pathname === "/model") {
				const body = yield* readBody(ModelRequestSchema, request);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				const model = body.model.trim();
				if (!isValidModel(model)) return json({ error: "model must be a provider/model reference" }, 400);
				return yield* attempt(async () => {
					const config = await loadConfig();
					const provider = model.split("/")[0] ?? "";
					if (!config.connections.some((connection) => connection.integrationID === provider)) {
						const connected = config.connections.map((connection) => connection.integrationID).join(", ") || "none";
						return json(
							{
								error: `\`${provider}\` is not connected here, so \`${model}\` cannot run. Connected providers: ${connected}. Pick a model from one of those.`,
							},
							400,
						);
					}
					const existing = await store.settings();
					await store.putSettings({
						model,
						updatedAt: Date.now(),
						...(existing.configuredBy ? { configuredBy: existing.configuredBy } : {}),
					});
					return json({ ok: true });
				}).pipe(Effect.catch((error) => Effect.succeed(json({ error: error.message }, 500))));
			}

			if (request.method === "POST" && url.pathname === "/links") {
				const body = yield* readBody(GuildRefSchema, request);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				return yield* attempt(async () => json({ links: (await store.links()).map(publicLink) })).pipe(
					Effect.catch((error) => Effect.succeed(json({ error: error.message }, 500))),
				);
			}

			if (request.method === "POST" && url.pathname === "/link/add") {
				const body = yield* readBody(LinkAddRequestSchema, request);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				// `LinkAddRequestSchema` already parsed the embedded link, so a
				// malformed one never reaches storage.
				const link = body.link;
				return yield* attempt(async () => {
					const existing = await store.links();
					if (existing.some((candidate) => candidate.name === link.name && candidate.id !== link.id)) {
						return json({ error: `A server named "${link.name}" is already linked.` }, 400);
					}
					await store.putLink(link);
					return json({ ok: true });
				}).pipe(Effect.catch((error) => Effect.succeed(json({ error: error.message }, 500))));
			}

			if (request.method === "POST" && url.pathname === "/link/remove") {
				const body = yield* readBody(LinkRemoveRequestSchema, request);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				return yield* attempt(async () => {
					await store.removeLink(body.linkId);
					return json({ ok: true });
				}).pipe(Effect.catch((error) => Effect.succeed(json({ error: error.message }, 500))));
			}

			/** Test a URL before it is linked: what it offers, or what it wants. */
			if (request.method === "POST" && url.pathname === "/link/probe") {
				const body = yield* readBody(McpProbeRequestSchema, request);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				return yield* attempt(async () =>
					json(await probeServer({ url: body.url, ...(body.token ? { token: body.token } : {}) })),
				).pipe(Effect.catch((error) => Effect.succeed(json({ ok: false, tools: [], error: error.message }, 502))));
			}

			/** Test a link that is already stored, refreshing its token first. */
			if (request.method === "POST" && url.pathname === "/link/test") {
				const body = yield* readBody(McpTestRequestSchema, request);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				return yield* attempt(async () => {
					const link = await store.getLink(body.linkId);
					if (!link) return json({ ok: false, tools: [], error: "That MCP server is no longer linked." }, 404);
					return json(await testLink(await refreshLink(store, link)));
				}).pipe(Effect.catch((error) => Effect.succeed(json({ ok: false, tools: [], error: error.message }, 502))));
			}

			/** Start a sign-in: discover, register, and return the URL to open. */
			if (request.method === "POST" && url.pathname === "/link/oauth/start") {
				const body = yield* readBody(McpAuthStartRequestSchema, request);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				return yield* attempt(async () => {
					const name = body.name.trim();
					if (!name) return json({ ok: false, error: "A name is required." }, 400);
					const links = await store.links();
					if (links.some((link) => link.name === name)) {
						return json({ ok: false, error: `A server named "${name}" is already linked.` }, 400);
					}
					const probe = await probeServer({ url: body.url });
					if (probe.ok) {
						return json({ ok: false, error: "This server did not ask for a sign-in." }, 400);
					}
					try {
						const started = await beginAuthorization({
							store,
							env,
							guildId,
							name,
							url: body.url,
							...(body.channelId ? { channelId: body.channelId } : {}),
							...(probe.resourceMetadataUrl ? { resourceMetadataUrl: probe.resourceMetadataUrl } : {}),
							...(probe.scope ? { scope: probe.scope } : {}),
						});
						return json({ ok: true, ...started });
					} catch (error) {
						return json({ ok: false, error: describeError(error) }, 400);
					}
				}).pipe(Effect.catch((error) => Effect.succeed(json({ ok: false, error: error.message }, 502))));
			}

			/** Whether a started sign-in has finished, as the Discord buttons ask. */
			if (request.method === "POST" && url.pathname === "/link/oauth/status") {
				const body = yield* readBody(McpAuthAttemptRequestSchema, request);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				return yield* attempt(async () => {
					const attemptRecord = await store.getAuthAttempt(body.attemptId);
					if (!attemptRecord) return json({ status: "missing" });
					if (attemptRecord.status === "pending" && Date.now() - attemptRecord.createdAt > AUTH_TTL_MS) {
						const message = "That sign-in expired. Start it again from `/eryn mcp add`.";
						await store.putAuthAttempt({ ...attemptRecord, status: "failed", message });
						return json({ status: "failed", message });
					}
					const link = attemptRecord.linkId ? await store.getLink(attemptRecord.linkId) : undefined;
					return json({
						status: attemptRecord.status,
						...(attemptRecord.message ? { message: attemptRecord.message } : {}),
						...(link ? { link: publicLink(link) } : {}),
					});
				}).pipe(Effect.catch((error) => Effect.succeed(json({ status: "failed", message: error.message }))));
			}

			/**
			 * Finish a sign-in with the code the browser brought back.
			 *
			 * The browser callback and the "I've finished" button both land here,
			 * so the second of the two sees a completed attempt and changes nothing.
			 */
			if (request.method === "POST" && url.pathname === "/link/oauth/complete") {
				const body = yield* readBody(McpAuthCompleteRequestSchema, request);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				return yield* attempt(async () => {
					const attemptRecord = await store.getAuthAttempt(body.attemptId);
					if (!attemptRecord) return json({ ok: false, error: "That sign-in is no longer available." }, 404);
					const firstFinish = attemptRecord.status === "pending";
					const result = await finishAuthorization(store, attemptRecord, {
						...(body.code ? { code: body.code } : {}),
						...(body.error ? { error: body.error } : {}),
					});
					if (firstFinish && result.link && attemptRecord.channelId) {
						// The browser is on its own page, so say the outcome where the
						// conversation started rather than only in the tab.
						await rest
							.sendMessage(
								attemptRecord.channelId,
								`**${result.link.name} is connected.** ${describeTools(result.tools ?? [])} Eryn will use it on the next turn.`,
							)
							.catch((error) => log("session", `could not announce the MCP link: ${describeError(error)}`));
					}
					return json({
						ok: result.status === "complete",
						status: result.status,
						...(result.message ? { message: result.message } : {}),
						...(result.link ? { link: publicLink(result.link) } : {}),
						...(result.tools ? { tools: result.tools } : {}),
					});
				}).pipe(Effect.catch((error) => Effect.succeed(json({ ok: false, status: "failed", message: error.message }, 502))));
			}

			if (request.method === "POST" && url.pathname === "/prompt") {
				const body = yield* readBody(PromptRequestSchema, request);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				return yield* attempt(async () => {
					const stored = await loadConfig();
					// The session owns the guild's config; the gateway's copy, when it
					// sends one, is an override used for exactly this turn.
					const config: HostConfig = body.config
						? { connections: body.config.connections, model: body.config.model, links: stored.links }
						: stored;
					if (config.connections.length === 0) {
						return json({ ok: false, error: "no provider is connected" }, 400);
					}
					await agent.prompt(body, await reconcileModel(config));
					return json({ ok: true });
				}).pipe(Effect.catch((error) => Effect.succeed(json({ ok: false, error: error.message }, 500))));
			}

			if (request.method === "POST" && url.pathname === "/interrupt") {
				const body = yield* readBody(InterruptRequestSchema, request);
				if (body instanceof Response) return body;
				return yield* attempt(async () => json({ stopped: await agent.interrupt(body.threadId, body.gone === true) })).pipe(
					Effect.catch((error) => Effect.succeed(json({ error: error.message }, 500))),
				);
			}

			if (request.method === "GET" && url.pathname === "/status") {
				return json({ guildId, model: DEFAULT_MODEL });
			}

			return json({ error: "not found" }, 404);
		});
	}
}

export type { GuildStoreShape, GuildAgentShape };
