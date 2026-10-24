/**
 * One hosted MCP server, served.
 *
 * Each `GatewayUser` object caches one of these per hosted server, because an
 * `McpServer` keeps a single tool registry and the tool set is per server. Core
 * MCP — tools, resources, prompts, `subscriptions/listen` — is Effect's
 * `McpServer`; the MCP Events extension is served beside it in `events.ts`.
 *
 * A tool's handler is a closure over the object's live state, so a config change
 * is a rebuild rather than a stale registration.
 */

import { Context, Effect, Layer, Scheduler } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import type { CatalogEntry } from "../tools/catalog";
import { MCP_PATH } from "../config";

export type McpServerService = Context.Service.Shape<typeof McpServer.McpServer>;

const PROTOCOLS = [
	McpProtocol.v2026_07_28,
	McpProtocol.v2025_11_25,
	McpProtocol.v2025_06_18,
	McpProtocol.v2025_03_26,
	McpProtocol.v2024_11_05,
] as const;

export interface Endpoint {
	handler: (request: Request) => Promise<Response>;
	server: McpServerService;
}

export interface EndpointOptions {
	origin: string;
	slug: string;
	tools: readonly CatalogEntry[];
	/** Run one tool by name; a throw becomes a tool error. */
	invoke: (name: string, args: Record<string, unknown>) => Promise<string>;
}

function instructions(slug: string, tools: readonly CatalogEntry[]): string {
	const groups = [...new Set(tools.map((tool) => tool.group))].join(", ");
	return [
		`This is the "${slug}" MCP server on Eryn.`,
		tools.length ? `It exposes ${tools.length} tool(s) from: ${groups}.` : "It exposes no tools yet.",
		"When an event source is available, events/list advertises what can be subscribed to.",
	].join(" ");
}

/**
 * Build the endpoint for one hosted server.
 *
 * A throwaway request forces the layer to be constructed so the registration
 * below can capture the very `McpServer` instance the transport serves from.
 */
export async function createEndpoint(options: EndpointOptions): Promise<Endpoint> {
	let captured: McpServerService | undefined;
	const routes = Layer.merge(
		McpServer.layerHttp({
			name: `eryn-${options.slug}`,
			version: "1.0.0",
			instructions: instructions(options.slug, options.tools),
			path: MCP_PATH,
			allowedOrigins: options.origin ? [options.origin] : [],
			protocols: PROTOCOLS,
		}),
		Layer.effectDiscard(
			Effect.gen(function* () {
				captured = yield* McpServer.McpServer;
			}),
		).pipe(Layer.provide(McpServer.McpServer.layer)),
	).pipe(Layer.provide(HttpServer.layerServices));

	const scheduler = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"));
	const app = HttpRouter.toWebHandler(Layer.provideMerge(routes, scheduler));
	await app.handler(new Request(`https://eryn.internal${MCP_PATH}`, { method: "GET" })).catch(() => undefined);
	const server = captured;
	if (!server) throw new Error("the MCP server could not be captured");

	for (const tool of options.tools) {
		const descriptor = new McpSchema.Tool({
			name: tool.name,
			title: tool.title,
			description: tool.description,
			inputSchema: tool.inputSchema as never,
		});
		await Effect.runPromise(
			server
				.addTool({
					tool: descriptor,
					annotations: Context.empty(),
					handle: (args: unknown) =>
						Effect.tryPromise({
							try: () => options.invoke(tool.name, (args ?? {}) as Record<string, unknown>),
							catch: (error) => (error instanceof Error ? error.message : String(error)),
						}).pipe(
							Effect.map((text) => new McpSchema.CallToolResult({ content: [{ type: "text", text }] })),
							Effect.catch((message) =>
								Effect.succeed(
									new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text: message }] }),
								),
							),
						),
				})
				.pipe(Effect.provideService(McpSchema.McpRequestContext, requestContext())),
		).catch((error) => {
			console.log(`[eryn:gateway:mcp] could not register ${tool.name}: ${String(error)}`);
		});
	}

	return {
		server,
		handler: (request) => {
			// The endpoint always presents itself at the canonical path, whatever the
			// caller's path segment was; the tool set is the one this server built.
			const normalised = new Request(`https://eryn.internal${MCP_PATH}`, request);
			return app.handler(normalised);
		},
	};
}

/** A stand-in request context, needed because `addTool` may await a notification. */
function requestContext(): Context.Service.Shape<typeof McpSchema.McpRequestContext> {
	return McpSchema.McpRequestContext.of({
		clientId: 0,
		protocolVersion: "2025-06-18",
		clientCapabilities: {},
		requestMetadata: {},
	});
}
