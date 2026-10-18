import { cloudflare } from "@cloudflare/vite-plugin";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
	// The Solid app builds as a client-only bundle from the root index.html;
	// the Cloudflare plugin builds the Worker from cloudflare.config.ts and
	// serves the client as static assets.
	plugins: [solid(), tailwindcss(), cloudflare()],
});
