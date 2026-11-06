/**
 * The brand image paths, and the Worker route that serves them.
 *
 * The files live in `assets/` and are deployed as Cloudflare static assets, so
 * the source tree never carries base64 copies. `/brand/*` and `/favicon.ico`
 * are routed to the Worker only so these responses keep the long-lived cache
 * and nosniff headers the pages have always used.
 */

export const BRAND = {
	banner: "/brand/banner.webp",
	mark: "/brand/mark.webp",
	icon: "/brand/icon-64.png",
	appleIcon: "/brand/apple-touch-icon.png",
	favicon: "/favicon.ico",
} as const;

/** The paths handled by {@link brandAsset}; keep in sync with `assets.runWorkerFirst`. */
export function isBrandAsset(pathname: string): boolean {
	return pathname.startsWith("/brand/") || pathname === BRAND.favicon;
}

/** Serve one brand file through the Worker's static-assets binding. */
export async function brandAsset(request: Request, env: Env): Promise<Response> {
	const response = await env.ASSETS.fetch(request);
	const headers = new Headers(response.headers);
	headers.set("x-content-type-options", "nosniff");
	if (response.ok) headers.set("cache-control", "public, max-age=31536000, immutable");
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}
