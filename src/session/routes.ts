/**
 * The internal HTTP API of a guild object.
 *
 * The bot gateway calls these routes; every body is parsed from its Effect
 * `Schema` before a handler sees it, and a body that names a guild must match
 * the object it reached. Keeping the table here leaves the Durable Object with
 * its lifecycle (alarms, deploys, scheduling) rather than its endpoints.
 */

import { Schema } from "effect";

import { isValidModel, log } from "../config";
import type { DiscordRest } from "../discord/api";
import { describeError } from "../errors";
import { probeServer } from "../mcp/client";
import {
	AUTH_TTL_MS,
	beginAuthorization,
	describeTools,
	finishAuthorization,
	refreshLink,
	testLink,
} from "../mcp/links";
import type { GuildAgentShape } from "./agent";
import type { HostConfig } from "./host-config";
import {
	DisconnectRequestSchema,
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
import { ROUTES } from "./paths";
import type { GuildStoreShape } from "./store";

/** Everything a route handler may use from the guild object. */
export interface RouteContext {
	readonly env: Env;
	readonly guildId: string;
	readonly rest: DiscordRest;
	readonly store: GuildStoreShape;
	readonly agent: GuildAgentShape;
	loadConfig(refresh?: boolean): Promise<HostConfig>;
	reconcileModel(config: HostConfig): Promise<HostConfig>;
	/** Wake the object when the next schedule is due. */
	armScheduleAlarm(): Promise<void>;
}

export function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

/** The secrets a link carries are the bearer and, for OAuth, the refresh pair. */
function publicLink(link: McpLink): PublicLink {
	const { token: _token, oauth: _oauth, ...rest } = link;
	return rest;
}

/** Parse a request body, or produce the `400` response it should get instead. */
async function parseBody<S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	request: Request,
): Promise<S["Type"] | Response> {
	try {
		return Schema.decodeUnknownSync(schema)((await request.json()) as unknown);
	} catch (error) {
		return json({ error: `could not read the request: ${describeError(error)}` }, 400);
	}
}

interface Route {
	/** Omitted for a route that carries no JSON body. */
	readonly schema?: Schema.ConstraintDecoder<unknown>;
	/** Whether the body names the guild and must match this object. */
	readonly scoped?: boolean;
	readonly handle: (body: unknown) => Promise<Response>;
	readonly onFailure: (error: unknown) => Response;
}

const internalFailure = (error: unknown) => json({ error: describeError(error) }, 500);
const badGateway = (error: unknown) => json({ error: describeError(error) }, 502);

/** A route whose body names the guild, so it must match this object. */
function route<S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	handle: (body: S["Type"]) => Promise<Response>,
	failure: (error: unknown) => Response = internalFailure,
): Route {
	return { schema, scoped: true, handle: handle as (body: unknown) => Promise<Response>, onFailure: failure };
}

/** A route whose body carries no guild id, such as an interrupt. */
function openRoute<S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	handle: (body: S["Type"]) => Promise<Response>,
	failure: (error: unknown) => Response = internalFailure,
): Route {
	return { schema, handle: handle as (body: unknown) => Promise<Response>, onFailure: failure };
}

/** Build the route table and the dispatcher that serves it. */
export function buildRoutes(ctx: RouteContext): (request: Request) => Promise<Response> {
	const { env, guildId, rest, store, agent, loadConfig, reconcileModel, armScheduleAlarm } = ctx;

	/** Record an OAuth connection and move the guild onto a model it can run. */
	const recordOAuth = async (integrationID: string) => {
		await store.putProvider({ integrationID, method: "oauth", key: "" });
		await store.clearPendingOAuth();
		await reconcileModel(await loadConfig());
	};

	const routes: Record<string, Route> = {
		[ROUTES.config]: route(GuildRefSchema, async () => {
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
				})),
				links: links.map(publicLink),
			});
		}),

		[ROUTES.providers]: route(
			GuildRefSchema,
			async () => json({ integrations: await agent.integrations(await loadConfig()) }),
			badGateway,
		),

		[ROUTES.models]: route(
			GuildRefSchema,
			async () => json({ models: await agent.models(await loadConfig()) }),
			badGateway,
		),

		[ROUTES.providerConnect]: route(
			ProviderConnectRequestSchema,
			async (body) => {
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
					const result = await agent.oauthConnect(config, body.integrationID, body.methodID ?? "", body.answer ?? {});
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
					if (status.status === "complete") await recordOAuth(body.integrationID);
					return json({ status });
				}
				if (action === "complete") {
					await agent.oauthComplete(config, body.integrationID, attemptID, body.code);
					await recordOAuth(body.integrationID);
					return json({ ok: true });
				}
				await agent.oauthCancel(config, body.integrationID, attemptID);
				await store.clearPendingOAuth();
				return json({ ok: true });
			},
			badGateway,
		),

		[ROUTES.disconnect]: route(
			DisconnectRequestSchema,
			async (body) => {
				await agent.disconnect(await loadConfig(), body.integrationID);
				await store.removeProvider(body.integrationID);
				// If another provider is still connected, move the guild off a
				// model whose provider was just removed.
				if ((await store.providers()).length > 0) await reconcileModel(await loadConfig());
				return json({ ok: true });
			},
			badGateway,
		),

		[ROUTES.model]: route(ModelRequestSchema, async (body) => {
			const model = body.model.trim();
			if (!isValidModel(model)) return json({ error: "model must be a provider/model reference" }, 400);
			const config = await loadConfig();
			const models = await agent.models(config).catch(() => []);
			const candidate = models.find((entry) => entry.id === model);
			if (!candidate) {
				return json({ error: `That model is not in the current catalogue.` }, 400);
			}
			if (!candidate.connected) {
				const connected =
					[...new Set(models.filter((entry) => entry.connected).map((entry) => entry.provider))].join(", ") ||
					"none";
				return json(
					{
						error: `The provider for \`${model}\` is not connected here. Connected providers: ${connected}. Pick a model from one of those.`,
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
		}),

		[ROUTES.links]: route(GuildRefSchema, async () => json({ links: (await store.links()).map(publicLink) })),

		[ROUTES.linkAdd]: route(LinkAddRequestSchema, async (body) => {
			const link = body.link;
			const existing = await store.links();
			if (existing.some((candidate) => candidate.name === link.name && candidate.id !== link.id)) {
				return json({ error: `A server named "${link.name}" is already linked.` }, 400);
			}
			await store.putLink(link);
			return json({ ok: true });
		}),

		[ROUTES.linkRemove]: route(LinkRemoveRequestSchema, async (body) => {
			await store.removeLink(body.linkId);
			return json({ ok: true });
		}),

		/** Test a URL before it is linked: what it offers, or what it wants. */
		[ROUTES.linkProbe]: route(
			McpProbeRequestSchema,
			async (body) => json(await probeServer({ url: body.url, ...(body.token ? { token: body.token } : {}) })),
			(error) => json({ ok: false, tools: [], error: describeError(error) }, 502),
		),

		/** Test a link that is already stored, refreshing its token first. */
		[ROUTES.linkTest]: route(
			McpTestRequestSchema,
			async (body) => {
				const link = await store.getLink(body.linkId);
				if (!link) return json({ ok: false, tools: [], error: "That MCP server is no longer linked." }, 404);
				return json(await testLink(await refreshLink(store, link)));
			},
			(error) => json({ ok: false, tools: [], error: describeError(error) }, 502),
		),

		/** Start a sign-in: discover, register, and return the URL to open. */
		[ROUTES.linkOauthStart]: route(
			McpAuthStartRequestSchema,
			async (body) => {
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
						...(body.applicationId ? { applicationId: body.applicationId } : {}),
						...(body.interactionToken ? { interactionToken: body.interactionToken } : {}),
						...(probe.resourceMetadataUrl ? { resourceMetadataUrl: probe.resourceMetadataUrl } : {}),
						...(probe.scope ? { scope: probe.scope } : {}),
					});
					return json({ ok: true, ...started });
				} catch (error) {
					return json({ ok: false, error: describeError(error) }, 400);
				}
			},
			(error) => json({ ok: false, error: describeError(error) }, 502),
		),

		/** Whether a started sign-in has finished, as the Discord buttons ask. */
		[ROUTES.linkOauthStatus]: route(
			McpAuthAttemptRequestSchema,
			async (body) => {
				const attempt = await store.getAuthAttempt(body.attemptId);
				if (!attempt) return json({ status: "missing" });
				if (attempt.status === "pending" && Date.now() - attempt.createdAt > AUTH_TTL_MS) {
					const message = "That sign-in expired. Start it again from `/eryn setup` under MCP servers.";
					await store.putAuthAttempt({ ...attempt, status: "failed", message });
					return json({ status: "failed", message });
				}
				const link = attempt.linkId ? await store.getLink(attempt.linkId) : undefined;
				return json({
					status: attempt.status,
					...(attempt.message ? { message: attempt.message } : {}),
					...(link ? { link: publicLink(link) } : {}),
				});
			},
			(error) => json({ status: "failed", message: describeError(error) }),
		),

		/** Resolve a started sign-in to its full authorization URL. */
		[ROUTES.linkOauthUrl]: route(McpAuthAttemptRequestSchema, async (body) => {
			const attempt = await store.getAuthAttempt(body.attemptId);
			if (!attempt?.authorizationUrl) return json({ error: "That sign-in is no longer available." }, 404);
			if (attempt.status !== "pending") return json({ error: "That sign-in is no longer pending." }, 404);
			if (Date.now() - attempt.createdAt > AUTH_TTL_MS) {
				await store.putAuthAttempt({ ...attempt, status: "failed", message: "That sign-in expired." });
				return json({ error: "That sign-in expired." }, 404);
			}
			return json({ url: attempt.authorizationUrl });
		}),

		/**
		 * Finish a sign-in with the code the browser brought back.
		 *
		 * The browser callback and the "I've finished" button both land here,
		 * so the second of the two sees a completed attempt and changes nothing.
		 */
		[ROUTES.linkOauthComplete]: route(
			McpAuthCompleteRequestSchema,
			async (body) => {
				const attempt = await store.getAuthAttempt(body.attemptId);
				if (!attempt) return json({ ok: false, error: "That sign-in is no longer available." }, 404);
				const firstFinish = attempt.status === "pending";
				const result = await finishAuthorization(store, attempt, {
					...(body.code ? { code: body.code } : {}),
					...(body.error ? { error: body.error } : {}),
				});
				if (firstFinish && result.link) {
					const message = `**${result.link.name} is connected.** ${describeTools(result.tools ?? [])} Eryn will use it on the next turn.`;
					if (attempt.applicationId && attempt.interactionToken) {
						await rest
							.interactionEditOriginal(attempt.applicationId, attempt.interactionToken, message, { components: [] })
							.catch((error) => log("session", `could not update the MCP sign-in message: ${describeError(error)}`));
					}
				}
				return json({
					ok: result.status === "complete",
					status: result.status,
					...(result.message ? { message: result.message } : {}),
					...(result.link ? { link: publicLink(result.link) } : {}),
					...(result.tools ? { tools: result.tools } : {}),
				});
			},
			(error) => json({ ok: false, status: "failed", message: describeError(error) }, 502),
		),

		[ROUTES.prompt]: route(PromptRequestSchema, async (body) => {
			const config = await loadConfig(true);
			if (config.connections.length === 0) {
				return json({ ok: false, error: "no provider is connected" }, 400);
			}
			await agent.prompt(body, await reconcileModel(config));
			// The turn may have created or changed a schedule; arm for it.
			await armScheduleAlarm();
			return json({ ok: true });
		}),

		[ROUTES.interrupt]: openRoute(InterruptRequestSchema, async (body) =>
			json({ stopped: await agent.interrupt(body.threadId, body.gone === true) }),
		),
	};

	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const found = request.method === "POST" ? routes[url.pathname] : undefined;
		if (!found) return json({ error: "not found" }, 404);

		let body: unknown;
		if (found.schema) {
			const parsed = await parseBody(found.schema, request);
			if (parsed instanceof Response) return parsed;
			if (found.scoped && guildId && (parsed as { guildId?: unknown }).guildId !== guildId) {
				return json({ error: "guild mismatch" }, 403);
			}
			body = parsed;
		}

		try {
			return await found.handle(body);
		} catch (error) {
			return found.onFailure(error);
		}
	};
}
