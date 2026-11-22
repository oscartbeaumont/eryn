/** Serve a shared workspace file for a valid, unexpired token. */

import { readFileToken } from "./token.ts";

const PREFIX = "/files/";

/**
 * Image types that are inert when a browser renders them in place. Everything
 * else is a download: an uploaded HTML or SVG file must never run on this
 * origin.
 */
const INLINE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** An ASCII filename for the plain `filename` parameter of a disposition. */
function asciiName(name: string): string {
	return name.replaceAll(/[^A-Za-z0-9._-]/g, "_") || "file";
}

/** `attachment` (or `inline` for an image) naming the object's own filename. */
function disposition(name: string, inline: boolean): string {
	const encoded = encodeURIComponent(name).replaceAll("'", "%27");

	return `${inline ? "inline" : "attachment"}; filename="${asciiName(name)}"; filename*=UTF-8''${encoded}`;
}

export async function handleFileRequest(request: Request, env: Env): Promise<Response | undefined> {
	const url = new URL(request.url);

	if (!url.pathname.startsWith(PREFIX)) return undefined;
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method not allowed", { status: 405 });
	}

	const key = decodeURIComponent(url.pathname.slice(PREFIX.length));
	const allowed = await readFileToken(env, url.searchParams.get("token"));

	if (!allowed || allowed !== key) return new Response("Not found", { status: 404 });

	const object = await env.ARTIFACTS.get(key);

	if (!object) return new Response("Not found", { status: 404 });
	const headers = new Headers();

	object.writeHttpMetadata(headers);
	headers.set("cache-control", "private, max-age=3600");
	headers.set("x-content-type-options", "nosniff");
	const contentType = (headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
	const inline = INLINE_IMAGES.has(contentType);
	const name = key.slice(key.lastIndexOf("/") + 1) || "file";

	headers.set("content-disposition", disposition(name, inline));

	// A sandboxed document gets an opaque origin, so even a type that slipped
	// past the allowlist cannot touch the app it was served from.
	if (!inline) headers.set("content-security-policy", "sandbox");

	if (request.method === "HEAD") return new Response(null, { status: 200, headers });

	return new Response(object.body, { status: 200, headers });
}
