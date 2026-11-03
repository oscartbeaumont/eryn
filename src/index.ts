/**
 * Eryn's Cloudflare Worker entrypoint.
 *
 * The Worker is the Discord bot and nothing else. It answers the external MCP
 * sign-in callback and the models.dev catalogue a guild's embedded OpenCode host
 * asks for, exposes the two Durable Objects the bot is made of, and wakes the
 * singleton bot object from `/health` and the cron trigger.
 */

import { env } from "cloudflare:workers";

import { SessionClient } from "./bot/client";
import { BotGatewayV5 } from "./bot/do";
import { catalogueResponse, isCatalogueRequest } from "./catalogue";
import { log } from "./config";
import { landingPage } from "./landing";
import { verify } from "./crypto";
import { withDeploy } from "./deploy";
import { MCP_CALLBACK_PATH } from "./mcp/links";
import { BotSessionV5 } from "./session/do";

export { BotGatewayV5, BotSessionV5 };

/**
 * Poke the singleton bot object so it connects and arms its alarm.
 *
 * A deploy can make the object reset into its new code, and a reset object has
 * no socket. When the wake says a restart is pending, poke it again once the
 * restart has had a moment: that brings the socket back immediately instead of
 * leaving the bot offline until the next cron tick.
 */
export async function wake(
	env: Env,
): Promise<{ connected?: boolean; deploy?: string | null; restart?: boolean } | undefined> {
	const stub = env.BOT_GATEWAY.get(env.BOT_GATEWAY.idFromName("bot"));
	const call = async (): Promise<{ connected?: boolean; deploy?: string | null; restart?: boolean } | undefined> => {
		const response = await stub.fetch("https://bot.internal/wake", withDeploy(env));
		if (!response.ok) return undefined;
		return (await response.json().catch(() => undefined)) as
			| { connected?: boolean; deploy?: string | null; restart?: boolean }
			| undefined;
	};

	let state = await call().catch(() => undefined);
	// A pending restart means the object resets into the new deploy a second from
	// now. Keep poking briefly so the replacement is woken, but do not multiply
	// every anonymous /health request into a ten-second stream of DO calls when
	// the bot is simply disconnected.
	for (let attempt = 0; attempt < 3 && (!state || state.restart); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 1_000));
		state = (await call().catch(() => undefined)) ?? state;
	}
	if (!state) return undefined;
	return { connected: state.connected, deploy: state.deploy ?? null, restart: state.restart === true };
}

/**
 * Handle the Worker's own routes.
 *
 * The external MCP sign-in callback and catalogue return `undefined` for
 * everything else, so the Worker can fall through to the health check or a 404.
 */
export async function handle(request: Request): Promise<Response | undefined> {
	const url = new URL(request.url);
	// The public origin is a landing page, since the bot's whole UI is Discord.
	if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) {
		return landingPage();
	}

	// The filtered models.dev catalogue an embedded host points at, so it does
	// not decode the bundled one in a Durable Object.
	if ((request.method === "GET" || request.method === "HEAD") && isCatalogueRequest(url.pathname)) {
		return await catalogueResponse(request);
	}

	if (url.pathname !== MCP_CALLBACK_PATH) return undefined;
	if (request.method !== "GET") return page("Not allowed", "This link only accepts a browser redirect.", 405);

	const secret = env.SESSION_SECRET?.trim();
	const state = url.searchParams.get("state") ?? "";
	const pointer = secret ? await verify<{ guildId?: unknown; attemptId?: unknown }>(state, secret) : undefined;
	const guildId = typeof pointer?.guildId === "string" ? pointer.guildId : undefined;
	const attemptId = typeof pointer?.attemptId === "string" ? pointer.attemptId : undefined;
	if (!guildId || !attemptId) {
		return page(
			"Sign-in link not valid",
			"This link is not valid any more. Start the sign-in again from Discord.",
			400,
		);
	}

	const error = url.searchParams.get("error") ?? undefined;
	const code = url.searchParams.get("code") ?? undefined;
	if (error) log("callback", `an MCP authorization server returned ${error}`);

	try {
		const result = await new SessionClient(env, guildId).mcpAuthComplete(attemptId, code, error);
		if (result.ok && result.link) {
			return page(
				"Connected",
				`<strong>${escapeHtml(result.link.name)}</strong> is connected to your Discord server. You can close this tab and return to Discord.`,
			);
		}
		return page(
			"Sign-in did not complete",
			`${escapeHtml(result.message ?? "The server did not accept the sign-in.")} You can close this tab and try again from Discord.`,
			400,
		);
	} catch (failure) {
		log("callback", `the MCP sign-in callback failed: ${String(failure)}`);
		return page(
			"Sign-in did not complete",
			"Eryn could not finish the sign-in. You can close this tab and try again from Discord.",
			500,
		);
	}
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

/** A small standalone page: the browser has left Discord and wants an answer. */
function page(title: string, message: string, status = 200): Response {
	// `message` may contain markup this module built; every value interpolated
	// into it is escaped by the caller.
	return new Response(
		`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · Eryn</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0b0c; color: #ededed;
       font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 34rem; padding: 2rem 1.5rem; }
h1 { margin: 0 0 0.75rem; font-size: 1.35rem; letter-spacing: -0.02em; }
p { margin: 0; color: #a1a1aa; }
strong { color: #ededed; }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${message}</p></main></body>
</html>`,
		{
			status,
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
				"x-content-type-options": "nosniff",
			},
		},
	);
}

export default {
	async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
		const handled = await handle(request).catch(() => undefined);
		if (handled) return handled;

		if (new URL(request.url).pathname === "/health") {
			// Wake the bot and report whether its gateway socket is up, so a deploy
			// that leaves it offline is visible from one request. The deploy id says
			// which code is actually serving: a Durable Object keeps the code it
			// started with until it restarts.
			const botState = await wake(env).catch(() => undefined);
			return Response.json({ ok: true, service: "eryn", deploy: env.CF_VERSION.id, bot: botState ?? null });
		}

		return new Response("Not found", { status: 404 });
	},

	scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
		ctx.waitUntil(wake(env).catch(() => undefined));
	},
} satisfies ExportedHandler<Env>;
