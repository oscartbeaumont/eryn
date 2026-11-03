/**
 * A filtered models.dev catalogue for an embedded OpenCode host.
 *
 * OpenCode 2.2 bundles the whole models.dev catalogue (about 7.8 MB of JSON)
 * and decodes all of it the first time it needs a model. In a Durable Object
 * that decoded graph is enough to hit the 128 MB isolate limit, so the host
 * asks for this endpoint instead: the bundled catalogue is used only when it is
 * told to, and it is told not to.
 *
 * The shape is the models.dev one, minus the model lists of providers the guild
 * has not connected. A provider entry stays (so the setup picker can still list
 * what can be connected), but its `models` object is empty, which is a few
 * hundred kilobytes for the whole catalogue rather than several megabytes.
 *
 * The rewrite is textual on purpose. Parsing nine megabytes of JSON into
 * objects, only to throw nearly all of it away again, is the same allocation
 * problem in a smaller isolate.
 */

/** The models.dev catalogue OpenCode would fetch itself. */
const CATALOGUE_URL = "https://models.opencode.ai/experimental/v2.0/api.json?type=chat,decision,image";

/** Long enough to spare models.dev a request per host build, short enough to stay current. */
const CATALOGUE_TTL_SECONDS = 300;

/** A provider id is safe to put in a URL and compare to a catalogue key. */
const PROVIDER_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** How many providers a host may ask to keep in full. */
const MAX_PROVIDERS = 32;

/** The request path this endpoint answers. */
export const CATALOGUE_PATH = "/api/bot/models-catalogue";

/** Whether a request is for the catalogue endpoint. */
export function isCatalogueRequest(path: string): boolean {
	return path === CATALOGUE_PATH || path.startsWith(`${CATALOGUE_PATH}/`);
}

/**
 * The providers to keep in full, from the path segment after the endpoint.
 *
 * Anything malformed is dropped rather than rejected: the worst case is a host
 * that gets the provider list without model details, not a broken one.
 */
export function requestedProviders(path: string): string[] {
	const rest = path.slice(CATALOGUE_PATH.length).replace(/^\/+/, "");
	const segment = rest.split("/")[0] ?? "";
	let decoded: string;
	try {
		decoded = decodeURIComponent(segment);
	} catch {
		return [];
	}
	const ids = decoded.split(",").filter((id) => PROVIDER_ID.test(id));
	return [...new Set(ids)].slice(0, MAX_PROVIDERS);
}

/** The index just past a JSON string that starts at `i`. */
function endOfString(text: string, i: number): number {
	for (i += 1; i < text.length; i++) {
		const char = text[i];
		if (char === "\\") {
			i += 1;
		} else if (char === '"') {
			return i + 1;
		}
	}
	throw new Error("unterminated string in the catalogue");
}

/** The index just past a JSON object or array that starts at `i`. */
function endOfContainer(text: string, i: number): number {
	const open = text[i];
	const close = open === "{" ? "}" : "]";
	let depth = 0;
	for (; i < text.length; i++) {
		const char = text[i];
		if (char === '"') {
			i = endOfString(text, i) - 1;
		} else if (char === "{" || char === "[") {
			depth += 1;
		} else if (char === "}" || char === "]") {
			depth -= 1;
			if (depth === 0) {
				if (char !== close) throw new Error("mismatched brackets in the catalogue");
				return i + 1;
			}
		}
	}
	throw new Error("unterminated object in the catalogue");
}

/**
 * The same provider object with its `models` value replaced by `{}`.
 *
 * Only a key at the top level of the provider object counts; a model may well
 * have its own `models` field nested below, and that must be left alone.
 */
function withoutModels(provider: string): string {
	let i = 0;
	if (provider[i] !== "{") return provider;
	i += 1;
	while (i < provider.length) {
		while (i < provider.length && /[\s,]/.test(provider[i] ?? "")) i += 1;
		if (provider[i] === "}") return provider;
		if (provider[i] !== '"') return provider;
		const keyEnd = endOfString(provider, i);
		const key = provider.slice(i + 1, keyEnd - 1);
		i = keyEnd;
		while (i < provider.length && provider[i] !== ":") i += 1;
		i += 1;
		const valueStart = i;
		if (provider[i] === "{" || provider[i] === "[") {
			const valueEnd = endOfContainer(provider, i);
			if (key === "models") {
				return `${provider.slice(0, valueStart)}{}${provider.slice(valueEnd)}`;
			}
			i = valueEnd;
		} else if (provider[i] === '"') {
			i = endOfString(provider, i);
		} else {
			while (i < provider.length && provider[i] !== "," && provider[i] !== "}") i += 1;
		}
	}
	return provider;
}

/**
 * Rewrite a models.dev catalogue so only `keep` keeps its model list.
 *
 * Exported for tests; everything else goes through {@link catalogueResponse}.
 */
export function filterCatalogue(text: string, keep: readonly string[]): string {
	const kept = new Set(keep);
	let i = 0;
	while (i < text.length && text[i] !== "{") i += 1;
	if (i === text.length) throw new Error("the catalogue is not a JSON object");
	i += 1;

	const entries: string[] = [];
	while (i < text.length) {
		while (i < text.length && /[\s,]/.test(text[i] ?? "")) i += 1;
		if (text[i] === "}") break;
		if (text[i] !== '"') throw new Error("expected a provider name in the catalogue");
		const keyEnd = endOfString(text, i);
		const key = text.slice(i + 1, keyEnd - 1);
		i = keyEnd;
		while (i < text.length && text[i] !== ":") i += 1;
		i += 1;
		while (i < text.length && /\s/.test(text[i] ?? "")) i += 1;
		const valueStart = i;
		if (text[i] !== "{") throw new Error("expected a provider object in the catalogue");
		const valueEnd = endOfContainer(text, i);
		const provider = text.slice(valueStart, valueEnd);
		const value = kept.has(key) ? provider : withoutModels(provider);
		entries.push(`${JSON.stringify(key)}:${value}`);
		i = valueEnd;
	}

	return `{${entries.join(",")}}`;
}

/**
 * Fetch the upstream catalogue once, then rewrite it for `keep`.
 *
 * The cache key is the upstream URL, not the caller's provider set: otherwise
 * every distinct keep-list is a multi-megabyte fetch.
 */
async function loadCatalogue(keep: readonly string[]): Promise<string> {
	let cache: Cache | undefined;
	try {
		cache = caches.default;
	} catch {
		// Durable Objects have no Cache API; a direct call still works.
	}
	const key = new Request(CATALOGUE_URL);
	const hit = await cache?.match(key);
	if (hit) return filterCatalogue(await hit.text(), keep);

	const response = await fetch(CATALOGUE_URL, { headers: { accept: "application/json" } });
	if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
	const text = await response.text();
	try {
		await cache?.put(
			key,
			new Response(text, {
				headers: {
					"content-type": "application/json",
					"cache-control": `public, max-age=${CATALOGUE_TTL_SECONDS}`,
				},
			}),
		);
	} catch {
		// A cache miss costs one upstream request; it must not fail the host.
	}
	return filterCatalogue(text, keep);
}

/**
 * Answer a catalogue request.
 *
 * On failure the caller still needs a usable host: an unavailable catalogue is
 * better than one that cannot start, so this answers with no providers at all
 * and the host runs without a model list until the next build.
 */
export async function catalogueResponse(request: Request): Promise<Response> {
	const keep = requestedProviders(new URL(request.url).pathname);
	try {
		return new Response(await loadCatalogue(keep), {
			headers: {
				"content-type": "application/json",
				"cache-control": `public, max-age=${CATALOGUE_TTL_SECONDS}`,
			},
		});
	} catch {
		return new Response("{}", {
			headers: { "content-type": "application/json", "cache-control": "no-store" },
		});
	}
}
