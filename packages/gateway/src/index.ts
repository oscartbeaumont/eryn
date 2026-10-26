/**
 * `@oscartbeaumont/eryn-gateway` — the MCP server.
 *
 * It owns accounts, the MCP servers a user hosts, the MCP authorization server,
 * the tool groups (Discord, GitHub, Google Calendar), and the MCP
 * Events extension. It never imports the bot, and nothing in it needs to.
 *
 * `handle` is the whole public surface: a request the gateway does not own comes
 * back as `undefined`, so the root Worker can hand it to the next package or to
 * the console's static assets.
 */

import { env } from "cloudflare:workers";
import { DEFAULT_ORIGIN, MCP_PATH } from "./config";
import { protectionMetadata, gatewayRoutes } from "./api";
import { AS_METADATA_PATH, bearerToken, challenge, verifyAccessToken } from "./mcp/oauth";
import { DEPLOY_HEADER, currentDeploy } from "./deploy";

export { GatewayUserV4 } from "./durable/gateway-user";
export { GatewayDiscordV4 } from "./durable/gateway-discord";

const router = gatewayRoutes();

function originOf(request: Request): string {
	const configured = env.PUBLIC_ORIGIN?.trim().replace(/\/$/, "");
	return new URL(request.url).origin || configured || DEFAULT_ORIGIN;
}

/** JSON-RPC shaped errors, which is what an MCP client can parse. */
function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
	return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status, headers });
}

/** Whether the gateway owns this path, before the router even runs. */
function owns(path: string): boolean {
	if (path.startsWith("/api/bot/")) return false;
	return (
		path.startsWith("/api/") ||
		path.startsWith("/auth/") ||
		path.startsWith("/github/") ||
		path.startsWith("/google/") ||
		path === "/oauth/register" ||
		path === "/oauth/token" ||
		path === AS_METADATA_PATH
	);
}

function preflight(request: Request, origin: string): Response {
	const requestOrigin = request.headers.get("origin");
	const headers = new Headers({
		"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
		"access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version, accept",
		"access-control-max-age": "86400",
	});
	if (requestOrigin && requestOrigin === origin) {
		headers.set("access-control-allow-origin", requestOrigin);
		headers.set("vary", "origin");
	}
	return new Response(null, { status: 204, headers });
}

/**
 * Authenticate and route an MCP request.
 *
 * The token names the hosted server it was issued for and the user it belongs
 * to, which is what routes the request: the subject picks the user's object, and
 * the object serves only that server. That is what makes one origin safe.
 */
async function handleMcp(request: Request, slug: string): Promise<Response> {
	const origin = originOf(request);
	if (request.method === "OPTIONS") return preflight(request, origin);

	const secret = env.SESSION_SECRET?.trim();
	const token = bearerToken(request);
	const grant = secret ? await verifyAccessToken(token, secret).catch(() => undefined) : undefined;
	if (!grant) {
		return rpcError(401, -32001, "Unauthorized", { "www-authenticate": challenge(origin, slug, token ? "invalid_token" : undefined) });
	}
	if (grant.mcp !== slug) {
		return rpcError(403, -32002, `This token is for the MCP server "${grant.mcp}", not "${slug}".`, {
			"www-authenticate": challenge(origin, slug, "invalid_token"),
		});
	}

	const binding = env.GATEWAY_USER;
	const headers = new Headers(request.headers);
	if (grant.guild) headers.set("x-eryn-guild", grant.guild);
	// Tell the object which deploy is current, so a live object that is still
	// running older code restarts before serving this request's tool calls.
	const deploy = currentDeploy(env);
	if (deploy) headers.set(DEPLOY_HEADER, deploy);
	const init: RequestInit = { method: request.method, headers };
	if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;
	const forwarded = new Request(request.url, init);
	return await binding.get(binding.idFromName(grant.sub)).fetch(forwarded);
}

export async function handle(request: Request): Promise<Response | undefined> {
	const url = new URL(request.url);
	const path = url.pathname;

	// The MCP endpoint and the discovery document that names it. Both live here
	// rather than in the router because the path carries the hosted server.
	if (path === MCP_PATH) {
		return rpcError(400, -32600, `Name a server: ${originOf(request)}${MCP_PATH}/<name>.`);
	}
	if (path.startsWith(`${MCP_PATH}/`)) {
		const slug = path.slice(MCP_PATH.length + 1).replace(/\/+$/, "");
		if (!slug || slug.includes("/")) return rpcError(404, -32601, "No such MCP endpoint.");
		return await handleMcp(request, decodeURIComponent(slug));
	}

	const metadata = protectionMetadata(path, originOf(request));
	if (metadata) return metadata;

	if (!owns(path)) return undefined;

	return await router.handler(request);
}
