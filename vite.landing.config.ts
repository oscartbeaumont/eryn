import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

/**
 * The build used only for the prerendered landing page.
 *
 * It is separate from the Worker's Vite config so Solid and Tailwind never
 * participate in bundling the Worker.
 */
export default defineConfig({
	publicDir: false,
	plugins: [solid(), tailwindcss()],
});
