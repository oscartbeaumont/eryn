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
			// Durable Objects: one singleton gateway, one session per Discord thread.
			GATEWAY: bindings.durableObject({ worker: "eryn", exportName: "ErynGateway" }),
			SESSION: bindings.durableObject({ worker: "eryn", exportName: "ErynSession" }),

			// OpenCode Go credential for `opencode-go/deepseek-v4.1-flash`.
			OPENCODE_API_KEY: bindings.secret(),
			// Discord bot token. The bot is disabled when this is empty.
			DISCORD_BOT_TOKEN: bindings.secret(),

			// Optional: register `/stop` in one guild for instant availability.
			DISCORD_GUILD_ID: bindings.text(""),
			// Optional allowlist in the `discord` skill's shape:
			//   {"general":{"id":"123","description":"..."}}
			DISCORD_CHANNELS: bindings.text(""),
			// Seconds between gateway keepalive alarms.
			DISCORD_KEEPALIVE_SECONDS: bindings.text("60"),
			// Seconds a single agent turn may run before it is interrupted.
			DISCORD_TURN_TIMEOUT_SECONDS: bindings.text("900"),
		},
		exports: {
			ErynGateway: exports.durableObject({ storage: "sqlite" }),
			ErynSession: exports.durableObject({ storage: "sqlite" }),
		},
	},
});
