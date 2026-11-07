/**
 * Eryn's Cloudflare Worker entrypoint.
 *
 * The Worker is the Discord bot and nothing else. It verifies and forwards
 * Discord's HTTP interactions, answers the external MCP sign-in callback and
 * the models.dev catalogue a guild's embedded OpenCode host asks for, exposes
 * the two Durable Objects the bot is made of, and wakes the singleton bot
 * object from `/health` and the cron trigger.
 */

import { env } from "cloudflare:workers";

import { SessionClient } from "./bot/client";
import { BotGatewayV5 } from "./bot/do";
import { brandAsset, BRAND, isBrandAsset } from "./brand";
import { catalogueResponse, isCatalogueRequest } from "./catalogue";
import { APPLICATION_PUBLIC_KEY, INTERACTIONS_PATH, log, publicOrigin } from "./config";
import { landingPage } from "./landing";
import { privacyPage, termsPage } from "./legal";
import { verify } from "./crypto";
import { withDeploy } from "./deploy";
import type { DiscordInteraction } from "./discord/socket";
import { MCP_CALLBACK_PATH, MCP_START_PATH } from "./mcp/paths";
import { BotSessionV5 } from "./session/do";

export { BotGatewayV5, BotSessionV5 };

/** What the bot object reports about itself, as `/health` passes it on. */
interface WakeState {
	connected?: boolean;
	deploy?: string | null;
	restart?: boolean;
}

const isRead = (request: Request): boolean => request.method === "GET" || request.method === "HEAD";

/**
 * Poke the singleton bot object so it connects and arms its alarm.
 *
 * A deploy can make the object reset into its new code, and a reset object has
 * no socket. When the wake says a restart is pending, poke it again once the
 * restart has had a moment: that brings the socket back immediately instead of
 * leaving the bot offline until the next cron tick.
 */
export async function wake(env: Env): Promise<WakeState | undefined> {
	const stub = env.BOT_GATEWAY.get(env.BOT_GATEWAY.idFromName("bot"));
	const call = async (): Promise<WakeState | undefined> => {
		const response = await stub.fetch("https://bot.internal/wake", withDeploy(env));
		if (!response.ok) return undefined;
		return (await response.json().catch(() => undefined)) as WakeState | undefined;
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
 * Each route handler returns `undefined` for a path it does not own, so the
 * Worker can fall through to the health check or a 404.
 */
export async function handle(request: Request, ctx: ExecutionContext): Promise<Response | undefined> {
	const url = new URL(request.url);
	// Discord posts every interaction here once the application's endpoint is
	// set; the route verifies the signature and hands it to the bot object.
	if (url.pathname === INTERACTIONS_PATH) return await handleInteractions(request, ctx);
	// Brand images and the favicon are static assets; the Worker owns these
	// paths so it can add the long-lived cache headers.
	if (isRead(request) && isBrandAsset(url.pathname)) return await brandAsset(request, env);
	// The public origin is a landing page, since the bot's whole UI is Discord.
	if (url.pathname === "/" && isRead(request)) return landingPage(publicOrigin(env));
	if (url.pathname === "/terms" || url.pathname === "/terms-of-service") return termsPage();
	if (url.pathname === "/privacy" || url.pathname === "/privacy-policy") return privacyPage();

	// The filtered models.dev catalogue an embedded host points at, so it does
	// not decode the bundled one in a Durable Object.
	if (isRead(request) && isCatalogueRequest(url.pathname)) return await catalogueResponse(request);

	if (url.pathname.startsWith(`${MCP_START_PATH}/`)) return await handleMcpStart(request, url);
	if (url.pathname !== MCP_CALLBACK_PATH) return undefined;
	return await handleMcpCallback(request, url);
}

/**
 * Receive one interaction from Discord.
 *
 * Discord signs the timestamp and raw body with the application's Ed25519 key;
 * anything that fails verification is rejected before it is parsed. The
 * interaction itself is handed to the bot object, which owns the REST client
 * and the guild sessions, and Discord is released immediately with a 202. The
 * handlers acknowledge through the interaction callback endpoint, which is the
 * documented pairing for a 202 response — and is what lets a slash command work
 * even while the gateway socket is down.
 */
async function handleInteractions(request: Request, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "POST") return new Response("Not found", { status: 404 });

	const body = await request.text();
	const signature = request.headers.get("x-signature-ed25519") ?? "";
	const timestamp = request.headers.get("x-signature-timestamp") ?? "";
	if (!(await signedByDiscord(signature, timestamp, body))) {
		return new Response("invalid request signature", { status: 401 });
	}

	let interaction: DiscordInteraction | undefined;
	try {
		interaction = JSON.parse(body) as DiscordInteraction;
	} catch {
		return new Response("bad request", { status: 400 });
	}

	// Registering the endpoint sends a signed PING, which only counts as
	// answered if it gets a PONG back.
	if (interaction?.type === 1) return Response.json({ type: 1 });
	if (typeof interaction?.id !== "string" || typeof interaction.token !== "string") {
		return new Response("bad request", { status: 400 });
	}

	ctx.waitUntil(
		env.BOT_GATEWAY.get(env.BOT_GATEWAY.idFromName("bot"))
			.fetch(
				"https://bot.internal/interaction",
				withDeploy(env, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body,
				}),
			)
			.then((response) => {
				if (!response.ok) log("interactions", `the bot object returned HTTP ${response.status}`);
			})
			.catch((error) => log("interactions", `could not deliver the interaction: ${String(error)}`)),
	);
	return new Response(null, { status: 202 });
}

/** Ed25519 as WebCrypto names it. */
const ED25519 = { name: "Ed25519" } as const;

/** Decode a hex string, or undefined when it is not one. */
function hexBytes(value: string): Uint8Array | undefined {
	if (!value || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return undefined;
	const bytes = new Uint8Array(value.length / 2);
	for (let index = 0; index < bytes.length; index++) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
	}
	return bytes;
}

/** Whether Discord signed this timestamp and body for this application. */
async function signedByDiscord(signature: string, timestamp: string, body: string): Promise<boolean> {
	const signatureBytes = hexBytes(signature);
	const keyBytes = hexBytes(APPLICATION_PUBLIC_KEY);
	if (!signatureBytes || !keyBytes || !timestamp) return false;
	try {
		const key = await crypto.subtle.importKey("raw", keyBytes, ED25519, false, ["verify"]);
		return await crypto.subtle.verify(
			ED25519,
			key,
			signatureBytes,
			new TextEncoder().encode(timestamp + body),
		);
	} catch {
		return false;
	}
}

/**
 * The short link a Discord button points at: resolve the signed pointer and
 * forward the browser to the authorization URL the attempt recorded.
 */
async function handleMcpStart(request: Request, url: URL): Promise<Response> {
	if (request.method !== "GET") return page("Not allowed", "This link only accepts a browser redirect.", 405);

	const pointer = await readPointer(url.pathname.slice(MCP_START_PATH.length + 1), env);
	if (!pointer) return invalidLink();

	try {
		const target = await new SessionClient(env, pointer.guildId).mcpAuthUrl(pointer.attemptId);
		return Response.redirect(target, 302);
	} catch {
		return page(
			"Sign-in link expired",
			"This sign-in is no longer available. Start it again from Discord.",
			400,
		);
	}
}

/** Where the authorization server sends the browser back to. */
async function handleMcpCallback(request: Request, url: URL): Promise<Response> {
	if (request.method !== "GET") return page("Not allowed", "This link only accepts a browser redirect.", 405);

	const pointer = await readPointer(url.searchParams.get("state") ?? undefined, env);
	if (!pointer) return invalidLink();

	const error = url.searchParams.get("error") ?? undefined;
	const code = url.searchParams.get("code") ?? undefined;
	if (error) log("callback", `an MCP authorization server returned ${error}`);

	try {
		const result = await new SessionClient(env, pointer.guildId).mcpAuthComplete(pointer.attemptId, code, error);
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

/** Verify a signed sign-in pointer and narrow it to the two ids it must carry. */
async function readPointer(
	token: string | undefined,
	env: Env,
): Promise<{ guildId: string; attemptId: string } | undefined> {
	const secret = env.SESSION_SECRET?.trim();
	if (!secret || !token) return undefined;
	const pointer = await verify<{ guildId?: unknown; attemptId?: unknown }>(token, secret);
	if (typeof pointer?.guildId !== "string" || typeof pointer.attemptId !== "string") return undefined;
	return { guildId: pointer.guildId, attemptId: pointer.attemptId };
}

/** A sign-in link whose signed pointer is gone or was never valid. */
function invalidLink(): Response {
	return page(
		"Sign-in link not valid",
		"This link is not valid any more. Start the sign-in again from Discord.",
		400,
	);
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
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#08080a">
<link rel="icon" href="${BRAND.favicon}" sizes="any">
<link rel="icon" type="image/png" href="${BRAND.icon}" sizes="64x64">
<link rel="apple-touch-icon" href="${BRAND.appleIcon}">
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
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const handled = await handle(request, ctx).catch(() => undefined);
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
