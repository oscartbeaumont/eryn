import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

/**
 * Render the Solid landing page to `assets/index.html`.
 *
 * Vite handles the TSX and Tailwind compilation; this script only drives the
 * SSR render and writes the result where Cloudflare serves static files from.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const origin = (process.env.PUBLIC_ORIGIN ?? "https://eryn.otbeaumont.me").replace(/\/$/, "");

const server = await createServer({
	root,
	configFile: path.join(root, "vite.landing.config.ts"),
	appType: "custom",
	logLevel: "warn",
	server: {
		middlewareMode: true,
		hmr: false,
		watch: null,
	},
});

try {
	const { renderLanding } = await server.ssrLoadModule("/src/landing/prerender.tsx");
	const html = renderLanding(origin);
	await mkdir(path.join(root, "assets"), { recursive: true });
	await writeFile(path.join(root, "assets/index.html"), html);
	console.log(`eryn: wrote assets/index.html (${html.length.toLocaleString()} bytes)`);
} finally {
	await server.close();
}
