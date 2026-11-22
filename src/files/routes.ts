/** Serve a shared workspace file for a valid, unexpired token. */

import { readFileToken } from "./token.ts";

const PREFIX = "/files/";

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

	if (request.method === "HEAD") return new Response(null, { status: 200, headers });

	return new Response(object.body, { status: 200, headers });
}
