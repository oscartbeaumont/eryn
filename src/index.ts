/**
 * The root Worker: the one file that knows all three packages exist.
 *
 * `@oscartbeaumont/eryn-gateway` handles the MCP server and the console's API,
 * `@oscartbeaumont/eryn-bot` handles the Discord bot, and
 * `@oscartbeaumont/eryn-console` is served as static assets by the runtime. The
 * packages never import one another; each returns `undefined` for a request it
 * does not own, and the next one is tried.
 */

import { env } from "cloudflare:workers";
import * as bot from "@oscartbeaumont/eryn-bot";
import * as gateway from "@oscartbeaumont/eryn-gateway";

export { GatewayDiscordV3, GatewayUserV3 } from "@oscartbeaumont/eryn-gateway";
export { BotGatewayV3, BotSessionV3 } from "@oscartbeaumont/eryn-bot";

const POSTHOG_DEFAULT_INGEST = "https://us.i.posthog.com";
const POSTHOG_DEFAULT_ASSETS = "https://us-assets.i.posthog.com";

/**
 * Reverse-proxy PostHog ingestion through this origin.
 *
 * Pointing the console's `api_host` at `/ingest` makes analytics requests
 * first-party, which keeps them out of ad blockers' blocklists. `/ingest/static/*`
 * goes to the asset host that serves session replay; everything else to the
 * ingestion host. An empty `POSTHOG_KEY` disables analytics and this proxy.
 */
async function proxyPostHog(request: Request, env: Env): Promise<Response | undefined> {
	if (!new URL(request.url).pathname.startsWith("/ingest/")) return undefined;
	if (!env.POSTHOG_KEY?.trim()) return new Response("Not found", { status: 404 });

	const url = new URL(request.url);
	const path = `${url.pathname.slice("/ingest".length)}${url.search}`;
	const ingest = env.POSTHOG_INGEST_HOST?.trim() || POSTHOG_DEFAULT_INGEST;
	const assets = env.POSTHOG_ASSETS_HOST?.trim() || POSTHOG_DEFAULT_ASSETS;
	const upstream = new URL(path, path.startsWith("/static/") ? assets : ingest);

	// Never forward our own cookies or credentials to a third party.
	const headers = new Headers(request.headers);
	headers.delete("cookie");
	headers.delete("authorization");
	headers.delete("host");

	const init: RequestInit = { method: request.method, headers, redirect: "manual" };
	if (request.method !== "GET" && request.method !== "HEAD") init.body = request.body;

	const response = await fetch(upstream, init);
	// The runtime hands back a decoded body, so a forwarded content-encoding or
	// content-length would describe bytes that no longer match.
	const out = new Headers(response.headers);
	out.delete("content-encoding");
	out.delete("content-length");
	out.delete("transfer-encoding");
	out.delete("set-cookie");
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out });
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const proxied = await proxyPostHog(request, env).catch(() => undefined);
		if (proxied) return proxied;

		// The MCP endpoint is authenticated and routed before anything else, and it
		// belongs to the gateway.
		const fromGateway = await gateway.handle(request).catch(() => undefined);
		if (fromGateway) return fromGateway;

		const fromBot = await bot.handle(request).catch(() => undefined);
		if (fromBot) return fromBot;

		if (new URL(request.url).pathname === "/health") {
			// Wake the bot and report whether its gateway socket is up, so a deploy
			// that leaves it offline is visible from one request.
			const botState = await bot.wake(env).catch(() => undefined);
			return Response.json({ ok: true, service: "eryn", bot: botState ?? null });
		}

		return new Response("Not found", { status: 404 });
	},

	scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
		ctx.waitUntil(bot.wake(env).catch(() => undefined));
	},
} satisfies ExportedHandler<Env>;
