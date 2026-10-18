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
		triggers: [triggers.scheduled({ schedule: "* * * * *" })],
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
			// Seconds between gateway keepalive alarms.
			DISCORD_KEEPALIVE_SECONDS: bindings.text("60"),
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
