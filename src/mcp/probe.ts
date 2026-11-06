/**
 * A minimal Streamable HTTP MCP client, used only to test a server.
 *
 * Adding an MCP server to a guild is a conversation, so the important part is a
 * clear answer before anything is stored: does this URL speak MCP, what does it
 * offer, and what does it want before it will talk? The official client owns the
 * protocol — initialize, the initialized notification, paginated `tools/list`,
 * SSE replies, and session teardown — while this module only turns its outcome,
 * including a 401 challenge, into data the bot can show.
 */

import {
	Client,
	extractWWWAuthenticateParams,
	SdkHttpError,
	StreamableHTTPClientTransport,
	type AuthProvider,
	type FetchLike,
} from "@modelcontextprotocol/client";

import { describeError } from "../errors";
import { fetchWithRedirects, isSecureUrl } from "../http";
import type { McpProbeResponse, McpToolSummary } from "../session/models";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TOOL_PAGES = 10;

export interface ProbeOptions {
	url: string;
	/** A bearer to present, whether a static token or an OAuth access token. */
	token?: string;
	timeoutMs?: number;
}

/** Everything the caller needs to decide between OAuth, a token, or giving up. */
export interface ProbeFailure extends McpProbeResponse {
	ok: false;
	status?: number;
}

export type ProbeResult = (McpProbeResponse & { ok: true }) | ProbeFailure;

/** Stops the transport once its auth hook has captured the challenge. */
class ChallengeSeen extends Error {
	constructor() {
		super("The server asked for authorization.");
	}
}

/**
 * Talk to an MCP server and report what it offers.
 *
 * Never throws: a refused connection, a bad URL, and a protocol error are all
 * answers the caller has to show someone.
 */
export async function probeServer(options: ProbeOptions): Promise<ProbeResult> {
	let endpoint: URL;
	try {
		endpoint = new URL(options.url);
	} catch {
		return failed("That URL is not valid.");
	}
	if (!isSecureUrl(endpoint)) return failed("An MCP server URL must use https.");
	if (endpoint.username || endpoint.password) {
		return failed("An MCP server URL must not contain a username or password.");
	}
	endpoint.hash = "";

	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	let challenge: ProbeFailure | undefined;

	// The transport calls this instead of throwing its own `UnauthorizedError`,
	// which is the only way to keep the `WWW-Authenticate` parameters a server
	// uses to point at its protected-resource metadata.
	const authProvider: AuthProvider = {
		token: async () => options.token,
		onUnauthorized: async ({ response }) => {
			challenge = challengeFailure(response, Boolean(options.token));
			await response.body?.cancel().catch(() => undefined);
			throw new ChallengeSeen();
		},
	};

	const fetchFn: FetchLike = async (input, init) => {
		const url = typeof input === "string" ? new URL(input) : input;
		return await fetchWithRedirects(url, {
			...init,
			signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
		});
	};

	const transport = new StreamableHTTPClientTransport(endpoint, {
		authProvider,
		fetch: fetchFn,
		// This module owns redirects, so the transport must not wrap the fetch
		// with a second, same-origin-only policy.
		redirectPolicy: "follow",
	});
	const client = new Client({ name: "eryn", version: "1.0.0" }, { listMaxPages: MAX_TOOL_PAGES });

	try {
		await client.connect(transport);
		const listing = await client.listTools();
		const serverName = client.getServerVersion()?.name;
		return {
			ok: true,
			tools: listing.tools.map(toolSummary),
			...(serverName ? { serverName } : {}),
		};
	} catch (error) {
		if (challenge) return challenge;
		if (error instanceof ChallengeSeen) return failed("This server needs authorisation before it will talk.");
		if (error instanceof SdkHttpError) return failed(`The server answered HTTP ${error.status}.`, error.status);
		return failed(describeError(error));
	} finally {
		// A test should not leave a server holding a session it will never use.
		await transport.terminateSession().catch(() => undefined);
		await client.close().catch(() => undefined);
	}
}

function challengeFailure(response: Response, hasToken: boolean): ProbeFailure {
	const header = response.headers.get("www-authenticate");
	const params = extractWWWAuthenticateParams(response);
	// A challenge may list several schemes; only Bearer can carry a sign-in or a
	// token, so the others are reported as a plain refusal.
	const bearer = !header || /\bbearer\b/i.test(header);
	return {
		ok: false,
		tools: [],
		...(bearer ? { needsAuth: true } : {}),
		...(params.resourceMetadataUrl ? { resourceMetadataUrl: params.resourceMetadataUrl.toString() } : {}),
		...(params.scope ? { scope: params.scope } : {}),
		status: response.status,
		error:
			params.errorDescription ??
			params.error ??
			(hasToken ? "This server rejected the token." : "This server needs authorisation before it will talk."),
	};
}

function toolSummary(tool: { name: string; title?: string; description?: string }): McpToolSummary {
	return {
		name: tool.name,
		...(tool.title ? { title: tool.title } : {}),
		...(tool.description ? { description: tool.description } : {}),
	};
}

function failed(error: string, status?: number): ProbeFailure {
	return { ok: false, tools: [], error, ...(status === undefined ? {} : { status }) };
}
