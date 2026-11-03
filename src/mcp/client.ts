/**
 * A minimal Streamable HTTP MCP client, used only to test a server.
 *
 * Adding an MCP server to a guild is a conversation, so the important part is a
 * clear answer before anything is stored: does this URL speak MCP, what does it
 * offer, and what does it want before it will talk? The SDK client is not used
 * because a server that refuses has to be reported as data (its status and
 * `WWW-Authenticate` header drive the OAuth step), not as a thrown error.
 *
 * The probe performs exactly what the protocol requires of a client —
 * `initialize`, `notifications/initialized`, then `tools/list` — and closes the
 * session again. It never calls a tool.
 */

import { Option, Schema } from "effect";

import { describeError } from "../errors";
import type { McpProbeResponse, McpToolSummary } from "../session/models";

/** The protocol revision this client asks for. A server may negotiate another. */
const PROTOCOL_VERSION = "2025-06-18";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TOOL_PAGES = 10;

const InitializeResultSchema = Schema.Struct({
	protocolVersion: Schema.optional(Schema.String),
	serverInfo: Schema.optional(
		Schema.Struct({
			name: Schema.optional(Schema.String),
			version: Schema.optional(Schema.String),
		}),
	),
});

const ListToolsResultSchema = Schema.Struct({
	tools: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			title: Schema.optional(Schema.String),
			description: Schema.optional(Schema.String),
		}),
	),
	nextCursor: Schema.optional(Schema.String),
});

const JsonRpcResponseSchema = Schema.Struct({
	result: Schema.optional(Schema.Unknown),
	error: Schema.optional(
		Schema.Struct({
			code: Schema.optional(Schema.Number),
			message: Schema.optional(Schema.String),
		}),
	),
});

export interface ProbeOptions {
	url: string;
	/** A bearer to present, whether a static token or an OAuth access token. */
	token?: string;
	timeoutMs?: number;
}

interface Challenge {
	/** The auth scheme the server named, lowercased. */
	scheme?: string;
	resourceMetadataUrl?: string;
	scope?: string;
	error?: string;
	errorDescription?: string;
}

/** Everything the caller needs to decide between OAuth, a token, or giving up. */
export interface ProbeFailure extends McpProbeResponse {
	ok: false;
	status?: number;
}

export type ProbeResult = (McpProbeResponse & { ok: true }) | ProbeFailure;

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
	if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && isLoopback(endpoint.hostname))) {
		return failed("An MCP server URL must use https.");
	}
	if (endpoint.username || endpoint.password) {
		return failed("An MCP server URL must not contain a username or password.");
	}
	endpoint.hash = "";
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

	let sessionId: string | undefined;
	try {
		const initialize = await rpc(
			endpoint,
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "eryn", version: "1.0.0" },
				},
			},
			options.token,
			undefined,
			timeoutMs,
		);

		if (initialize.response.status === 401 || initialize.response.status === 403) {
			const header = initialize.response.headers.get("www-authenticate");
			const challenge = parseChallenge(header);
			// A challenge may list several schemes; only Bearer can carry a
			// sign-in or a token, so the others are reported as a plain refusal.
			const bearer = !header || /\bbearer\b/i.test(header);
			return {
				ok: false,
				tools: [],
				needsAuth: bearer ? true : undefined,
				...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
				...(challenge.scope ? { scope: challenge.scope } : {}),
				status: initialize.response.status,
				error:
					challenge.errorDescription ??
					challenge.error ??
					(options.token
						? "This server rejected the token."
						: "This server needs authorisation before it will talk."),
			};
		}
		if (!initialize.response.ok) {
			return failed(
				`The server answered HTTP ${initialize.response.status}.`,
				initialize.response.status,
			);
		}

		sessionId = initialize.response.headers.get("mcp-session-id") ?? undefined;
		const initialized = decode(InitializeResultSchema, initialize.message?.result);
		if (!initialized) return failed("The server's initialize response was not MCP.");
		const protocolVersion = initialized.protocolVersion ?? PROTOCOL_VERSION;

		await notify(
			endpoint,
			"notifications/initialized",
			options.token,
			sessionId,
			protocolVersion,
			timeoutMs,
		);

		const tools: McpToolSummary[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_TOOL_PAGES; page++) {
			const listing = await rpc(
				endpoint,
				{
					jsonrpc: "2.0",
					id: 2 + page,
					method: "tools/list",
					params: cursor ? { cursor } : {},
				},
				options.token,
				sessionId,
				timeoutMs,
				protocolVersion,
			);
			if (listing.response.status === 401) {
				return {
					ok: false,
					tools,
					needsAuth: true,
					status: 401,
					error: "This server rejected the token.",
				};
			}
			if (!listing.response.ok) {
				return failed(`The server answered HTTP ${listing.response.status}.`, listing.response.status);
			}
			const result = decode(ListToolsResultSchema, listing.message?.result);
			if (!result) return failed("The server's tools/list response was not MCP.");
			tools.push(
				...result.tools.map((tool) => ({
					name: tool.name,
					...(tool.title ? { title: tool.title } : {}),
					...(tool.description ? { description: tool.description } : {}),
				})),
			);
			cursor = result.nextCursor;
			if (!cursor) break;
		}

		return {
			ok: true,
			tools,
			...(initialized.serverInfo?.name ? { serverName: initialized.serverInfo.name } : {}),
		};
	} catch (error) {
		return failed(describeError(error));
	} finally {
		if (sessionId) {
			// The session is not reused, so end it rather than leave the server
			// holding state for a test that is already over.
			await fetch(endpoint, {
				redirect: "error",
				method: "DELETE",
				headers: headers(options.token, sessionId),
				signal: AbortSignal.timeout(2_000),
			}).catch(() => undefined);
		}
	}
}

function failed(error: string, status?: number): ProbeFailure {
	return { ok: false, tools: [], error, ...(status === undefined ? {} : { status }) };
}

/** Loopback is allowed over http so a local server can be tried in development. */
function isLoopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

function headers(token: string | undefined, sessionId?: string, protocolVersion?: string): Record<string, string> {
	return {
		accept: "application/json, text/event-stream",
		...(token ? { authorization: `Bearer ${token}` } : {}),
		...(sessionId ? { "mcp-session-id": sessionId } : {}),
		...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
	};
}

interface RpcResult {
	response: Response;
	message?: { result?: unknown; error?: { code?: number; message?: string } };
}

/** Send one JSON-RPC request and read the matching reply, JSON or SSE framed. */
async function rpc(
	endpoint: URL,
	body: unknown,
	token: string | undefined,
	sessionId: string | undefined,
	timeoutMs: number,
	protocolVersion?: string,
): Promise<RpcResult> {
	const response = await fetch(endpoint, {
		method: "POST",
		redirect: "error",
		headers: { ...headers(token, sessionId, protocolVersion), "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok) {
		// Drain the body so the connection can be reused; the status and headers
		// are all this call is interested in.
		await response.body?.cancel().catch(() => undefined);
		return { response };
	}

	const message = (await readReply(response, (body as { id: number }).id)) as RpcResult["message"];
	if (message?.error) {
		throw new Error(message.error.message ?? `The server returned JSON-RPC error ${message.error.code ?? "?"}.`);
	}
	return { response, message };
}

/** Send a notification; the reply is a status code and nothing worth reading. */
async function notify(
	endpoint: URL,
	method: string,
	token: string | undefined,
	sessionId: string | undefined,
	protocolVersion: string,
	timeoutMs: number,
): Promise<void> {
	const response = await fetch(endpoint, {
		method: "POST",
		redirect: "error",
		headers: { ...headers(token, sessionId, protocolVersion), "content-type": "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", method }),
		signal: AbortSignal.timeout(timeoutMs),
	});
	await response.body?.cancel().catch(() => undefined);
}

/**
 * Read one JSON-RPC reply from a Streamable HTTP response.
 *
 * A server may answer with JSON or with an SSE stream, and an SSE stream may
 * carry notifications before the reply. The reader stops at the reply and
 * cancels the body, so a server that holds the stream open cannot hold the
 * probe open with it.
 */
async function readReply(response: Response, id: unknown): Promise<unknown> {
	const contentType = response.headers.get("content-type") ?? "";
	if (!contentType.includes("text/event-stream")) {
		return await response.json().catch(() => undefined);
	}
	if (!response.body) throw new Error("The server returned an empty event stream.");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const frame = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const data = frame
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice("data:".length).trimStart())
					.join("");
				if (!data) continue;
				let message: unknown;
				try {
					message = JSON.parse(data) as unknown;
				} catch {
					continue;
				}
				if (message && typeof message === "object" && (message as { id?: unknown }).id === id) {
					return message;
				}
				boundary = buffer.indexOf("\n\n");
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
	throw new Error("The server ended the stream without answering.");
}

/** Parse `Bearer resource_metadata="…", scope="…"` without a full HTTP parser. */
export function parseChallenge(header: string | null): Challenge {
	if (!header) return {};
	const scheme = /^\s*([A-Za-z][A-Za-z0-9_-]*)\b/.exec(header)?.[1]?.toLowerCase();
	const params: Record<string, string> = {};
	const pattern = /([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(header)) !== null) {
		params[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? "";
	}
	return {
		...(scheme ? { scheme } : {}),
		...(params.resource_metadata ? { resourceMetadataUrl: params.resource_metadata } : {}),
		...(params.scope ? { scope: params.scope } : {}),
		...(params.error ? { error: params.error } : {}),
		...(params.error_description ? { errorDescription: params.error_description } : {}),
	};
}

function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S["Type"] | undefined {
	if (input === undefined) return undefined;
	const parsed = Schema.decodeUnknownOption(schema)(input);
	return Option.isSome(parsed) ? parsed.value : undefined;
}
