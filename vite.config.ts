import path from "node:path";

import { cloudflare } from "@cloudflare/vite-plugin";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	// `assets/` is the public directory. The landing page is server-rendered by
	// the Worker, so there is no generated `index.html` to keep in sync.
	publicDir: "assets",
	// The Cloudflare plugin builds the Worker from cloudflare.config.ts. Solid
	// supplies the SSR handler and the client bundle the page hydrates from;
	// the Worker entry stays `src/index.ts` so the bot's Durable Objects,
	// scheduled handler, and API routes live beside it.
	plugins: [
		cloudflare(),
		solid({
			start: {
				app: "./src/landing/app.tsx",
				document: "./src/landing/Document.tsx",
				externalServer: true,
			},
			ssr: true,
		}),
		tailwindcss(),
	],
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
