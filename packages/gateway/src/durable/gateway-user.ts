/**
 * The gateway object: one per Eryn user.
 *
 * The user id *is* the object name, so a user's accounts, hosted servers, and
 * grants live in storage nothing else can be routed to. That is the security
 * boundary: an MCP token names a subject, the subject picks the object, and the
 * object serves only the server the token names.
 *
 * It does three things: it stores (accounts, servers, grants); it serves a
 * hosted server's MCP endpoint, caching one `McpServer` per slug; and it bridges
 * the MCP Events extension to the events hub. The console's HTTP shape lives one
 * layer up, in `api.ts`, which calls the storage routes here.
 */

import { DurableObject } from "cloudflare:workers";
import { DEFAULT_ORIGIN, MCP_PATH } from "../config";
import { randomToken } from "../crypto";
import { describeError, discordRest, type DiscordRest } from "../discord/api";
import { descriptors, DISCORD_MESSAGE_EVENT, type Occurrence } from "../events";
import { mintGrantToken } from "../mcp/access";
import { createEndpoint, type Endpoint } from "../mcp/endpoint";
import { EMPTY_ACCESS, newId, type Account, type Grant, type McpServer } from "../model";
import { builtinTool } from "../tools/builtin";
import { catalog, groupOf, visibleToolNames } from "../tools/catalog";
import { discordTool } from "../tools/discord";
import { githubApi, githubTool, type GitHubApi } from "../tools/github";
import { googleApi, googleTool } from "../tools/google";
import {
	deleteAccount,
	deleteGrant,
	deleteServer,
	getAccount,
	getGrant,
	getServer,
	getServerByName,
	listAccounts,
	listGrants,
	listServers,
	putAccount,
	putGrant,
	putServer,
} from "../store";

function log(message: string): void {
	console.log(`[eryn:gateway:user] ${message}`);
}

class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

interface CacheEntry {
	endpoint: Endpoint;
	signature: string;
}

export class GatewayUserV2 extends DurableObject<Env> {
	private readonly userId: string;
	private readonly rest: DiscordRest;
	private readonly endpoints = new Map<string, CacheEntry>();
	private github: { signature: string; api: GitHubApi } | undefined;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.userId = state.id.name ?? "";
		this.rest = discordRest(env.DISCORD_BOT_TOKEN?.trim() ?? "");
	}

	private get secret(): string {
		return this.env.ENCRYPTION_KEY ?? "";
	}

	private origin(): string {
		return this.env.PUBLIC_ORIGIN?.trim().replace(/\/$/, "") || DEFAULT_ORIGIN;
	}

	override async fetch(request: Request): Promise<Response> {
		// A live object keeps the code it started with; restart it once a deploy
		// has moved on.
		const version = (this.env as unknown as { CF_VERSION?: { id?: string } }).CF_VERSION?.id;
		if (version) {
			const stored = await this.ctx.storage.get<string>("deploy:version");
			if (stored !== version) {
				await this.ctx.storage.put("deploy:version", version);
				if (stored !== undefined) this.ctx.abort();
			}
		}
		try {
			return await this.route(request);
		} catch (error) {
			if (error instanceof HttpError) return Response.json({ error: error.message }, { status: error.status });
			log(`request failed: ${describeError(error)}`);
			return Response.json({ error: describeError(error) }, { status: 500 });
		}
	}

	private async route(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		if (path.startsWith(`${MCP_PATH}/`)) return await this.mcp(request, path.slice(MCP_PATH.length + 1));

		// Storage routes. Internal only: reached over the DO binding or from the
		// console API layer, never directly from the internet.
		if (path === "/store/accounts") return Response.json({ accounts: await listAccounts(this.ctx.storage, this.secret) });
		if (path === "/store/account") {
			if (request.method === "PUT") {
				const account = await request.json<Account>();
				await putAccount(this.ctx.storage, this.secret, account);
				return Response.json({ ok: true });
			}
			if (request.method === "DELETE") {
				await deleteAccount(this.ctx.storage, url.searchParams.get("id") ?? "");
				return Response.json({ ok: true });
			}
		}
		if (path === "/store/servers") return Response.json({ servers: await this.servers() });
		if (path === "/store/server") {
			if (request.method === "PUT") {
				const server = await request.json<McpServer>();
				await putServer(this.ctx.storage, this.secret, server);
				return Response.json({ ok: true });
			}
			if (request.method === "DELETE") {
				await deleteServer(this.ctx.storage, this.secret, url.searchParams.get("id") ?? "");
				return Response.json({ ok: true });
			}
		}
		if (path === "/store/grants") return Response.json({ grants: await listGrants(this.ctx.storage, this.secret) });
		if (path === "/store/grant") {
			if (request.method === "PUT") {
				const body = await request.json<{ slug: string; grant: Grant }>();
				await putGrant(this.ctx.storage, this.secret, body.grant, body.slug);
				return Response.json({ ok: true });
			}
			if (request.method === "DELETE") {
				await deleteGrant(this.ctx.storage, url.searchParams.get("slug") ?? "", url.searchParams.get("guildId") ?? "");
				return Response.json({ ok: true });
			}
		}

		// What the bot asks for: the servers it may link, and a guild token. The
		// routes accept the id or the slug, because a caller may know either.
		if (path === "/servers") {
			const servers = await this.servers();
			return Response.json({
				servers: servers.map((server) => ({
					id: server.id,
					name: server.name,
					slug: server.name,
					title: server.title,
					enabled: server.enabled,
					tools: server.tools,
				})),
			});
		}
		if (path === "/grants") {
			return Response.json({ grants: await listGrants(this.ctx.storage, this.secret) });
		}
		if (path === "/grant" && request.method === "POST") {
			const body = await request.json<{
				slug?: string;
				mcpServerId?: string;
				guildId: string;
				toolNames?: string[];
				tools?: McpServer["tools"];
			}>();
			const server =
				(body.slug ? await getServerByName(this.ctx.storage, this.secret, body.slug) : undefined) ??
				(body.mcpServerId ? await getServer(this.ctx.storage, this.secret, body.mcpServerId) : undefined);
			if (!server) throw new HttpError(404, "no such server");
			const all = visibleToolNames(server.tools);
			// A caller may narrow with either a tool list or a whole ToolAccess.
			const requested = body.toolNames ?? (body.tools ? visibleToolNames(body.tools) : all);
			const toolNames = requested.filter((name) => all.includes(name));
			const grant: Grant = { guildId: body.guildId, mcpServerId: server.id, toolNames, createdAt: Date.now() };
			await putGrant(this.ctx.storage, this.secret, grant, server.name);
			if (!this.env.SESSION_SECRET) throw new HttpError(500, "the deployment has no session secret");
			const token = await mintGrantToken({ sub: this.userId, mcp: server.name, guild: body.guildId }, this.env.SESSION_SECRET);
			return Response.json({ ok: true, url: `${this.origin()}${MCP_PATH}/${server.name}`, token, toolNames });
		}
		if ((path === "/grant" || path === "/revoke") && (request.method === "DELETE" || request.method === "POST")) {
			const body = await request.json<{ slug?: string; mcpServerId?: string; guildId?: string }>();
			const guildId = body.guildId ?? new URL(request.url).searchParams.get("guildId") ?? "";
			const server =
				(body.slug ? await getServerByName(this.ctx.storage, this.secret, body.slug) : undefined) ??
				(body.mcpServerId ? await getServer(this.ctx.storage, this.secret, body.mcpServerId) : undefined);
			if (!server) throw new HttpError(404, "no such server");
			await deleteGrant(this.ctx.storage, server.name, guildId);
			return Response.json({ ok: true });
		}

		if (path === "/tools" && request.method === "POST") {
			const body = await request.json<{ slug: string }>();
			const server = await getServerByName(this.ctx.storage, this.secret, body.slug);
			if (!server) throw new HttpError(404, "no such server");
			const accounts = await listAccounts(this.ctx.storage, this.secret);
			const allowed = this.allowedFor(server, accounts);
			return Response.json({ tools: catalog().filter((tool) => allowed.includes(tool.name)) });
		}

		return Response.json({ error: "not found" }, { status: 404 });
	}

	private async servers(): Promise<McpServer[]> {
		const servers = await listServers(this.ctx.storage, this.secret);
		return servers.sort((a, b) => a.createdAt - b.createdAt);
	}

	/**
	 * The tool names this server can actually run.
	 *
	 * A group needs an account of the matching provider to act with, so a group
	 * that was switched on before its account was removed is not exposed.
	 */
	private allowedFor(server: McpServer, accounts: Account[]): string[] {
		const assigned = new Set(
			accounts.filter((account) => server.accountIds.includes(account.id)).map((account) => account.provider),
		);
		return visibleToolNames(server.tools, catalog()).filter((name) => {
			const group = groupOf(name);
			if (!group || group === "builtin") return true;
			if (group === "discord") return assigned.has("discord");
			if (group === "github") return assigned.has("github");
			if (group === "google_calendar") return assigned.has("google");
			return false;
		});
	}

	// --- MCP -------------------------------------------------------------------

	private async mcp(request: Request, slug: string): Promise<Response> {
		const server = await getServerByName(this.ctx.storage, this.secret, slug);
		if (!server) {
			return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32002, message: `No MCP server named ${slug}.` } }, { status: 404 });
		}

		// A guild token is only as good as the grant behind it, so a revoked link
		// stops working on the next call rather than at token expiry.
		const guild = request.headers.get("x-eryn-guild");
		let grantToolNames: readonly string[] | undefined;
		if (guild) {
			const grant = await getGrant(this.ctx.storage, this.secret, slug, guild);
			if (!grant) {
				return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "This guild's link was revoked." } }, { status: 403 });
			}
			grantToolNames = grant.toolNames;
		}

		const events = await this.eventsRequest(request, slug);
		if (events) return events;

		if (!server.enabled) {
			return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32003, message: `The MCP server "${slug}" is switched off.` } }, { status: 403 });
		}

		const accounts = await listAccounts(this.ctx.storage, this.secret);
		// A guild link can only ever narrow what the server exposes, so its tool
		// list is intersected with the server's own.
		const allowed = this.allowedFor(server, accounts).filter(
			(name) => grantToolNames === undefined || grantToolNames.includes(name),
		);
		const signature = `${[...allowed].sort().join(",")}|${[...server.accountIds].sort().join(",")}`;
		// One endpoint per (server, guild): two guilds can link the same server with
		// different restrictions, and each must see only its own tool set.
		const cacheKey = `${slug}|${guild ?? ""}`;
		let entry = this.endpoints.get(cacheKey);
		if (!entry || entry.signature !== signature) {
			const tools = catalog().filter((tool) => allowed.includes(tool.name));
			const endpoint = await createEndpoint({
				origin: this.origin(),
				slug,
				tools,
				invoke: (name, args) => this.invoke(server, accounts, name, args),
			});
			entry = { endpoint, signature };
			this.endpoints.set(cacheKey, entry);
		}
		return await entry.endpoint.handler(request);
	}

	/** Intercept the MCP Events extension before the core MCP handler sees it. */
	private async eventsRequest(request: Request, slug: string): Promise<Response | undefined> {
		if (request.method !== "POST") return undefined;
		const body = await request.clone().json().catch(() => undefined);
		const method = (body as { method?: unknown } | undefined)?.method;
		if (typeof method !== "string" || !method.startsWith("events/")) return undefined;
		const params = ((body as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown>;
		const id = (body as { id?: unknown }).id ?? null;
		const hasDiscord = (await listAccounts(this.ctx.storage, this.secret)).some((account) => account.provider === "discord");
		const hub = this.env.GATEWAY_DISCORD.get(this.env.GATEWAY_DISCORD.idFromName("hub"));

		if (method === "events/list") {
			return Response.json({ jsonrpc: "2.0", id, result: { events: descriptors(hasDiscord) } });
		}
		const kind = method.slice("events/".length);
		const forwarded = await hub.fetch(`https://hub.internal/events/${kind}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(params),
		});
		if (!forwarded.ok || kind === "stream") return forwarded;
		const result = await forwarded.json();
		return Response.json({ jsonrpc: "2.0", id, result });
	}

	// --- Tool dispatch ---------------------------------------------------------

	private async invoke(
		server: McpServer,
		accounts: Account[],
		name: string,
		args: Record<string, unknown>,
	): Promise<string> {
		const assigned = server.accountIds
			.map((id) => accounts.find((account) => account.id === id))
			.filter((account): account is Account => account !== undefined);

		const builtin = builtinTool(name);
		if (builtin) return builtin.run(args);

		const discord = discordTool(name);
		if (discord) return await discord.run(this.rest, args);

		const github = githubTool(name);
		if (github) {
			const api = await this.githubFor(assigned);
			if (!api) throw new Error("No GitHub account is assigned to this MCP server.");
			return await github.run(api, args);
		}

		const google = googleTool(name);
		if (google) {
			const account = assigned.find((entry) => entry.provider === "google");
			if (!account) throw new Error("No Google account is assigned to this MCP server.");
			const clientId = this.env.GOOGLE_CLIENT_ID?.trim();
			const clientSecret = this.env.GOOGLE_CLIENT_SECRET?.trim();
			if (!clientId || !clientSecret) throw new Error("Google is not configured on this deployment.");
			const client = googleApi(
				{
					accessToken: account.credential.token ?? "",
					refreshToken: account.credential.refreshToken,
					expiresAt: account.credential.expiresAt,
				},
				{ clientId, clientSecret },
				(next) => {
					void putAccount(this.ctx.storage, this.secret, {
						...account,
						credential: { ...account.credential, token: next.accessToken, expiresAt: next.expiresAt },
					}).catch(() => undefined);
				},
			);
			return await google.run(client, args);
		}

		throw new Error(`Unknown tool ${name}.`);
	}

	private async githubFor(assigned: Account[]): Promise<GitHubApi | undefined> {
		const account = assigned.find((entry) => entry.provider === "github");
		if (!account) return undefined;
		// GitHub accounts are connected with an OAuth App sign-in or a personal
		// token; both are a user access token, which the tools present as a bearer.
		const token = account.credential.token;
		if (!token) return undefined;
		const signature = `pat:${token}`;
		if (this.github?.signature !== signature) this.github = { signature, api: githubApi({ kind: "pat", token }) };
		return this.github.api;
	}
}

/** A fresh account id, so the console and the storage agree on the shape. */
export function newAccountId(): string {
	return newId("acc");
}

/** A fresh id for a hosted server's internal record. */
export function newServerId(): string {
	return newId("mcp");
}

export { EMPTY_ACCESS, randomToken, type Occurrence, DISCORD_MESSAGE_EVENT };
