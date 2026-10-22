/**
 * The Eryn MCP server, built with Effect's `McpServer`.
 *
 * It is mounted at `/mcp` as a Streamable HTTP endpoint and speaks the MCP
 * revisions OpenCode and other harnesses negotiate — the newest stateless
 * revision (2026-07-28) down to 2024-11-05. Authentication is enforced one
 * layer up, in the Worker's `fetch`, so this module only ever describes
 * tools.
 *
 * Discord and GitHub are deliberately absent: the console lets you enable and
 * link them, but the wiring lands in a later change. Until then the only tool
 * is a random number generator, which proves the transport, discovery, and
 * OAuth plumbing end to end without needing any account.
 */

import { env } from "cloudflare:workers";
import { Context, Effect, Layer } from "effect";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";

/** The public path the server is mounted at. Mirrors `MCP_PATH` in `./oauth`. */
export const MCP_PATH = "/mcp";

const DEFAULT_ORIGIN = "https://eryn.otbeaumont.me";

/**
 * Origins allowed to call the endpoint from a browser.
 *
 * `layerHttp` rejects any request carrying an `Origin` header that is not
 * listed here, so this has to include Eryn's own console — otherwise the
 * console's self-test would be refused by its own server. Non-browser clients
 * (OpenCode, Claude, Cursor) send no `Origin` at all and are unaffected.
 */
export function allowedOrigins(): ReadonlyArray<string> {
	const configured = env.PUBLIC_ORIGIN?.trim().replace(/\/$/, "");
	return configured && configured !== DEFAULT_ORIGIN ? [configured, DEFAULT_ORIGIN] : [DEFAULT_ORIGIN];
}

export const INSTRUCTIONS = [
	"Eryn is a personal agent. Its MCP tools are intentionally small:",
	"they are the capabilities the Discord bot and its cloud sessions share.",
	"Discord and GitHub tools are planned but not yet enabled.",
].join(" ");

const DEFAULT_MAX = 100;
const MAX_COUNT = 100;

interface RandomNumberInput {
	min?: number;
	max?: number;
	count?: number;
}

/** Clamp a possibly-absent integer argument. */
function intArg(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/** A uniformly random integer in `[min, max]` (inclusive), rejection-free. */
function randomBetween(min: number, max: number): number {
	const span = max - min + 1;
	if (span <= 0) return min;
	const limit = Math.floor(0xffffffff / span) * span;
	const buffer = new Uint32Array(1);
	let value: number;
	do {
		crypto.getRandomValues(buffer);
		value = buffer[0]!;
	} while (value >= limit);
	return min + (value % span);
}

/** The tool the gateway registers for every caller, whatever else it fronts. */
export const randomNumber = new McpSchema.Tool({
	name: "random_number",
	title: "Random number",
	description:
		"Generate one or more uniformly random integers, inclusive of both bounds. Use it to roll dice, pick a winner, or add jitter.",
	inputSchema: {
		type: "object",
		properties: {
			min: { type: "integer", description: "Smallest value that may be returned (inclusive). Defaults to 0." },
			max: { type: "integer", description: "Largest value that may be returned (inclusive). Defaults to 100." },
			count: { type: "integer", description: `How many numbers to return, 1-${MAX_COUNT}. Defaults to 1.` },
		},
		required: [],
		additionalProperties: false,
	},
	annotations: {
		title: "Random number",
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
});

/** How the tool renders itself to the model and to structured-output clients. */
export function runRandomNumber(args: unknown): McpSchema.CallToolResult {
	const input = (args ?? {}) as RandomNumberInput;
	const min = intArg(input.min, 0);
	const max = intArg(input.max, DEFAULT_MAX);
	if (max < min) {
		return new McpSchema.CallToolResult({
			isError: true,
			content: [{ type: "text", text: `max (${max}) must be greater than or equal to min (${min}).` }],
		});
	}
	const count = Math.min(Math.max(intArg(input.count, 1), 1), MAX_COUNT);
	const numbers = Array.from({ length: count }, () => randomBetween(min, max));
	const text =
		count === 1
			? `${numbers[0]}`
			: `You rolled: ${numbers.join(", ")} (each between ${min} and ${max}).`;
	return new McpSchema.CallToolResult({
		content: [{ type: "text", text }],
		structuredContent: { numbers },
	});
}

/** Registers every tool onto the shared `McpServer` instance. */
const tools = Layer.effectDiscard(
	Effect.gen(function* () {
		const server = yield* McpServer.McpServer;
		yield* server.addTool({
			tool: randomNumber,
			annotations: Context.empty(),
			handle: (args) => Effect.sync(() => runRandomNumber(args)),
		});
	}),
	// The transport layer builds the same `McpServer.layer`; Effect memoises it by
	// identity, so registration and the HTTP endpoint share one instance.
).pipe(Layer.provide(McpServer.McpServer.layer));

/**
 * The MCP layer. Merged into the Worker's route layer, where the MCP and the
 * JSON API share one `HttpRouter` and therefore one web handler.
 */
export const mcpServer = Layer.merge(
	McpServer.layerHttp({
		name: "eryn",
		version: "1.0.0",
		instructions: INSTRUCTIONS,
		path: MCP_PATH,
		allowedOrigins: allowedOrigins(),
		protocols: [
			McpProtocol.v2026_07_28,
			McpProtocol.v2025_11_25,
			McpProtocol.v2025_06_18,
			McpProtocol.v2025_03_26,
			McpProtocol.v2024_11_05,
		],
	}),
	tools,
);

/** The catalogue the console renders, kept next to the tools it describes. */
export const TOOL_CATALOGUE = [
	{
		name: randomNumber.name,
		title: randomNumber.title ?? randomNumber.name,
		description: randomNumber.description ?? "",
		group: "builtin" as const,
		enabled: true,
	},
];
