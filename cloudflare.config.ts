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
		// A slow safety net for the gateway. The gateway's own Durable Object
		// alarm is the real mechanism; running this every minute would pay for a
		// wake-up a minute for no benefit.
		triggers: [triggers.scheduled({ schedule: "*/15 * * * *" })],
		// The Solid SPA is served as static assets; unknown paths fall back to
		// index.html, while API, auth, and MCP routes go straight to the Worker.
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
