/**
 * The Eryn Worker entry point.
 *
 * HTTP is served by an Effect `HttpRouter` built once at module scope and
 * adapted to the Workers `fetch` handler. The public surface is tiny on
 * purpose: a styled landing page and a health check. Discord traffic arrives
 * over the gateway inside `ErynGateway`, and each thread's agent lives in
 * `ErynSession`; neither is reachable over the public internet.
 *
 * A cron trigger and the first request of the day both wake the gateway object
 * so the bot reconnects after a deploy without anyone mentioning it first.
 */

import { Layer, Scheduler } from "effect";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/http";
import { landingPage } from "./page";

export { ErynGateway } from "./gateway";
export { ErynSession } from "./agent";

const Routes = Layer.mergeAll(
	HttpRouter.add("GET", "/", HttpServerResponse.html(landingPage())),
	HttpRouter.add("GET", "/health", HttpServerResponse.jsonUnsafe({ ok: true, service: "eryn" })),
).pipe(Layer.provide(HttpServer.layerServices));

// The Workers scheduler is synchronous; see the `HttpRouter.toWebHandler` notes.
const SyncScheduler = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"));
const app = HttpRouter.toWebHandler(Layer.provideMerge(Routes, SyncScheduler));

/** Make sure the singleton gateway object is running and connected. */
async function wake(env: Env): Promise<void> {
	await env.GATEWAY.get(env.GATEWAY.idFromName("gateway")).fetch("https://eryn.internal/wake");
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const response = await app.handler(request);
		if (request.method === "GET") {
			const { pathname } = new URL(request.url);
			if (pathname === "/" || pathname === "/health") ctx.waitUntil(wake(env).catch(() => undefined));
		}
		return response;
	},

	scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
		ctx.waitUntil(wake(env).catch(() => undefined));
	},
} satisfies ExportedHandler<Env>;
