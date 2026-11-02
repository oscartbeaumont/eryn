import path from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	// The Solid console builds as a client-only bundle from the root index.html;
	// the Cloudflare plugin builds the Worker from cloudflare.config.ts and
	// serves the console as static assets.
	plugins: [solid(), tailwindcss(), cloudflare()],
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
