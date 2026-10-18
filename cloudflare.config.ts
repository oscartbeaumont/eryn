import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
	worker: {
		name: "eryn",
		compatibilityDate: "2026-10-06",
		// The embedded OpenCode SDK targets workerd through the `workerd` condition.
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		domains: ["eryn.otbeaumont.me"],
		// Workers Observability: invocation logs and traces are persisted and
		// searchable in the dashboard, and real-time Issues groups the errors that
		// would otherwise only show up as noisy log lines.
		observability: {
			enabled: true,
			// Our own routes carry OAuth codes, code challenges, and session state in
			// the query string, so keep them out of logs and traces.
			redactQueryString: true,
			logs: { enabled: true, invocationLogs: true, persist: true },
			traces: { enabled: true, persist: true },
			issues: { enabled: true },
		},
		// A slow safety net for the gateway. The gateway's own Durable Object
		// alarm is the real mechanism; running this every minute would pay for a
		// wake-up a minute for no benefit.
		triggers: [triggers.scheduled({ schedule: "*/15 * * * *" })],
		// The Solid SPA is served as static assets; unknown paths fall back to
		// index.html, while API, auth, MCP, and ingest routes go straight to the
		// Worker.
		assets: {
			notFoundHandling: "single-page-application",
			runWorkerFirst: [
				"/api/*",
				"/auth/*",
				"/github/*",
				"/health",
				// The MCP endpoint and its OAuth discovery/registration surface.
				"/mcp",
				"/.well-known/*",
				"/oauth/*",
				// The PostHog reverse proxy.
				"/ingest/*",
			],
		},
		env: {
			// Durable Objects: one singleton gateway, one session per thread, one registry.
			GATEWAY: bindings.durableObject({ worker: "eryn", exportName: "ErynGateway" }),
			SESSION: bindings.durableObject({ worker: "eryn", exportName: "ErynSession" }),
			REGISTRY: bindings.durableObject({ worker: "eryn", exportName: "ErynRegistry" }),

			// Discord bot token. The bot is disabled when this is empty.
			DISCORD_BOT_TOKEN: bindings.secret(),
			// Discord application OAuth2 client secret, for the setup sign-in flow.
			DISCORD_CLIENT_SECRET: bindings.secret(),
			// base64url 32-byte key protecting guild credentials at rest.
			ENCRYPTION_KEY: bindings.secret(),
			// Random secret signing the OAuth state and session cookies.
			SESSION_SECRET: bindings.secret(),
			// GitHub App credentials, for the agent's GitHub tools (optional).
			GITHUB_APP_ID: bindings.secret(),
			GITHUB_APP_PRIVATE_KEY: bindings.secret(),
			// The App's URL slug, used for the "Install GitHub App" link.
			GITHUB_APP_SLUG: bindings.text(""),

			// Public origin used in messages linked from Discord.
			PUBLIC_ORIGIN: bindings.text("https://eryn.otbeaumont.me"),
			// Where Eryn's own sessions reach the MCP. Defaults to PUBLIC_ORIGIN/mcp.
			MCP_INTERNAL_URL: bindings.text(""),

			// PostHog. The project token is a public value that ships in the client
			// bundle; an empty token disables analytics entirely. Requests are sent
			// to this origin's /ingest path and proxied onward from here, so they
			// are first-party and ad blockers leave them alone.
			POSTHOG_KEY: bindings.text("phc_oQtUDRPaAeG4gutXrPA4R4eyWCY99mjWpMF8KZfjHgt2"),
			POSTHOG_INGEST_HOST: bindings.text("https://us.i.posthog.com"),
			POSTHOG_ASSETS_HOST: bindings.text("https://us-assets.i.posthog.com"),
			POSTHOG_UI_HOST: bindings.text("https://us.posthog.com"),

			// How often the gateway Durable Object's keepalive alarm fires. Only a
			// safety net: the socket is persistent, so a long interval is cheaper.
			DISCORD_KEEPALIVE_SECONDS: bindings.text("840"),
			// Seconds a single agent turn may run before it is interrupted.
			DISCORD_TURN_TIMEOUT_SECONDS: bindings.text("900"),
		},
		exports: {
			ErynGateway: exports.durableObject({ storage: "sqlite" }),
			ErynSession: exports.durableObject({ storage: "sqlite" }),
			ErynRegistry: exports.durableObject({ storage: "sqlite" }),
		},
	},
});
