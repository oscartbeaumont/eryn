/**
 * `@oscartbeaumont/eryn-bot` — the Discord bot.
 *
 * The bot owns almost no public HTTP: `handle` answers the external MCP
 * sign-in callback (an authorization server sends a browser there) and returns
 * `undefined` for everything else, so the root Worker moves on to the next
 * package. What it does expose is the two Durable Objects it is made of, and
 * `wake`, which the Worker's health check and cron use to poke the singleton
 * gateway object.
 */

import { env } from "cloudflare:workers";

import { log } from "./config";
import { verify } from "./crypto";
import { SessionClient } from "./gateway/client";
import { BotGatewayV5 } from "./gateway/do";
import { MCP_CALLBACK_PATH } from "./mcp/links";
import { BotSessionV5 } from "./session/do";
import { withDeploy } from "./deploy";

export { BotGatewayV5, BotSessionV5 };

/**
 * Poke the singleton gateway object so it connects and arms its alarm.
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
	if (state?.restart) {
		// The object resets into the new deploy a second from now. Poke it again
		// once that has happened; the replacement has no socket yet, so give the
		// Discord handshake a moment too.
		await new Promise((resolve) => setTimeout(resolve, 1_500));
		state = (await call().catch(() => undefined)) ?? state;
		if (!state.connected) {
			await new Promise((resolve) => setTimeout(resolve, 1_500));
			state = (await call().catch(() => undefined)) ?? state;
		}
	}
	if (!state) return undefined;
	return { connected: state.connected, deploy: state.deploy ?? null, restart: state.restart === true };
}

/**
 * The external MCP sign-in callback.
 *
 * The `state` is a signed pointer to the guild and the attempt that started the
 * flow, so this route needs no session and no storage of its own: it decodes
 * the pointer, hands the code to the guild's object, and returns a page the
 * browser can close. Errors from the authorization server are deliberately not
 * shown — they are attacker-influenced — only logged.
 */
export async function handle(request: Request): Promise<Response | undefined> {
	const url = new URL(request.url);
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
