import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

/**
 * One Worker, three packages.
 *
 * `@oscartbeaumont/eryn-gateway` (the MCP server) and
 * `@oscartbeaumont/eryn-bot` (the Discord bot) are composed by `src/index.ts`;
 * `@oscartbeaumont/eryn-console` is served as static assets. The packages never
 * import each other, and each keeps its own standalone entrypoint, so this file
 * is the only place that knows all three exist.
 */
export default defineConfig({
	worker: {
		name: "eryn",
		compatibilityDate: "2026-10-06",
		// The embedded OpenCode SDK targets workerd through the `workerd` condition.
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		domains: ["eryn.otbeaumont.me"],
		observability: {
			enabled: true,
			// Our own routes carry OAuth codes, code challenges, and session state in
			// the query string, so keep them out of logs and traces.
			redactQueryString: true,
			logs: { enabled: true, invocationLogs: true, persist: true },
			traces: { enabled: true, persist: true },
			issues: { enabled: true },
		},
		// A slow safety net for the bot's gateway object. Its own alarm is the real
		// mechanism; running this every minute would pay for a request for nothing.
		triggers: [triggers.scheduled({ schedule: "*/15 * * * *" })],
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: [
				// The bot's and gateway's own routes.
				"/api/*",
				"/auth/*",
				"/github/*",
				"/google/*",
				"/health",
				// The gateway's MCP endpoint, its OAuth discovery, and registration.
				"/mcp",
				"/mcp/*",
				"/.well-known/*",
				"/oauth/*",
				// The PostHog reverse proxy.
				"/ingest/*",
			],
		},
		env: {
			// The gateway: one object per Eryn user, plus the singleton events hub
			// that owns the lazily-opened Discord socket for MCP events.
			GATEWAY_USER: bindings.durableObject({ worker: "eryn", exportName: "GatewayUser" }),
			GATEWAY_DISCORD: bindings.durableObject({ worker: "eryn", exportName: "GatewayDiscord" }),
			// The bot: the singleton Discord socket, and one session per guild.
			BOT_GATEWAY: bindings.durableObject({ worker: "eryn", exportName: "BotGateway" }),
			BOT_SESSION: bindings.durableObject({ worker: "eryn", exportName: "BotSession" }),

			// Discord: the bot token powers the socket and the Discord tools, and the
			// client id/secret drive the console's sign-in.
			DISCORD_BOT_TOKEN: bindings.secret(),
			DISCORD_CLIENT_ID: bindings.text("1561290858668494959"),
			DISCORD_CLIENT_SECRET: bindings.secret(),

			// base64url 32-byte key protecting every stored credential at rest.
			ENCRYPTION_KEY: bindings.secret(),
			// Signs sessions, OAuth state, and MCP tokens.
			SESSION_SECRET: bindings.secret(),

			// GitHub accounts are connected with an OAuth App sign-in or a personal
			// access token; both are a user access token. The client id is public; the
			// secret is a dashboard secret binding.
			GITHUB_OAUTH_CLIENT_ID: bindings.text("Ov23li72FJNRRw9YbyIh"),
			GITHUB_OAUTH_CLIENT_SECRET: bindings.secret(),

			// Google Calendar accounts.
			GOOGLE_CLIENT_ID: bindings.text("306342405758-qo1be08n6i27ilpvlbjl6kaq7vma0rh1.apps.googleusercontent.com"),
			GOOGLE_CLIENT_SECRET: bindings.secret(),

			// Public origin used in links and OAuth callbacks.
			PUBLIC_ORIGIN: bindings.text("https://eryn.otbeaumont.me"),

			// PostHog. The token is public and ships in the console bundle; an empty
			// token disables analytics. Requests go to this origin's /ingest path and
			// are proxied onward, so they are first-party and ad blockers leave them
			// alone.
			POSTHOG_KEY: bindings.text("phc_oQtUDRPaAeG4gutXrPA4R4eyWCY99mjWpMF8KZfjHgt2"),
			POSTHOG_INGEST_HOST: bindings.text("https://us.i.posthog.com"),
			POSTHOG_ASSETS_HOST: bindings.text("https://us-assets.i.posthog.com"),
			POSTHOG_UI_HOST: bindings.text("https://us.posthog.com"),

			// How often the bot gateway's keepalive alarm fires; a long interval is
			// both safe and cheap because a session resume loses no messages.
			DISCORD_KEEPALIVE_SECONDS: bindings.text("840"),
			// Seconds a single agent turn may run before it is interrupted.
			DISCORD_TURN_TIMEOUT_SECONDS: bindings.text("900"),
		},
		exports: {
			GatewayUser: exports.durableObject({ storage: "sqlite" }),
			GatewayDiscord: exports.durableObject({ storage: "sqlite" }),
			BotGateway: exports.durableObject({ storage: "sqlite" }),
			BotSession: exports.durableObject({ storage: "sqlite" }),
			// The redesign is a clean break: these four namespaces held the old
			// single-Worker layout, and their storage is intentionally abandoned.
			ErynGateway: exports.durableObject({ state: "deleted" }),
			ErynSession: exports.durableObject({ state: "deleted" }),
			ErynRegistry: exports.durableObject({ state: "deleted" }),
			ErynMcp: exports.durableObject({ state: "deleted" }),
		},
	},
});
