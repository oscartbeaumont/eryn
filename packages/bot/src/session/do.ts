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
import { BotError, ParseError, describeError } from "../errors";
import { DiscordApi } from "../discord/api";
import { Workspace } from "../opencode/store";
import { GuildAgent, type GuildAgentShape, type HostConfig } from "./agent";
import {
	GuildRefSchema,
	InterruptRequestSchema,
	LinkAddRequestSchema,
	LinkRemoveRequestSchema,
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

/** The token is the one secret a link carries; the gateway never sees it. */
function publicLink(link: McpLink): PublicLink {
	const { token: _token, ...rest } = link;
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

export class BotSession extends DurableObject<Env> {
	private readonly guildId: string;
	private readonly runtime: ManagedRuntime.ManagedRuntime<GuildStore | GuildAgent | Workspace | DiscordApi, never>;

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
		try {
			return await this.runtime.runPromise(this.route(request));
		} catch (error) {
			log("session", `internal route failed: ${describeError(error)}`);
			return json({ error: describeError(error) }, 500);
		}
	}

	private route(request: Request): Effect.Effect<Response, never, GuildStore | GuildAgent> {
		const guildId = this.guildId;
		return Effect.gen(function* () {
			const store = yield* GuildStore;
			const agent = yield* GuildAgent;
			const url = new URL(request.url);

			/** Everything the host needs, read once from this guild's own storage. */
			const loadConfig = async (): Promise<HostConfig> => {
				const settings = await store.settings();
				const connections = await store.providers();
				const links = await store.links();
				return { connections, model: settings.model, links };
			};

			if (request.method === "POST" && url.pathname === "/config") {
				const body = yield* readBody(GuildRefSchema, request);
				if (body instanceof Response) return body;
				if (guildId && body.guildId !== guildId) return json({ error: "guild mismatch" }, 403);
				return yield* attempt(async () => {
					const settings = await store.settings();
					const connections = await store.providers();
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
						}
						return json({ status });
					}
					if (action === "complete") {
						await agent.oauthComplete(config, body.integrationID, attemptID, body.code);
						await store.putProvider({ integrationID: body.integrationID, method: "oauth", key: "" });
						await store.clearPendingOAuth();
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
					await agent.prompt(body, config);
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
