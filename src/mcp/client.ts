/**
 * An MCP client for a remote server, over Streamable HTTP.
 *
 * Eryn has to speak MCP as a client for two reasons. The obvious one is the
 * gateway, which lists and calls the tools of the servers a user has connected.
 * The other is OAuth: OpenCode's own MCP client opens a listener on `127.0.0.1`
 * to receive the authorization callback, which a Worker cannot do, so the flow
 * has to be Eryn's and the agent is handed a plain bearer header instead.
 *
 * Only what a gateway needs is implemented — `initialize`, `tools/list`, and
 * `tools/call` — and each call is self-contained: a Worker has no long-lived
 * connection to hang a session off, so a session is opened, used, and dropped.
 */

/** One tool an upstream server publishes, as it publishes it. */
export interface McpTool {
	name: string;
	title?: string;
	description?: string;
	inputSchema: unknown;
	annotations?: unknown;
}

/** One tool call's result, already unwrapped from JSON-RPC. */
export interface McpToolResult {
	content?: unknown;
	structuredContent?: unknown;
	isError?: boolean;
}

/** Where a server lives and what it costs to talk to it. */
export interface McpTarget {
	url: string;
	/** The bearer token to present, when the server needs one. */
	token?: string;
}

/** The MCP revision this client speaks. Servers negotiate down if they must. */
const PROTOCOL_VERSION = "2025-06-18";
const CLIENT_INFO = { name: "eryn", version: "1.0.0" };
/** A remote server is given a moment, but a hanging one must not hold a turn. */
const TIMEOUT_MS = 20_000;

/** Raised when the server wants a credential we do not have, or no longer have. */
export class McpUnauthorized extends Error {
	/** The `WWW-Authenticate` header, which is where the server names its metadata. */
	readonly challenge: string | undefined;

	constructor(challenge?: string) {
		super("that MCP server needs a sign-in");
		this.name = "McpUnauthorized";
		this.challenge = challenge;
	}
}

/** Anything else that went wrong talking to the server. */
export class McpError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "McpError";
	}
}

interface JsonRpcResponse {
	jsonrpc?: string;
	id?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
}

/**
 * Read the JSON-RPC reply out of a Streamable HTTP response.
 *
 * A server may answer with plain JSON or with an SSE stream, and only the frame
 * carrying our request id is the answer — the others are server-initiated
 * notifications, which this client does not keep a channel open for.
 */
function readReply(text: string, contentType: string, id: number): JsonRpcResponse | undefined {
	if (contentType.includes("text/event-stream")) {
		let found: JsonRpcResponse | undefined;
		for (const line of text.split("\n")) {
			if (!line.startsWith("data:")) continue;
			try {
				const frame = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
				if (frame?.id === id) found = frame;
			} catch {
				// A frame that is not JSON is not our answer.
			}
		}
		return found;
	}
	try {
		return JSON.parse(text) as JsonRpcResponse;
	} catch {
		return undefined;
	}
}

interface Session {
	sessionId?: string;
}

/** POST one JSON-RPC message and return its result. */
async function rpc(target: McpTarget, message: Record<string, unknown>, session?: Session): Promise<unknown> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		// Both are accepted; a server that streams answers back is fine.
		accept: "application/json, text/event-stream",
		"mcp-protocol-version": PROTOCOL_VERSION,
	};
	if (target.token) headers.authorization = `Bearer ${target.token}`;
	if (session?.sessionId) headers["mcp-session-id"] = session.sessionId;

	const response = await fetch(target.url, {
		method: "POST",
		headers,
		body: JSON.stringify(message),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	}).catch((error) => {
		throw new McpError(`${target.url} could not be reached: ${error instanceof Error ? error.message : String(error)}`);
	});

	if (response.status === 401 || response.status === 403) {
		throw new McpUnauthorized(response.headers.get("www-authenticate") ?? undefined);
	}
	// A notification is acknowledged with 202 and no body.
	if (response.status === 202 || response.status === 204) return undefined;
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new McpError(`${target.url} returned HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
	}

	const assigned = response.headers.get("mcp-session-id");
	if (session && assigned) session.sessionId = assigned;

	const id = typeof message.id === "number" ? message.id : undefined;
	if (id === undefined) return undefined;

	const text = await response.text();
	const reply = readReply(text, response.headers.get("content-type") ?? "", id);
	if (!reply) throw new McpError(`${target.url} did not answer with a JSON-RPC reply`);
	if (reply.error) throw new McpError(reply.error.message ?? `JSON-RPC error ${reply.error.code ?? ""}`.trim());
	return reply.result;
}

/** Open a session, which is also where the server states its protocol revision. */
async function initialize(target: McpTarget): Promise<Session> {
	const session: Session = {};
	await rpc(
		target,
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
		},
		session,
	);
	// Best effort: a server that does not want the acknowledgement still works.
	await rpc(target, { jsonrpc: "2.0", method: "notifications/initialized" }, session).catch(() => undefined);
	return session;
}

/** Every tool a server publishes, following pagination to the end. */
export async function listTools(target: McpTarget): Promise<McpTool[]> {
	const session = await initialize(target);
	const tools: McpTool[] = [];
	let cursor: string | undefined;
	// A cap, so a server that paginates forever cannot hold a request open.
	for (let page = 0; page < 20; page++) {
		const result = (await rpc(
			target,
			{ jsonrpc: "2.0", id: 2, method: "tools/list", params: cursor ? { cursor } : {} },
			session,
		)) as { tools?: unknown; nextCursor?: unknown } | undefined;
		const listed = Array.isArray(result?.tools) ? result.tools : [];
		for (const entry of listed) {
			const tool = entry as { name?: unknown; title?: unknown; description?: unknown; inputSchema?: unknown; annotations?: unknown };
			if (typeof tool.name !== "string" || !tool.name) continue;
			tools.push({
				name: tool.name,
				...(typeof tool.title === "string" ? { title: tool.title } : {}),
				...(typeof tool.description === "string" ? { description: tool.description } : {}),
				inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
				...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
			});
		}
		if (typeof result?.nextCursor !== "string" || !result.nextCursor) break;
		cursor = result.nextCursor;
	}
	return tools;
}

/** Call one tool. */
export async function callTool(target: McpTarget, name: string, args: unknown): Promise<McpToolResult> {
	const session = await initialize(target);
	const result = (await rpc(
		target,
		{ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args ?? {} } },
		session,
	)) as McpToolResult | undefined;
	return result ?? {};
}
