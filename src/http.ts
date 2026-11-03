/**
 * Fetch a URL and follow redirects ourselves.
 *
 * Cloudflare's `fetch` only implements `follow` and `manual` for `redirect`.
 * Following automatically would let an external MCP server bounce an HTTPS
 * request to an arbitrary host, so each hop is checked instead.
 */

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

function isLoopback(hostname: string): boolean {
	return (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "::1" ||
		hostname === "[::1]"
	);
}

function assertSupported(url: URL, allowLoopback: boolean): void {
	if (url.protocol === "https:") return;
	if (allowLoopback && url.protocol === "http:" && isLoopback(url.hostname)) return;
	throw new Error("A redirect pointed at an unsupported URL.");
}

export async function fetchWithRedirects(
	input: URL | string,
	init: RequestInit = {},
): Promise<Response> {
	let current = typeof input === "string" ? new URL(input) : input;
	// Loopback HTTP is a development escape hatch, but only for the first hop:
	// an external HTTPS server must not be able to redirect into the local host.
	const allowLoopback = current.protocol === "http:" && isLoopback(current.hostname);
	assertSupported(current, allowLoopback);
	let options: RequestInit = { ...init, redirect: "manual" };

	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const response = await fetch(current, options);
		const location = response.headers.get("location");
		if (!REDIRECT_STATUSES.has(response.status) || !location) return response;

		await response.body?.cancel().catch(() => undefined);
		if (hop === MAX_REDIRECTS) throw new Error("Too many redirects.");

		const next = new URL(location, current);
		assertSupported(next, allowLoopback);
		current = next;

		// 303 always becomes a GET. 301/302 do the same for non-GET/HEAD, which
		// is what the fetch standard specifies.
		const nonGet = options.method !== undefined && options.method !== "GET" && options.method !== "HEAD";
		if (response.status === 303 || ((response.status === 301 || response.status === 302) && nonGet)) {
			const headers = new Headers(options.headers);
			headers.delete("content-type");
			headers.delete("content-length");
			options = { ...options, method: "GET", body: undefined, headers };
		}
	}

	throw new Error("Too many redirects.");
}
