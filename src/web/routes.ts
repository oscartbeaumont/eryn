/** The browser routes: sign-in, the server list, and server settings. */

import { capture } from "../analytics.ts";
import { log } from "../config.ts";
import { describeError } from "../errors.ts";
import { toJsonObject } from "../json.ts";
import { PermissionOverridesSchema, ServerPolicySchema, defaultPolicy } from "../core/policy.ts";
import type { PermissionOverrides, RoleMapping } from "../core/policy.ts";
import type { Mutable } from "../mutable.ts";
import { Schema } from "effect";

import type { CallResult } from "../platform/clients.ts";
import {
	clearSessionCookie,
	controlCall,
	currentUser,
	field,
	formFields,
	ownedServers,
	ownsServer,
	serverCall,
	sessionCookie,
	sessionId,
	truthy,
} from "../platform/clients.ts";
import { dashboardPage, loginPage } from "./pages.ts";
import { serverPage } from "./server-page.ts";
import type { ServerPageData } from "./server-page.ts";

interface RoleDraft {
	roleId: string;
	roleName: string;
	profileId: string;
	overrides?: PermissionOverrides;
}

interface McpConnection {
	name: string;
	status: string;
	error?: string;
}

interface ServerQuery {
	ok?: string;
	error?: string;
	guild?: string;
	oauth?: string;
	integration?: string;
	claim?: string;
}

interface LinkBody {
	name: string;
	url: string;
	token?: string;
	elicitation?: "off" | "chat" | "browser" | "agent";
}

interface AttachBody {
	channelId: string;
	provider: string;
	name?: string;
	containerId?: string;
}

function redirect(location: string): Response {
	return new Response(null, { status: 303, headers: { location } });
}

function serverUrl(id: string, query: ServerQuery = {}): string {
	const params = new URLSearchParams();

	if (query.ok) params.set("ok", query.ok);
	if (query.error) params.set("error", query.error);
	if (query.guild) params.set("guild", query.guild);
	if (query.oauth) params.set("oauth", query.oauth);
	if (query.integration) params.set("integration", query.integration);
	if (query.claim) params.set("claim", query.claim);
	const suffix = params.toString() ? "?" + params.toString() : "";

	return "/app/servers/" + encodeURIComponent(id) + suffix;
}

/** Same-origin check for a form post. */
function sameOrigin(request: Request): boolean {
	const origin = request.headers.get("origin");

	if (!origin) return true;

	try {
		return new URL(origin).origin === new URL(request.url).origin;
	} catch {
		return false;
	}
}

export async function handleWeb(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | undefined> {
	const url = new URL(request.url);
	const path = url.pathname;

	if (path === "/login" && request.method === "GET") return loginPage({});
	if (path === "/login" && request.method === "POST") return await sendCode(request, env);
	if (path === "/verify" && request.method === "GET") {
		return loginPage({ sent: true, email: url.searchParams.get("email") ?? undefined });
	}
	if (path === "/verify" && request.method === "POST") return await verifyCode(request, env);
	if (path === "/logout" && request.method === "POST") return await logout(request, env);

	if (path === "/app" && request.method === "GET") return await dashboard(request, env);
	if (path === "/app/servers" && request.method === "POST") return await createServer(request, env, ctx);

	if (path.startsWith("/app/servers/")) {
		const parts = path.slice("/app/servers/".length).split("/");
		const id = parts[0] ?? "";

		if (!id) return redirect("/app");

		if (parts.length === 1 && request.method === "GET") return await serverSettings(request, env, id);

		if (parts.length > 1 && request.method === "POST") {
			return await serverAction(request, env, id, parts.slice(1).join("/"));
		}
	}

	return undefined;
}

async function sendCode(request: Request, env: Env): Promise<Response> {
	if (!sameOrigin(request)) return loginPage({ error: "That request did not come from this site." });
	const fields = await formFields(request);
	const email = field(fields, "email");
	const result = await controlCall(env, "/code", { email });

	if (!result.ok) return loginPage({ error: typeof result.data.error === "string" ? result.data.error : "Could not send a code." });

	return redirect("/verify?email=" + encodeURIComponent(email));
}

async function verifyCode(request: Request, env: Env): Promise<Response> {
	if (!sameOrigin(request)) return loginPage({ sent: true, error: "That request did not come from this site." });
	const fields = await formFields(request);
	const result = await controlCall(env, "/verify", {
		email: field(fields, "email"),
		code: field(fields, "code"),
	});

	if (!result.ok || typeof result.data.session !== "string") {
		return loginPage({
			sent: true,
			error: typeof result.data.error === "string" ? result.data.error : "That code was not accepted.",
		});
	}

	const secure = new URL(request.url).protocol === "https:";
	const headers = new Headers({ location: "/app" });
	headers.append("set-cookie", sessionCookie(result.data.session, secure));

	return new Response(null, { status: 303, headers });
}

async function logout(request: Request, env: Env): Promise<Response> {
	const id = sessionId(request);

	if (id) await controlCall(env, "/logout", { id }).catch(() => undefined);
	const headers = new Headers({ location: "/" });
	headers.append("set-cookie", clearSessionCookie());

	return new Response(null, { status: 303, headers });
}

async function dashboard(request: Request, env: Env): Promise<Response> {
	const user = await currentUser(env, request);

	if (!user) return redirect("/login");
	const servers = await ownedServers(env, user.id);

	return dashboardPage({ email: user.email, servers });
}

async function createServer(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (!sameOrigin(request)) return redirect("/app");
	const user = await currentUser(env, request);

	if (!user) return redirect("/login");
	const fields = await formFields(request);
	const name = field(fields, "name").trim() || "My agent";
	const created = await controlCall(env, "/servers/create", { userId: user.id, name });
	const server = created.data.server;
	const id = typeof server === "object" && server !== null && "id" in server ? String(server.id) : "";

	if (!created.ok || !id) return dashboardPage({ email: user.email, servers: await ownedServers(env, user.id), error: "The server could not be created." });

	ctx.waitUntil(capture(env, "server_created", {}, { serverId: id }));

	await serverCall(env, id, "/init", { id, name, ownerId: user.id }, new URL(request.url).origin).catch((error: unknown) => {
		log("web", "could not initialise " + id + ": " + describeError(error));
	});

	return redirect(serverUrl(id));
}

async function serverSettings(request: Request, env: Env, id: string): Promise<Response> {
	const user = await currentUser(env, request);

	if (!user) return redirect("/login");

	if (!(await ownsServer(env, user.id, id))) return new Response("Not found", { status: 404 });
	const origin = new URL(request.url).origin;
	const url = new URL(request.url);
	const status = await serverCall(env, id, "/status", {}, origin);
	const server = toJsonObject(status.data.server);
	const messages = toJsonObject(status.data.messaging) ?? {};
	const discord = toJsonObject(messages.discord);
	const guildsResult = await serverCall(env, id, "/discord/guilds", {}, origin);
	const guilds = Array.isArray(guildsResult.data.guilds) ? guildsResult.data.guilds : [];
	const configuredGuild = typeof discord?.guildId === "string" ? discord.guildId : "";
	const guild = url.searchParams.get("guild") ?? configuredGuild;
	const guildChannels = guild
		? (await serverCall(env, id, "/discord/channels", { guildId: guild }, origin)).data.channels
		: [];
	const oauthAttemptId = url.searchParams.get("oauth");
	const oauthResult = oauthAttemptId
		? await serverCall(env, id, "/inference/oauth", { attemptID: oauthAttemptId }, origin)
		: undefined;
	const oauth = oauthResult ? toJsonObject(oauthResult.data.attempt) : undefined;
	const channels = await serverCall(env, id, "/channels", {}, origin);
	const links = await serverCall(env, id, "/links", {}, origin);
	const plugins = await serverCall(env, id, "/plugins", {}, origin);
	const automationsResult = await serverCall(env, id, "/automations", {}, origin);
	const modelsResult = await serverCall(env, id, "/models", {}, origin);
	const mcp = Array.isArray(status.data.mcp) ? status.data.mcp : [];
	const policy = Schema.decodeUnknownOption(ServerPolicySchema)(status.data.policy);
	const currentPolicy = policy._tag === "Some" ? policy.value : defaultPolicy();
	const discordRolesResult = guild
		? await serverCall(env, id, "/discord/roles", { guildId: guild }, origin)
		: { ok: true, status: 200, data: {} };
	const discordRoles = Array.isArray(discordRolesResult.data.roles)
		? (discordRolesResult.data.roles as Array<{ id: string; name: string }>)
		: [];
	const data: Mutable<ServerPageData> = {
		email: user.email,
		id,
		name: typeof server?.name === "string" ? server.name : "Eryn",
		model: typeof server?.model === "string" ? server.model : "",
		ready: status.data.ready === true,
		channels: Array.isArray(channels.data.channels)
			? (channels.data.channels as Array<{ id: string; provider: string; name?: string; enabled: boolean }>)
			: [],
		messaging: {
			discord: toJsonObject(messages.discord),
			imessage: toJsonObject(messages.imessage),
		},
		providers: Array.isArray(status.data.providers)
			? (status.data.providers as Array<{ integrationID: string; method: string }>)
			: [],
		links: Array.isArray(links.data.links)
			? (links.data.links as Array<{ id: string; name: string; url: string }>)
			: [],
		policy: currentPolicy,
		discordRoles,
		models: Array.isArray(modelsResult.data.models)
			? (modelsResult.data.models as Array<{ providerID: string; modelID: string; name: string }>).map(
					(model) => ({ id: model.providerID + "/" + model.modelID, name: model.name }),
				)
			: [],
		mcp: mcp.flatMap((entry) => {
			const server = toJsonObject(entry as Schema.Json);
			const state = toJsonObject(server?.status);
			const name = typeof server?.name === "string" ? server.name : undefined;
			const status = typeof state?.status === "string" ? state.status : undefined;

			if (!name || !status) return [];
			const failure = typeof state?.error === "string" ? state.error : undefined;
			const connection: McpConnection = { name, status };

			if (failure) connection.error = failure;

			return [connection];
		}),
		automations: Array.isArray(automationsResult.data.automations)
			? (automationsResult.data.automations as Array<{
					channelId: string;
					channelName?: string;
					id: string;
					name: string;
					status: string;
					runCount: number;
				}>)
			: [],
		plugins: Array.isArray(plugins.data.plugins)
			? (plugins.data.plugins as Array<{ id: string; name: string; version: string; enabled: boolean }>)
			: [],
		guilds: Array.isArray(guilds) ? (guilds as Array<{ id: string; name: string }>) : [],
		guildChannels: Array.isArray(guildChannels)
			? (guildChannels as Array<{ id: string; name: string }>)
			: [],
	};

	if (guild) data.guild = guild;
	if (typeof messages.webhookUrl === "string") data.messaging.webhookUrl = messages.webhookUrl;

	if (
		oauth &&
		typeof oauth.integrationID === "string" &&
		typeof oauth.attemptID === "string" &&
		typeof oauth.url === "string" &&
		typeof oauth.instructions === "string" &&
		typeof oauth.mode === "string"
	) {
		data.oauth = {
			integrationID: oauth.integrationID,
			attemptID: oauth.attemptID,
			url: oauth.url,
			instructions: oauth.instructions,
			mode: oauth.mode,
		};
	}

	const claim = url.searchParams.get("claim");
	const error = url.searchParams.get("error");
	const ok = url.searchParams.get("ok");

	if (claim) data.claim = claim;
	if (error) data.error = error;
	if (ok) data.ok = ok;

	return serverPage(data);
}

async function serverAction(request: Request, env: Env, id: string, action: string): Promise<Response> {
	if (!sameOrigin(request)) return redirect(serverUrl(id, { error: "That request did not come from this site." }));
	const user = await currentUser(env, request);

	if (!user) return redirect("/login");

	if (!(await ownsServer(env, user.id, id))) return new Response("Not found", { status: 404 });
	const fields = await formFields(request);
	const origin = new URL(request.url).origin;
	let result: CallResult | undefined;
	let ok = "Saved.";
	let guild: string | undefined;
	let oauth: string | undefined;
	let integration: string | undefined;
	let external: string | undefined;
	let claim: string | undefined;

	switch (action) {
		case "rename":
			result = await serverCall(env, id, "/rename", { name: field(fields, "name") }, origin);
			break;
		case "inference/oauth/start": {
			const integrationID = field(fields, "integrationID");
			const started = await serverCall(
				env,
				id,
				"/inference/oauth/start",
				{ integrationID, methodID: field(fields, "methodID") || undefined },
				origin,
			);
			const attempt = toJsonObject(started.data.attempt);
			const attemptID = typeof attempt?.attemptID === "string" ? attempt.attemptID : undefined;

			if (started.ok && attemptID) {
				result = { ok: true, status: 200, data: {} };
				oauth = attemptID;
				integration = integrationID;
				ok = "Provider sign-in started.";
			} else {
				result = started;
			}

			break;
		}
		case "inference/oauth/complete":
			result = await serverCall(
				env,
				id,
				"/inference/oauth/complete",
				{
					integrationID: field(fields, "integrationID"),
					attemptID: field(fields, "attemptID"),
					code: field(fields, "code") || undefined,
				},
				origin,
			);
			ok = "Provider connected.";
			break;
		case "inference/oauth/check": {
			const integrationID = field(fields, "integrationID");
			const attemptID = field(fields, "attemptID");
			const status = await serverCall(
				env,
				id,
				"/inference/oauth/status",
				{ integrationID, attemptID },
				origin,
			);

			if (status.ok && status.data.status === "complete") {
				result = { ok: true, status: 200, data: {} };
				ok = "Provider connected.";
			} else {
				result = { ok: true, status: 200, data: {} };
				oauth = attemptID;
				integration = integrationID;
				ok = "Still waiting for the provider.";
			}

			break;
		}
		case "inference/oauth/cancel":
			result = await serverCall(
				env,
				id,
				"/inference/oauth/cancel",
				{ integrationID: field(fields, "integrationID"), attemptID: field(fields, "attemptID") },
				origin,
			);
			ok = "Provider sign-in cancelled.";
			break;
		case "inference/model":
			result = await serverCall(env, id, "/model", { model: field(fields, "model") }, origin);
			break;
		case "inference/connect":
			result = await serverCall(
				env,
				id,
				"/connect",
				{ integrationID: field(fields, "integrationID"), key: field(fields, "key") },
				origin,
			);
			ok = "Provider connected.";
			break;
		case "inference/disconnect":
			result = await serverCall(env, id, "/disconnect", { integrationID: field(fields, "integrationID") }, origin);
			ok = "Provider removed.";
			break;
		case "links/add": {
			const link: LinkBody = {
				name: field(fields, "name"),
				url: field(fields, "url"),
			};
			const token = field(fields, "token");
			const elicitation = field(fields, "elicitation");

			if (token) link.token = token;
			if (elicitation === "off" || elicitation === "chat" || elicitation === "browser" || elicitation === "agent") {
				link.elicitation = elicitation;
			}
			result = await serverCall(env, id, "/link/add", link, origin);
			const oauth = toJsonObject(result.data.oauth);

			if (result.ok && typeof oauth?.startUrl === "string") external = oauth.startUrl;
			ok = "MCP server added.";
			break;
		}
		case "links/test":
			result = await serverCall(env, id, "/link/test", { linkId: field(fields, "id") }, origin);
			ok = "The MCP server answered.";
			break;
		case "links/remove":
			result = await serverCall(env, id, "/link/remove", { id: field(fields, "id") }, origin);
			ok = "MCP server removed.";
			break;
		case "plugins/add":
			result = await serverCall(
				env,
				id,
				"/plugin/add",
				{
					name: field(fields, "name"),
					code: field(fields, "code"),
					allowNetwork: truthy(fields, "allowNetwork"),
				},
				origin,
			);
			ok = "Plugin added.";
			break;
		case "plugins/remove":
			result = await serverCall(env, id, "/plugin/remove", { id: field(fields, "id") }, origin);
			ok = "Plugin removed.";
			break;
		case "plugins/toggle":
			result = await serverCall(
				env,
				id,
				"/plugin/toggle",
				{ id: field(fields, "id"), enabled: field(fields, "enabled") === "true" },
				origin,
			);
			ok = "Plugin updated.";
			break;
		case "channels/attach": {
			const attach: AttachBody = {
				channelId: field(fields, "channelId"),
				provider: field(fields, "provider"),
			};
			const name = field(fields, "name");
			const containerId = field(fields, "containerId");

			if (name) attach.name = name;
			if (containerId) attach.containerId = containerId;
			result = await serverCall(env, id, "/channels/attach", attach, origin);
			ok = "Conversation connected.";
			break;
		}
		case "channels/detach":
			result = await serverCall(env, id, "/channels/detach", { channelId: field(fields, "channelId") }, origin);
			ok = "Conversation disconnected.";
			break;
		case "access/save": {
			const policyResult = await serverCall(env, id, "/policy", {}, origin);
			const decoded = Schema.decodeUnknownOption(ServerPolicySchema)(policyResult.data.policy);
			const current = decoded._tag === "Some" ? decoded.value : defaultPolicy();
			const roles: RoleMapping[] = [];
			const channelOverrides: Record<string, PermissionOverrides> = {};
			let invalid: string | undefined;

			for (const [key, value] of Object.entries(fields)) {
				if (!key.startsWith("role:") || !value) continue;
				const roleId = key.slice("role:".length);
				const roleName =
					field(fields, "rolename:" + roleId) ||
					current.roles.find((role) => role.roleId === roleId)?.roleName ||
					roleId;
				const raw = field(fields, "overrides:" + roleId).trim();
				let overrides: RoleMapping["overrides"];

				if (raw) {
					try {
						const parsed = JSON.parse(raw) as unknown;
						const decodedOverrides = Schema.decodeUnknownOption(PermissionOverridesSchema)(parsed);

						if (decodedOverrides._tag !== "Some") {
							invalid = "Overrides for " + roleName + " are not valid.";
							break;
						}

						overrides = decodedOverrides.value;
					} catch {
						invalid = "Overrides for " + roleName + " are not valid JSON.";
						break;
					}
				}

				const role: RoleDraft = { roleId, roleName, profileId: value };

				if (overrides) role.overrides = overrides;
				roles.push(role);
			}

			for (const [key, value] of Object.entries(fields)) {
				if (!key.startsWith("channel:")) continue;
				const channelId = key.slice("channel:".length);
				const raw = value.trim();

				if (!raw) continue;

				try {
					const parsed = JSON.parse(raw) as unknown;
					const decodedOverrides = Schema.decodeUnknownOption(PermissionOverridesSchema)(parsed);

					if (decodedOverrides._tag !== "Some") {
						invalid = "Channel overrides for " + channelId + " are not valid.";
						break;
					}

					channelOverrides[channelId] = decodedOverrides.value;
				} catch {
					invalid = "Channel overrides for " + channelId + " are not valid JSON.";
					break;
				}
			}

			result = invalid
				? { ok: false, status: 400, data: { error: invalid } }
				: await serverCall(
						env,
						id,
						"/policy/set",
						{
							defaultProfileId: field(fields, "defaultProfile"),
							roles,
							channelOverrides,
						},
						origin,
					);
			ok = "Access saved.";
			break;
		}
		case "messaging/discord":
			guild = field(fields, "guildId");
			result = await serverCall(env, id, "/messaging/discord", { guildId: guild }, origin);
			ok = "Discord server connected.";

			// Binding needs proof from inside Discord, so the page hands back a code.
			if (typeof result.data.claim === "string") {
				claim = result.data.claim;
				ok = "Run /eryn claim " + claim + " in Discord to finish.";
			}

			break;
		case "messaging/imessage":
			result = await serverCall(
				env,
				id,
				"/messaging/imessage",
				{
					apiKeyId: field(fields, "apiKeyId"),
					apiSecret: field(fields, "apiSecret"),
					fromNumber: field(fields, "fromNumber"),
					ownerNumber: field(fields, "ownerNumber"),
				},
				origin,
			);
			ok = "SendBlue keys saved.";
			break;
		case "automations/toggle":
			result = await serverCall(
				env,
				id,
				"/automation/" + (field(fields, "action") === "resume" ? "resume" : "pause"),
				{ channelId: field(fields, "channelId"), automationID: field(fields, "automationID") },
				origin,
			);
			ok = "Automation updated.";
			break;
		case "automations/remove":
			result = await serverCall(
				env,
				id,
				"/automation/delete",
				{ channelId: field(fields, "channelId"), automationID: field(fields, "automationID") },
				origin,
			);
			ok = "Automation removed.";
			break;
		case "reset":
			result = await serverCall(env, id, "/reset", {}, origin);
			ok = "Files reset.";
			break;
		default:
			return new Response("Not found", { status: 404 });
	}

	const query: ServerQuery = {};

	if (external) return redirect(external);
	if (result?.ok) {
		query.ok = ok;
		if (guild) query.guild = guild;
		if (oauth) query.oauth = oauth;
		if (claim) query.claim = claim;
		if (integration) query.integration = integration;
	} else {
		query.error =
			typeof result?.data.error === "string" ? result.data.error : "The change was not saved.";
	}

	return redirect(serverUrl(id, query));
}
