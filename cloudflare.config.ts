import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

/**
 * The hosted deployment, and a fork of it.
 *
 * `cf deploy` from this repository publishes eryn.otbeaumont.me. A fork made by
 * the Deploy to Cloudflare button builds in Workers Builds, where that domain
 * belongs to someone else's account, so those deployments publish on
 * workers.dev instead. `ERYN_DOMAIN` attaches an explicit domain either way.
 */
const SELF_HOSTED = process.env.WORKERS_CI === "1";
const DOMAIN =
	process.env.ERYN_DOMAIN !== undefined
		? process.env.ERYN_DOMAIN.trim() || undefined
		: SELF_HOSTED
			? undefined
			: "eryn.otbeaumont.me";

/**
 * One Worker: the Discord bot.
 *
 * `src/index.ts` is the entrypoint and the bot's two Durable Objects are the
 * whole deployment; the only static files are the brand images in `assets/`.
 */
export default defineConfig({
	worker: {
		name: "eryn",
		compatibilityDate: "2026-10-06",
		// The embedded OpenCode SDK targets workerd through the `workerd` condition.
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		// A string domain serves production traffic only, and version preview
		// URLs are off: neither `eryn.<subdomain>.workers.dev` nor a
		// `<version>-eryn.<subdomain>.workers.dev` URL is published by the hosted
		// deployment. A self-hosted fork has no domain of its own, so it gets the
		// workers.dev route.
		domains: DOMAIN ? [DOMAIN] : [],
		workersDev: DOMAIN === undefined,
		previewUrls: false,
		// `assets/` is the public directory. Only the brand paths are routed to
		// the Worker; every other matching file is served directly by Cloudflare.
		assets: {
			runWorkerFirst: ["/brand/*", "/favicon.ico"],
		},
		observability: {
			enabled: true,
			// OAuth codes and state live in the query string, so keep them out of
			// logs and traces.
			redactQueryString: true,
			logs: { enabled: true, invocationLogs: true, persist: true },
			traces: { enabled: true, persist: true },
			issues: { enabled: true },
		},
		// A watchdog for the bot's gateway object, not a keepalive. The object
		// re-arms its own alarm (every two minutes) and a deploy restart now
		// retries that alarm, so this only covers the case where the alarm chain
		// is lost entirely — a slow poke is enough for that.
		triggers: [triggers.scheduled({ schedule: "*/15 * * * *" })],
		env: {
			// Static files from `assets/`, served through `brandAsset`.
			ASSETS: bindings.assets(),

			// The bot: the singleton Discord socket, and one session per guild.
			BOT_GATEWAY: bindings.durableObject({ worker: "eryn", exportName: "BotGatewayV5" }),
			BOT_SESSION: bindings.durableObject({ worker: "eryn", exportName: "BotSessionV5" }),

			// Discord: the bot token powers the socket, slash commands, and threads.
			DISCORD_BOT_TOKEN: bindings.secret(),

			// base64url 32-byte key protecting every stored credential at rest.
			ENCRYPTION_KEY: bindings.secret(),

			// Public origin used in links and OAuth callbacks. The hosted deploy
			// knows its own domain; a self-hosted one learns its URL from the first
			// request it serves, so it leaves this unset.
			...(DOMAIN ? { PUBLIC_ORIGIN: bindings.text(`https://${DOMAIN}`) } : {}),

			// The deploy this Worker is serving. A deploy does not restart a live
			// object, and an object's own copy of this binding is pinned to the
			// deploy it started on, so the Worker sends this to each object on
			// every call and the object restarts when it changes.
			CF_VERSION: bindings.versionMetadata(),
		},
		exports: {
			// The only objects left. The old gateway and pre-redesign namespaces were
			// deleted by earlier deploys, so their `deleted` and `renamed` tombstones
			// have done their job and are gone too.
			BotGatewayV5: exports.durableObject({ storage: "sqlite" }),
			BotSessionV5: exports.durableObject({ storage: "sqlite" }),
		},
	},
});
