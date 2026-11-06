import path from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
	// `assets/` is the public directory. Vite emits its files as static assets
	// alongside the Worker; the bot's UI itself is still entirely Discord.
	publicDir: "assets",
	// The Cloudflare plugin builds the Worker from cloudflare.config.ts.
	plugins: [cloudflare()],
	resolve: {
		alias: {
			// The SDK does not export its embedding host, which is the only way to
			// reach the host runtime and start OpenCode's schedule runner there.
			// Pinned by version.
			"@opencode/sdk/internal/host": path.resolve(
				import.meta.dirname,
				"node_modules/@opencode/sdk/dist/internal/host.js",
			),
		},
	},
});
