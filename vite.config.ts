import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";

import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig, type Plugin } from "vite";

/**
 * Rebuild the prerendered landing page while `cf dev` is running.
 *
 * The landing page is a static asset, not a Worker route. This watcher keeps
 * `assets/index.html` in step with the Solid components during development;
 * `pnpm build` regenerates it once before the Cloudflare build.
 */
function landingPrerender(): Plugin {
	return {
		name: "eryn-landing-page",
		apply: "serve",
		configureServer(server) {
			const directory = path.join(server.config.root, "src", "landing");
			const shared = path.join(server.config.root, "src", "public.ts");
			const watched = [directory, shared];
			let building = false;
			let queued = false;

			const rebuild = () => {
				if (building) {
					queued = true;
					return;
				}
				building = true;
				execFile(
					process.execPath,
					["scripts/prerender.mjs"],
					{ cwd: server.config.root },
					(error, stdout, stderr) => {
						building = false;
						if (error) server.config.logger.error(`[landing] ${stderr || error.message}`);
						else if (stdout.trim()) server.config.logger.info(stdout.trim());
						if (queued) {
							queued = false;
							rebuild();
						}
					},
				);
			};

			server.watcher.add(directory);
			server.watcher.add(shared);
			server.watcher.on("all", (_event, file) => {
				if (watched.some((entry) => file === entry || file.startsWith(entry + path.sep))) rebuild();
			});
			rebuild();
		},
	};
}

export default defineConfig({
	// `assets/` is the public directory. Vite emits its files as static assets
	// alongside the Worker; the landing page is prerendered into `assets/index.html`.
	publicDir: "assets",
	// The Cloudflare plugin builds the Worker from cloudflare.config.ts.
	plugins: [cloudflare(), landingPrerender()],
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
