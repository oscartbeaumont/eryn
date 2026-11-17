/**
 * The internal HTTP API of a guild object.
 *
 * The bot gateway calls these routes; every body is parsed from its Effect
 * `Schema` before a handler sees it, and a body that names a guild must match
 * the object it reached. Keeping the table here leaves the Durable Object with
 * its lifecycle (alarms, deploys, scheduling) rather than its endpoints.
 */

import { Option, Schema } from "effect";

import { analytics as productAnalytics } from "../analytics";
import { isValidModel, log } from "../config";
import type { DiscordRest } from "../discord/api";
import { describeError } from "../errors";
import { json } from "../http";
import { stringField, toJsonObject } from "../json.ts";
import { describeTools } from "../mcp/describe";
import { beginAuthorization, finishAuthorization, refreshLink, testLink } from "../mcp/links";
import { applyElicitation } from "../mcp/elicitation";
import { AUTH_TTL_MS } from "../mcp/paths";
import { probeServer, type ProbeOptions } from "../mcp/probe";
import { type Mutable } from "../mutable.ts";
import type { GuildAgent } from "./agent";
import type { HostConfig } from "./host-config";
import { channelProjectDirectory } from "./locations";
import {
	ApprovalReplyRequestSchema,
	CommandListRequestSchema,
	CommandRequestSchema,
	CompactRequestSchema,
	ContextUpdateRequestSchema,
	DisconnectRequestSchema,
	FormCancelRequestSchema,
	FormFieldRequestSchema,
	FormGetRequestSchema,
	FormReplyRequestSchema,
	FormTextRequestSchema,
	GuildRefSchema,
	InterruptRequestSchema,
	InteractRequestSchema,
	LinkAddRequestSchema,
	LinkElicitationRequestSchema,
	LinkRemoveRequestSchema,
	McpAuthAttemptRequestSchema,
	McpAuthCompleteRequestSchema,
	McpAuthStartRequestSchema,
	McpProbeRequestSchema,
	McpTestRequestSchema,
	ModelRequestSchema,
	PolicyClearRequestSchema,
	PolicyGetRequestSchema,
	PolicySetRequestSchema,
	ProfileDefaultRequestSchema,
	ProfileRemoveRequestSchema,
	ProfileSetRequestSchema,
	PromptRequestSchema,
	ProviderConnectRequestSchema,
	type GuildSettings,
	type McpAuthCompleteResponse,
	type McpAuthStatus,
	type McpLink,
	type ProviderConnectRequest,
	type PublicLink,
} from "./models";
import { ROUTES } from "./paths";
import type { GuildStore } from "./store";

/** Everything a route handler may use from the guild object. */
export interface RouteContext {
	readonly env: Env;
	readonly guildId: string;
	readonly rest: DiscordRest;
	readonly store: GuildStore;
	readonly agent: GuildAgent;
	loadConfig(refresh?: boolean): Promise<HostConfig>;
	reconcileModel(config: HostConfig): Promise<HostConfig>;
}

/** The secrets a link carries are the bearer and, for OAuth, the refresh pair. */
function publicLink(link: McpLink): PublicLink {
	const { token: _token, oauth: _oauth, ...rest } = link;

	return rest;
}

/** A link's host, which identifies the service without its path or credentials. */
function urlHost(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return "unknown";
	}
}

/**
 * Parse a request body, or produce the `400` response it should get instead.
 *
 * Both the JSON document and its decoded value come back: the guild check reads
 * the raw document, and the handler takes the value its schema produced.
 */
async function parseBody<S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	request: Request,
): Promise<{ readonly document: Schema.JsonObject; readonly value: S["Type"] } | Response> {
	try {
		const body = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Json)(await request.json()));

		return {
			document: toJsonObject(body) ?? {},
			value: Schema.decodeUnknownSync(schema)(body),
		};
	} catch (error) {
		return json({ error: `could not read the request: ${describeError(error)}` }, 400);
	}
}

/** The route table, keyed by path. */
interface RouteTable {
	readonly [path: string]: Route;
}

interface Route {
	/** Omitted for a route that carries no JSON body. */
	readonly schema?: Schema.ConstraintDecoder<unknown>;
	/** Whether the body names the guild and must match this object. */
	readonly scoped?: boolean;
	/**
	 * The route's handler.
	 *
	 * The parameter is `never` because the table is heterogeneous: each entry's
	 * schema and handler agree, but the table only knows the erased shape.
	 */
	readonly handle: (body: never) => Promise<Response>;
	readonly onFailure: ThrownFailure;
}

/** A handler that turns a thrown failure into its response. */
type ThrownFailure = <Thrown>(error: Thrown) => Response;

const internalFailure: ThrownFailure = (error) => json({ error: describeError(error) }, 500);

const badGateway: ThrownFailure = (error) => json({ error: describeError(error) }, 502);

const probeFailure: ThrownFailure = (error) => json({ ok: false, tools: [], error: describeError(error) }, 502);

/** A route whose body names the guild, so it must match this object. */
function route<S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	handle: (body: S["Type"]) => Promise<Response>,
	failure: ThrownFailure = internalFailure,
): Route {
	return { schema, scoped: true, handle, onFailure: failure };
}

/** A route whose body carries no guild id, such as an interrupt. */
function openRoute<S extends Schema.ConstraintDecoder<unknown>>(
	schema: S,
	handle: (body: S["Type"]) => Promise<Response>,
	failure: ThrownFailure = internalFailure,
): Route {
	return { schema, handle, onFailure: failure };
}

/** Everything a route table entry may use, including the per-object metrics client. */
type RouteDeps = RouteContext & {
	readonly metrics: ReturnType<typeof productAnalytics>;
};

/** Record an OAuth connection and move the guild onto a model it can run. */
async function recordOAuth(deps: RouteDeps, integrationID: string, firstProvider: boolean): Promise<void> {
	await deps.store.putProvider({ integrationID, method: "oauth", key: "" });
	await deps.store.clearPendingOAuth();
	const next = await deps.reconcileModel(await deps.loadConfig());
	await deps.metrics.capture("provider_connected", { provider: integrationID, first: firstProvider });

	if (firstProvider) await deps.metrics.capture("setup_completed", { provider: integrationID, model: next.model });
}

/** A key connection is a single step: replay the key, then record the connection. */
async function connectWithKey(
	deps: RouteDeps,
	config: HostConfig,
	body: ProviderConnectRequest,
	key: string,
): Promise<Response> {
	const firstProvider = config.connections.length === 0;

	await deps.agent.connectKey(config, body.integrationID, key);
	await deps.store.putProvider({ integrationID: body.integrationID, method: body.methodID ?? "key", key });
	const next = await deps.reconcileModel(await deps.loadConfig());
	await deps.metrics.capture("provider_connected", { provider: body.integrationID, first: firstProvider });

	if (firstProvider) {
		await deps.metrics.capture("setup_completed", { provider: body.integrationID, model: next.model });
	}

	return json({ ok: true });
}

/** Connect, poll, or finish a provider sign-in. */
async function connectProvider(deps: RouteDeps, body: ProviderConnectRequest): Promise<Response> {
	const config = await deps.loadConfig();
	const firstProvider = config.connections.length === 0;

	if (body.key !== undefined && body.action === undefined) {
		return await connectWithKey(deps, config, body, body.key);
	}

	const action = body.action ?? "start";

	if (action === "start") {
		const result = await deps.agent.oauthConnect(config, body.integrationID, body.methodID ?? "", body.answer ?? {});

		if ("error" in result) return json({ error: result.error }, 400);
		await deps.store.putPendingOAuth({
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
	const pending = await deps.store.pendingOAuth();

	const attemptID =
		body.attemptID ??
		(pending && pending.integrationID === body.integrationID ? pending.attemptID : undefined);

	if (!attemptID) return json({ error: "Start the sign-in again." }, 400);

	if (action === "status") {
		const status = await deps.agent.oauthStatus(config, body.integrationID, attemptID);

		if (status.status === "complete") await recordOAuth(deps, body.integrationID, firstProvider);

		return json({ status });
	}

	if (action === "complete") {
		await deps.agent.oauthComplete(config, body.integrationID, attemptID, body.code);
		await recordOAuth(deps, body.integrationID, firstProvider);

		return json({ ok: true });
	}

	await deps.agent.oauthCancel(config, body.integrationID, attemptID);
	await deps.store.clearPendingOAuth();

	return json({ ok: true });
}

/** The status and model routes a setup screen reads. */
function settingsRoutes(deps: RouteDeps): RouteTable {
	return {
		[ROUTES.config]: route(GuildRefSchema, async () => {
			const settings = await deps.store.settings();
			const connections = await deps.store.providers();
			// A status read does not need a live token; the turn does, and
			// refreshing here would put network calls in front of a reply.
			const links = await deps.store.links();

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

		[ROUTES.model]: route(ModelRequestSchema, async (body) => {
			const model = body.model.trim();

			if (!isValidModel(model)) return json({ error: "model must be a provider/model reference" }, 400);
			const config = await deps.loadConfig();
			const models = await deps.agent.models(config).catch(() => []);
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

			const existing = await deps.store.settings();
			const next: Mutable<GuildSettings> = { model, updatedAt: Date.now() };

			if (existing.configuredBy) next.configuredBy = existing.configuredBy;

			await deps.store.putSettings(next);

			return json({ ok: true });
		}),
	};
}

/** Connecting and disconnecting a provider. */
function providerRoutes(deps: RouteDeps): RouteTable {
	return {
		[ROUTES.providers]: route(
			GuildRefSchema,
			async () => json({ integrations: await deps.agent.integrations(await deps.loadConfig()) }),
			badGateway,
		),

		[ROUTES.models]: route(
			GuildRefSchema,
			async () => json({ models: await deps.agent.models(await deps.loadConfig()) }),
			badGateway,
		),

		[ROUTES.providerConnect]: route(
			ProviderConnectRequestSchema,
			async (body) => await connectProvider(deps, body),
			badGateway,
		),

		[ROUTES.disconnect]: route(
			DisconnectRequestSchema,
			async (body) => {
				await deps.agent.disconnect(await deps.loadConfig(), body.integrationID);
				await deps.store.removeProvider(body.integrationID);

				// If another provider is still connected, move the guild off a
				// model whose provider was just removed.
				if ((await deps.store.providers()).length > 0) await deps.reconcileModel(await deps.loadConfig());

				return json({ ok: true });
			},
			badGateway,
		),
	};
}

/** The MCP link list, tests, and the three-step sign-in. */
function linkRoutes(deps: RouteDeps): RouteTable {
	return {
		[ROUTES.links]: route(GuildRefSchema, async () => json({ links: (await deps.store.links()).map(publicLink) })),

		[ROUTES.linkAdd]: route(LinkAddRequestSchema, async (body) => {
			const link = body.link;
			const existing = await deps.store.links();

			if (existing.some((candidate) => candidate.name === link.name && candidate.id !== link.id)) {
				return json({ error: `A server named "${link.name}" is already linked.` }, 400);
			}

			await deps.store.putLink(link);
			await deps.metrics.capture("mcp_connected", { host: urlHost(link.url) });

			return json({ ok: true });
		}),

		[ROUTES.linkRemove]: route(LinkRemoveRequestSchema, async (body) => {
			await deps.store.removeLink(body.linkId);

			return json({ ok: true });
		}),

		/**
		 * Move a link's approval questions, keeping its bearer.
		 *
		 * The link is read here rather than sent by the bot, so changing a
		 * setting never round-trips a token or an OAuth pair through the gateway.
		 */
		[ROUTES.linkElicitation]: route(LinkElicitationRequestSchema, async (body) => {
			const link = await deps.store.getLink(body.linkId);

			if (!link) return json({ error: "That MCP server is no longer linked." }, 404);
			await deps.store.putLink({
				...link,
				elicitation: body.elicitation,
				url: applyElicitation(link.url, body.elicitation),
			});

			return json({ ok: true });
		}),

		/** Test a URL before it is linked: what it offers, or what it wants. */
		[ROUTES.linkProbe]: route(
			McpProbeRequestSchema,
			async (body) => {
				const options: Mutable<ProbeOptions> = { url: body.url };

				if (body.token) options.token = body.token;

				return json(await probeServer(options));
			},
			probeFailure,
		),

		/** Test a link that is already stored, refreshing its token first. */
		[ROUTES.linkTest]: route(
			McpTestRequestSchema,
			async (body) => {
				const link = await deps.store.getLink(body.linkId);

				if (!link) return json({ ok: false, tools: [], error: "That MCP server is no longer linked." }, 404);

				return json(await testLink(await refreshLink(deps.store, link)));
			},
			probeFailure,
		),

		/** Start a sign-in: discover, register, and return the URL to open. */
		[ROUTES.linkOauthStart]: route(
			McpAuthStartRequestSchema,
			async (body) => {
				const name = body.name.trim();

				if (!name) return json({ ok: false, error: "A name is required." }, 400);
				const links = await deps.store.links();

				if (links.some((link) => link.name === name)) {
					return json({ ok: false, error: `A server named "${name}" is already linked.` }, 400);
				}

				const probe = await probeServer({ url: body.url });

				if (probe.ok) {
					return json({ ok: false, error: "This server did not ask for a sign-in." }, 400);
				}

				try {
					const input: Parameters<typeof beginAuthorization>[0] = {
						store: deps.store,
						env: deps.env,
						guildId: deps.guildId,
						name,
						url: body.url,
					};

					if (body.elicitation) input.elicitation = body.elicitation;

					if (body.applicationId) input.applicationId = body.applicationId;

					if (body.interactionToken) input.interactionToken = body.interactionToken;

					if (probe.resourceMetadataUrl) input.resourceMetadataUrl = probe.resourceMetadataUrl;

					if (probe.scope) input.scope = probe.scope;

					const started = await beginAuthorization(input);

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
				const attempt = await deps.store.getAuthAttempt(body.attemptId);

				if (!attempt) return json({ status: "missing" });

				if (attempt.status === "pending" && Date.now() - attempt.createdAt > AUTH_TTL_MS) {
					const message = "That sign-in expired. Start it again from `/eryn setup` under MCP servers.";
					await deps.store.putAuthAttempt({ ...attempt, status: "failed", message });

					return json({ status: "failed", message });
				}

				const link = attempt.linkId ? await deps.store.getLink(attempt.linkId) : undefined;
				const payload: Mutable<McpAuthStatus> = { status: attempt.status };

				if (attempt.message) payload.message = attempt.message;

				if (link) payload.link = publicLink(link);

				return json(payload);
			},
			(error) => json({ status: "failed", message: describeError(error) }),
		),

		/** Resolve a started sign-in to its full authorization URL. */
		[ROUTES.linkOauthUrl]: route(McpAuthAttemptRequestSchema, async (body) => {
			const attempt = await deps.store.getAuthAttempt(body.attemptId);

			if (!attempt?.authorizationUrl) return json({ error: "That sign-in is no longer available." }, 404);

			if (attempt.status !== "pending") return json({ error: "That sign-in is no longer pending." }, 404);

			if (Date.now() - attempt.createdAt > AUTH_TTL_MS) {
				await deps.store.putAuthAttempt({ ...attempt, status: "failed", message: "That sign-in expired." });

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
				const attempt = await deps.store.getAuthAttempt(body.attemptId);

				if (!attempt) return json({ ok: false, error: "That sign-in is no longer available." }, 404);
				const firstFinish = attempt.status === "pending";
				const finished: Mutable<Parameters<typeof finishAuthorization>[2]> = {};

				if (body.code) finished.code = body.code;

				if (body.error) finished.error = body.error;

				const result = await finishAuthorization(deps.store, attempt, finished);

				if (firstFinish && result.link) {
					await deps.metrics.capture("mcp_connected", { host: urlHost(result.link.url) });
					const message = `**${result.link.name} is connected.** ${describeTools(result.tools ?? [])} Eryn will use it on the next turn.`;

					if (attempt.applicationId && attempt.interactionToken) {
						await deps.rest
							.interactionEditOriginal(attempt.applicationId, attempt.interactionToken, message, { components: [] })
							.catch((error) => log("session", `could not update the MCP sign-in message: ${describeError(error)}`));
					}
				}

				const payload: Mutable<McpAuthCompleteResponse> = {
					ok: result.status === "complete",
					status: result.status,
				};

				if (result.message) payload.message = result.message;

				if (result.link) payload.link = publicLink(result.link);

				if (result.tools) payload.tools = result.tools;

				return json(payload);
			},
			(error) => json({ ok: false, status: "failed", message: describeError(error) }, 502),
		),
	};
}

/** Prompts, commands, and the context a conversation stores. */
function conversationRoutes(deps: RouteDeps): RouteTable {
	return {
		[ROUTES.prompt]: route(PromptRequestSchema, async (body) => {
			const config = await deps.loadConfig(true);

			if (config.connections.length === 0) {
				return json({ ok: false, error: "no provider is connected" }, 400);
			}

			await deps.agent.prompt(body, await deps.reconcileModel(config));

			// The object's alarm is re-armed after this request returns, so a
			// schedule the turn created still fires on time.
			return json({ ok: true });
		}),

		[ROUTES.command]: route(CommandRequestSchema, async (body) => {
			const config = await deps.loadConfig(true);

			if (config.connections.length === 0) {
				return json({ ok: false, error: "no provider is connected" }, 400);
			}

			return json(await deps.agent.command(body, await deps.reconcileModel(config)));
		}),

		[ROUTES.commands]: route(CommandListRequestSchema, async (body) =>
			json({
				commands: await deps.agent.commands(
					await deps.loadConfig(),
					channelProjectDirectory(body.channelId),
				),
			}),
		),

		/**
		 * Keep a conversation's stored description current after a rename.
		 *
		 * A rename is not a prompt: with no provider there is no scheduled turn
		 * to keep current, and the next prompt writes the context anyway. When
		 * there is a session, the stored copy is corrected now so a schedule
		 * that fires before the next message still sees the new name.
		 */
		[ROUTES.context]: route(ContextUpdateRequestSchema, async (body) => {
			const config = await deps.loadConfig();

			if (config.connections.length > 0) {
				await deps.agent.updateContext(await deps.reconcileModel(config), body.threadId, body.discord);
			}

			return json({ ok: true });
		}),
	};
}

/** Policy reads and writes, profiles, and approval replies. */
function policyRoutes(deps: RouteDeps): RouteTable {
	return {
		[ROUTES.policy]: route(PolicyGetRequestSchema, async (body) => {
			const query: Mutable<Parameters<GuildAgent["policyState"]>[0]> = { channelId: body.channelId };

			if (body.threadId) query.threadId = body.threadId;

			return json(await deps.agent.policyState(query));
		}),

		[ROUTES.policySet]: route(PolicySetRequestSchema, async (body) => {
			const state = await deps.agent.setPolicy(body);

			return json({ ok: true, state });
		}),

		[ROUTES.policyClear]: route(PolicyClearRequestSchema, async (body) => {
			const state = await deps.agent.clearPolicy(body);

			return json({ ok: true, state });
		}),

		[ROUTES.profiles]: route(GuildRefSchema, async () => json(await deps.agent.profiles())),

		[ROUTES.profileSet]: route(ProfileSetRequestSchema, async (body) => {
			const state = await deps.agent.putProfile(body);

			return json({ ok: true, ...state });
		}),

		[ROUTES.profileRemove]: route(ProfileRemoveRequestSchema, async (body) => {
			const state = await deps.agent.removeProfile(body.id);

			return json({ ok: true, ...state });
		}),

		[ROUTES.profileDefault]: route(ProfileDefaultRequestSchema, async (body) => {
			const state = await deps.agent.setDefaultProfile(body.id);

			return json({ ok: true, ...state });
		}),

		[ROUTES.approval]: route(ApprovalReplyRequestSchema, async (body) => json(await deps.agent.replyApproval(body))),
	};
}

/** Forms, interrupts, compaction, and the destructive reset. */
function formRoutes(deps: RouteDeps): RouteTable {
	return {
		[ROUTES.form]: route(FormGetRequestSchema, async (body) => {
			const auth: Mutable<NonNullable<Parameters<GuildAgent["formView"]>[1]>> = {};

			if (body.userId) auth.userId = body.userId;

			if (body.manager !== undefined) auth.manager = body.manager;

			const view = await deps.agent.formView(body.formId, auth);

			return view ? json(view) : json({ error: "That form is no longer waiting." }, 404);
		}),

		[ROUTES.formReply]: route(FormReplyRequestSchema, async (body) => json(await deps.agent.replyForm(body))),

		[ROUTES.formField]: route(FormFieldRequestSchema, async (body) => json(await deps.agent.answerFormField(body))),

		[ROUTES.formText]: route(FormTextRequestSchema, async (body) => json(await deps.agent.answerFormText(body))),

		[ROUTES.formCancel]: route(FormCancelRequestSchema, async (body) => json(await deps.agent.cancelForm(body))),

		[ROUTES.interrupt]: openRoute(InterruptRequestSchema, async (body) => {
			const gone = body.gone === true;
			// A deleted conversation has to be cleaned up even when this object
			// was cold, so the config lets the agent build the host it needs to
			// remove the Session and stop a suspended turn from resuming.
			const config = gone ? await deps.loadConfig().catch(() => undefined) : undefined;

			return json({ stopped: await deps.agent.interrupt(body.threadId, gone, config) });
		}),

		/** Compact one conversation's history, at a member's request. */
		[ROUTES.compact]: route(CompactRequestSchema, async (body) => {
			const config = await deps.loadConfig(true).catch(() => undefined);

			if (!config || config.connections.length === 0) {
				return json({ ok: false, message: "Connect a provider before compacting a conversation." });
			}

			return json(await deps.agent.compact(body.threadId, config));
		}),

		/** Wipe the guild's files and restore the seeded defaults. */
		[ROUTES.reset]: route(GuildRefSchema, async () => json(await deps.agent.reset())),

		/** Whether a speaker covers the capability scope of this conversation. */
		[ROUTES.interact]: route(InteractRequestSchema, async (body) =>
			json(await deps.agent.canInteract(body.threadId, body.userId)),
		),
	};
}

/** Build the route table and the dispatcher that serves it. */
export function buildRoutes(ctx: RouteContext): (request: Request) => Promise<Response> {
	const deps: RouteDeps = { ...ctx, metrics: productAnalytics(ctx.env, ctx.guildId) };

	const routes: RouteTable = {
		...settingsRoutes(deps),
		...providerRoutes(deps),
		...linkRoutes(deps),
		...conversationRoutes(deps),
		...policyRoutes(deps),
		...formRoutes(deps),
	};

	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const found = request.method === "POST" ? routes[url.pathname] : undefined;

		if (!found) return json({ error: "not found" }, 404);

		let body: unknown;

		if (found.schema) {
			const parsed = await parseBody(found.schema, request);

			if (parsed instanceof Response) return parsed;

			if (found.scoped && ctx.guildId && stringField(parsed.document, "guildId") !== ctx.guildId) {
				return json({ error: "guild mismatch" }, 403);
			}

			body = parsed.value;
		}

		try {
			// SAFETY: `parseBody` decoded `body` with this route's schema, which is the
			// type its handler takes; the table erases that type for every route.
			return await found.handle(body as never);
		} catch (error) {
			return found.onFailure(error);
		}
	};
}
