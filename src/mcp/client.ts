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

import { Schema } from "effect";

import { describeError } from "../errors";
import { fetchWithRedirects, isSecureUrl } from "../http";
import type { McpProbeResponse, McpToolSummary } from "../session/models";
import { decode } from "./wire";

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
	if (!isSecureUrl(endpoint)) return failed("An MCP server URL must use https.");
	if (endpoint.username || endpoint.password) {
		return failed("An MCP server URL must not contain a username or password.");
	}
	endpoint.hash = "";

	const token = options.token;
	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

	// Every request carries the same headers; only the session and the
	// negotiated protocol revision change, and only after `initialize`.
	const headers = (sessionId?: string, protocolVersion?: string): Record<string, string> => ({
		accept: "application/json, text/event-stream",
		...(token ? { authorization: `Bearer ${token}` } : {}),
		...(sessionId ? { "mcp-session-id": sessionId } : {}),
		...(protocolVersion ? { "mcp-protocol-version": protocolVersion } : {}),
	});
	const post = (body: unknown, sessionId?: string, protocolVersion?: string): Promise<Response> =>
		fetchWithRedirects(endpoint, {
			method: "POST",
			headers: { ...headers(sessionId, protocolVersion), "content-type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
	const rpc = async (
		request: RpcRequest,
		sessionId?: string,
		protocolVersion?: string,
	): Promise<RpcResult> => {
		const response = await post({ jsonrpc: "2.0", ...request }, sessionId, protocolVersion);
		if (!response.ok) {
			// Drain the body so the connection can be reused; the status and headers
			// are all this call is interested in.
			await response.body?.cancel().catch(() => undefined);
			return { response };
		}
		const message = (await readReply(response, request.id)) as RpcResult["message"];
		if (message?.error) {
			throw new Error(message.error.message ?? `The server returned JSON-RPC error ${message.error.code ?? "?"}.`);
		}
		return { response, message };
	};
	const notify = async (method: string, sessionId: string | undefined, protocolVersion: string): Promise<void> => {
		const response = await post({ jsonrpc: "2.0", method }, sessionId, protocolVersion);
		await response.body?.cancel().catch(() => undefined);
	};

	let sessionId: string | undefined;
	try {
		const initialize = await rpc({
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: PROTOCOL_VERSION,
				capabilities: {},
				clientInfo: { name: "eryn", version: "1.0.0" },
			},
		});

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
					(token
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

		await notify("notifications/initialized", sessionId, protocolVersion);

		const tools: McpToolSummary[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < MAX_TOOL_PAGES; page++) {
			const listing = await rpc(
				{
					id: 2 + page,
					method: "tools/list",
					params: cursor ? { cursor } : {},
				},
				sessionId,
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
			await fetchWithRedirects(endpoint, {
				method: "DELETE",
				headers: headers(sessionId),
				signal: AbortSignal.timeout(2_000),
			}).catch(() => undefined);
		}
	}
}

function failed(error: string, status?: number): ProbeFailure {
	return { ok: false, tools: [], error, ...(status === undefined ? {} : { status }) };
}

interface RpcRequest {
	readonly id: number;
	readonly method: string;
	readonly params?: unknown;
}

interface RpcResult {
	response: Response;
	message?: { result?: unknown; error?: { code?: number; message?: string } };
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
