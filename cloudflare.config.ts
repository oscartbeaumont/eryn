import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

/**
 * One Worker: the Discord bot.
 *
 * `src/index.ts` is the entrypoint; the bot's two Durable Objects are the whole
 * deployment. There is no console, MCP endpoint, or static asset bundle.
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
			// OAuth codes and state live in the query string, so keep them out of
			// logs and traces.
			redactQueryString: true,
			logs: { enabled: true, invocationLogs: true, persist: true },
			traces: { enabled: true, persist: true },
			issues: { enabled: true },
		},
		// A slow safety net for the bot's gateway object. Its own alarm is the real
		// mechanism; running this every minute would pay for a request for nothing.
		triggers: [triggers.scheduled({ schedule: "*/15 * * * *" })],
		env: {
			// The bot: the singleton Discord socket, and one session per guild.
			BOT_GATEWAY: bindings.durableObject({ worker: "eryn", exportName: "BotGatewayV5" }),
			BOT_SESSION: bindings.durableObject({ worker: "eryn", exportName: "BotSessionV5" }),

			// Discord: the bot token powers the socket, slash commands, and threads.
			DISCORD_BOT_TOKEN: bindings.secret(),

			// base64url 32-byte key protecting every stored credential at rest.
			ENCRYPTION_KEY: bindings.secret(),
			// Signs external MCP sign-in state and callback links.
			SESSION_SECRET: bindings.secret(),

			// Public origin used in links and OAuth callbacks.
			PUBLIC_ORIGIN: bindings.text("https://eryn.otbeaumont.me"),

			// How often the bot gateway's keepalive alarm fires; a long interval is
			// both safe and cheap because a session resume loses no messages.
			DISCORD_KEEPALIVE_SECONDS: bindings.text("840"),
			// Seconds a single agent turn may run before it is interrupted.
			DISCORD_TURN_TIMEOUT_SECONDS: bindings.text("900"),

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
