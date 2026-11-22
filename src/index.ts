/**
 * The Worker entrypoint.
 *
 * It is the only public surface: the marketing page, the browser app, the
 * Discord interaction endpoint, the SendBlue webhook, and the MCP endpoint the
 * embedded agent connects to. Each one verifies its own caller and then
 * forwards to a Durable Object.
 */

import { Result } from "effect";
import type { Schema } from "effect";
import { Hex } from "effect/encoding";
import solidHandler from "virtual:solid-ssr-handler";

import { brandAsset, isBrandAsset } from "./brand.ts";
import { catalogueResponse, isCatalogueRequest } from "./catalogue.ts";
import { configuredOrigin, INTERACTIONS_PATH, log } from "./config.ts";
import { Control } from "./control/do.ts";
import { withDeploy, withOrigin } from "./deploy.ts";
import { application, applicationId, ensureEndpoint } from "./discord/application.ts";
import type { DiscordInteraction } from "./discord/socket.ts";
import { Gateway } from "./gateway/do.ts";
import { Hub } from "./hub/do.ts";
import { isPostHogRequest, posthogProxy } from "./landing/analytics.ts";
import { privacyPage, termsPage } from "./legal.ts";
import { handleMcp } from "./mcp/eryn.ts";
import { readMcpToken } from "./mcp/token.ts";
import { installUrl } from "./public.ts";
import { Server } from "./server/do.ts";
import { handleWeb } from "./web/routes.ts";

export { Control, Server, Hub, Gateway };

const ED25519 = { name: "Ed25519" } as const;

const MAX_SIGNATURE_AGE_MS = 5 * 60_000;

function isRead(request: Request): boolean {
	return request.method === "GET" || request.method === "HEAD";
}

function hexBytes(value: string): Uint8Array | undefined {
	if (!value) return undefined;

	return Result.getOrUndefined(Hex.decode(value));
}

async function signedWith(keyHex: string, signature: Uint8Array, payload: Uint8Array): Promise<boolean> {
	const keyBytes = hexBytes(keyHex);

	if (!keyBytes) return false;

	try {
		const key = await crypto.subtle.importKey("raw", keyBytes, ED25519, false, ["verify"]);

		return await crypto.subtle.verify(ED25519, key, signature, payload);
	} catch {
		return false;
	}
}

async function signedByDiscord(
	env: Env,
	signature: string,
	timestamp: string,
	body: string,
): Promise<boolean> {
	const signatureBytes = hexBytes(signature);

	if (!signatureBytes || !timestamp) return false;
	const seconds = Number(timestamp);

	if (!Number.isFinite(seconds) || Math.abs(Date.now() - seconds * 1_000) > MAX_SIGNATURE_AGE_MS) {
		return false;
	}

	const key = (await application(env))?.verifyKey;

	if (!key) {
		log("interactions", "the application key is not known yet");

		return false;
	}

	return await signedWith(key, signatureBytes, new TextEncoder().encode(timestamp + body));
}

/** Discord posts every interaction here once the application endpoint is set. */
async function handleInteractions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	if (request.method !== "POST") return new Response("Not found", { status: 404 });
	const body = await request.text();
	const signature = request.headers.get("x-signature-ed25519") ?? "";
	const timestamp = request.headers.get("x-signature-timestamp") ?? "";

	if (!(await signedByDiscord(env, signature, timestamp, body))) {
		return new Response("invalid request signature", { status: 401 });
	}

	let interaction: DiscordInteraction | undefined;

	try {
		interaction = JSON.parse(body) as DiscordInteraction;
	} catch {
		return new Response("bad request", { status: 400 });
	}

	if (interaction?.type === 1) return Response.json({ type: 1 });

	if (typeof interaction?.id !== "string" || typeof interaction.token !== "string") {
		return new Response("bad request", { status: 400 });
	}

	ctx.waitUntil(
		env.GATEWAY.get(env.GATEWAY.idFromName("gateway"))
			.fetch(
				"https://gateway.internal/interaction",
				withOrigin(
					withDeploy(env, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body,
					}),
					new URL(request.url).origin,
				),
			)
			.then((response) => {
				if (!response.ok) log("interactions", "gateway returned HTTP " + response.status);
			})
			.catch((error: unknown) => log("interactions", "delivery failed: " + String(error))),
	);

	return new Response(null, { status: 202 });
}

/** A SendBlue message webhook, forwarded to the server that owns the number. */
async function handleSendBlue(request: Request, env: Env, serverId: string, token: string | null): Promise<Response> {
	if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
	const body = await request.text();

	const response = await env.SERVER.get(env.SERVER.idFromName(serverId)).fetch(
		"https://server.internal/webhook/sendblue",
		withOrigin(
			withDeploy(env, {
				method: "POST",
				headers: { "content-type": "application/json", "x-eryn-token": token ?? "" },
				body,
			}),
			new URL(request.url).origin,
		),
	);

	return new Response(null, { status: response.ok ? 200 : response.status });
}

export async function handleWorkerRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response | undefined> {
	const url = new URL(request.url);
	const path = url.pathname;

	if (path === INTERACTIONS_PATH) return await handleInteractions(request, env, ctx);

	if (isRead(request) && isBrandAsset(path)) return await brandAsset(request, env);

	if (isRead(request) && path === "/install") {
		return Response.redirect(installUrl(await applicationId(env)), 302);
	}

	if (isPostHogRequest(path)) return await posthogProxy(request, url);

	if (path === "/" && isRead(request)) {
		const response = await solidHandler.fetch(request);
		response.headers.set("cache-control", "public, max-age=300");

		return response;
	}

	if (path === "/terms" || path === "/terms-of-service") return termsPage();
	if (path === "/privacy" || path === "/privacy-policy") return privacyPage();

	if (isRead(request) && isCatalogueRequest(path)) return await catalogueResponse(request);

	if (path.startsWith("/mcp/") && request.method === "POST") {
		const serverId = await readMcpToken(env, request);

		if (!serverId || path !== "/mcp/" + serverId) {
			return new Response("Unauthorized", { status: 401 });
		}

		return await handleMcp({ env, serverId, ctx }, request);
	}

	if (path.startsWith("/webhooks/sendblue/")) {
		const serverId = decodeURIComponent(path.slice("/webhooks/sendblue/".length));

		return await handleSendBlue(request, env, serverId, url.searchParams.get("token"));
	}

	const web = await handleWeb(request, env, ctx);

	if (web) return web;

	if (path === "/health") {
		const gateway = await env.GATEWAY.get(env.GATEWAY.idFromName("gateway"))
			.fetch(
				"https://gateway.internal/wake",
				withOrigin(withDeploy(env, { method: "POST" }), url.origin),
			)
			.then(async (response) => (await response.json().catch(() => undefined)) as Schema.Json)
			.catch(() => undefined);

		return Response.json({ ok: true, service: "eryn", deploy: env.CF_VERSION.id, gateway: gateway ?? null });
	}

	return undefined;
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (!configuredOrigin(env)) {
			ctx.waitUntil(ensureEndpoint(env, url.origin).catch(() => undefined));
		}

		const handled = await handleWorkerRequest(request, env, ctx).catch((error: unknown) => {
			log("worker", "request failed: " + String(error));

			return undefined;
		});

		return handled ?? new Response("Not found", { status: 404 });
	},

	scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
		ctx.waitUntil(
			env.GATEWAY.get(env.GATEWAY.idFromName("gateway"))
				.fetch(
					"https://gateway.internal/wake",
					withOrigin(withDeploy(env, { method: "POST" }), configuredOrigin(env)),
				)
				.catch(() => undefined),
		);
	},
} satisfies ExportedHandler<Env>;
