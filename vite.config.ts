import { cloudflare } from "@cloudflare/vite-plugin";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	// The Solid console builds as a client-only bundle from the root index.html;
	// the Cloudflare plugin builds the Worker from cloudflare.config.ts and
	// serves the console as static assets.
	plugins: [solid(), tailwindcss(), cloudflare()],
});
