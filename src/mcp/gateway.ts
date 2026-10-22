/**
 * The MCP gateway: one Durable Object per Discord user.
 *
 * It is the endpoint a harness points at, and it fronts the remote MCP servers
 * that user has connected, so a local config can drop its own copies. It has to
 * be per user rather than one shared endpoint because Effect's `McpServer` keeps
 * a single tool registry per isolate: a shared one would answer `tools/list`
 * with every user's tool names and schemas.
 *
 * Two facts about that registry shape this file:
 *
 * - `addTool` replaces by name, so re-registering a tool is how its behaviour is
 *   changed.
 * - A tool's visibility comes from an `EnabledWhen` annotation, so enabling and
 *   disabling a server is a predicate that reads live state — no re-registration,
 *   and therefore no dropped sessions, when the dashboard toggles one.
 *
 * There is no way to remove a tool, so one that is no longer wanted is registered
 * as permanently invisible instead.
 */

import { DurableObject } from "cloudflare:workers";
import { Context, Effect, Layer, Scheduler } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import { describeError } from "../discord/api";
import { callTool, listTools, type McpTool, type McpToolResult } from "./client";
import { MCP_PATH, allowedOrigins, INSTRUCTIONS, randomNumber, runRandomNumber } from "./server";
import { ensureToken, namespaced, readMcpServers, type McpServerRecord } from "./servers";

/** How long a user's server list is trusted before it is read again. */
const CONFIG_TTL_MS = 5_000;
/** How long one server's tool catalogue is trusted. */
const TOOLS_TTL_MS = 60_000;
/**
 * How long one server gets to answer a listing.
 *
 * A cold object builds its catalogue before it can answer anything, so a server
 * that hangs must not hold a harness's first request open; it contributes
 * nothing this time and is tried again once the cache expires.
 */
const LISTING_BUDGET_MS = 5_000;

type McpServerService = Context.Service.Shape<typeof McpServer.McpServer>;

function log(message: string): void {
	console.log(`[eryn:mcp] ${message}`);
}

/** One upstream tool this object is currently fronting. */
interface Owned {
	serverId: string;
	/** The tool's name on the server it came from. */
	toolName: string;
}

/**
 * A tool call's result, reduced to what survives a round trip.
 *
 * Content is flattened to text: a gateway cannot know that a harness will accept
 * every content part a server sends, and a rejected part would fail the whole
 * call rather than one part of it.
 */
function toResult(result: McpToolResult): McpSchema.CallToolResult {
	const parts = Array.isArray(result.content) ? result.content : [];
	const text = parts
		.map((part) => {
			const entry = part as { type?: unknown; text?: unknown };
			if (entry?.type === "text" && typeof entry.text === "string") return entry.text;
			return JSON.stringify(part);
		})
		.join("\n");
	const structured =
		result.structuredContent && typeof result.structuredContent === "object" && !Array.isArray(result.structuredContent)
			? (result.structuredContent as Record<string, unknown>)
			: undefined;
	return new McpSchema.CallToolResult({
		content: [{ type: "text", text: text || "(no output)" }],
		...(structured ? { structuredContent: structured } : {}),
		...(result.isError ? { isError: true } : {}),
	});
}

/** A failure rendered the way a tool result carries one. */
function toFailure(message: string): McpSchema.CallToolResult {
	return new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text: message }] });
}

/** The hint fields a harness reads, kept only when the server sent them. */
function hints(annotations: unknown): Record<string, boolean> {
	if (!annotations || typeof annotations !== "object") return {};
	const source = annotations as Record<string, unknown>;
	const kept: Record<string, boolean> = {};
	for (const key of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
		if (typeof source[key] === "boolean") kept[key] = source[key];
	}
	return kept;
}

export class ErynMcp extends DurableObject<Env> {
	/** The user this object fronts, taken from the name the Worker routed with. */
	private readonly userId: string;
	private app: { handler: (request: Request) => Promise<Response> } | undefined;
	private server: McpServerService | undefined;

	/** The servers this user has connected, cached briefly. */
	private config: McpServerRecord[] = [];
	private configAt = 0;
	/** One server's tool catalogue, cached so a busy harness does not hammer it. */
	private readonly catalogues = new Map<string, { at: number; tools: McpTool[] }>();
	/** The tools being fronted, by the name they are exposed under. */
	private readonly owned = new Map<string, Owned>();
	/** The descriptors registered so far, so one can be hidden later. */
	private readonly descriptors = new Map<string, McpSchema.Tool>();
	/** The servers that are switched on right now; a tool's visibility reads this. */
	private live = new Set<string>();
	/** What the registry last looked like, so a change is what sends a notification. */
	private signature = "";
	private syncing: Promise<void> | undefined;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.userId = state.id.name ?? "";
	}

	async fetch(request: Request): Promise<Response> {
		const { pathname } = new URL(request.url);
		// The Worker pokes this after the dashboard changes something, so a harness
		// holding a stream open hears about it before its next request.
		if (pathname === "/mcp/refresh") {
			await this.ready();
			await this.sync();
			return Response.json({ ok: true, tools: this.owned.size });
		}

		await this.ready();
		await this.sync();
		return this.app!.handler(request);
	}

	/**
	 * Build the MCP server once, and keep a handle on it.
	 *
	 * `toWebHandler` owns the layer's lifetime, and builds it on first use, so a
	 * throwaway request forces construction and the registration below captures
	 * the very instance the transport will serve from.
	 */
	private async ready(): Promise<void> {
		if (this.app) return;
		let captured: McpServerService | undefined;
		const routes = Layer.merge(
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
			// `layerHttp` builds the same `McpServer.layer`; Effect memoises it by
			// identity, so this captures the very instance the transport serves from.
			Layer.effectDiscard(
				Effect.gen(function* () {
					captured = yield* McpServer.McpServer;
				}),
			).pipe(Layer.provide(McpServer.McpServer.layer)),
		).pipe(Layer.provide(HttpServer.layerServices));

		const scheduler = Layer.succeed(Scheduler.Scheduler, new Scheduler.MixedScheduler("sync"));
		this.app = HttpRouter.toWebHandler(Layer.provideMerge(routes, scheduler));
		await this.app.handler(new Request("https://eryn.internal/ready", { method: "GET" })).catch(() => undefined);
		this.server = captured;
		if (!this.server) {
			log("the MCP server could not be captured; tools will not be registered");
			return;
		}
		// The endpoint's own tools are always present, whatever the user connects.
		await this.add(randomNumber, () => true);
	}

	/** The user's servers, re-read only when the cached copy has gone stale. */
	private async servers(): Promise<McpServerRecord[]> {
		if (Date.now() - this.configAt < CONFIG_TTL_MS) return this.config;
		this.config = await readMcpServers(this.env, this.userId).catch(() => [] as McpServerRecord[]);
		this.configAt = Date.now();
		return this.config;
	}

	/** One server's catalogue, cached so a harness listing tools is not a fan-out. */
	private async toolsFor(server: McpServerRecord): Promise<McpTool[]> {
		const cached = this.catalogues.get(server.id);
		if (cached && Date.now() - cached.at < TOOLS_TTL_MS) return cached.tools;
		let tools: McpTool[] = [];
		try {
			const { token } = await ensureToken(server);
			tools = await Promise.race([
				listTools({ url: server.url, token }),
				new Promise<McpTool[]>((resolve) => setTimeout(() => resolve([]), LISTING_BUDGET_MS)),
			]);
		} catch (error) {
			// A server that cannot be read contributes no tools rather than failing
			// the whole listing, so one broken server cannot take the gateway down.
			log(`could not read ${server.name}: ${describeError(error)}`);
		}
		this.catalogues.set(server.id, { at: Date.now(), tools });
		return tools;
	}

	/**
	 * Make the registered tools match the user's configuration.
	 *
	 * Serialised, because two requests arriving together must not register the
	 * same tools twice over.
	 */
	private sync(): Promise<void> {
		this.syncing ??= this.runSync().finally(() => {
			this.syncing = undefined;
		});
		return this.syncing;
	}

	private async runSync(): Promise<void> {
		const servers = await this.servers();
		const enabled = servers.filter((server) => server.enabled);
		// Written before anything is registered, because every visibility predicate
		// reads it: switching a server off is what makes its tools disappear.
		this.live = new Set(enabled.map((server) => server.id));

		// Asked for together, because the first request after a cold start waits for
		// all of them and a sequential fan-out would add up.
		const catalogues = await Promise.all(enabled.map(async (server) => [server, await this.toolsFor(server)] as const));
		const wanted = new Map<string, { server: McpServerRecord; tool: McpTool }>();
		for (const [server, catalogued] of catalogues) {
			for (const tool of catalogued) wanted.set(namespaced(server, tool.name), { server, tool });
		}

		for (const [exposed, entry] of wanted) {
			await this.register(exposed, entry.server, entry.tool);
		}
		// The registry cannot remove a tool, so one that is no longer wanted is
		// registered as permanently invisible instead of lingering as callable.
		for (const exposed of [...this.owned.keys()]) {
			if (!wanted.has(exposed)) await this.hide(exposed);
		}

		const signature = `${[...wanted.keys()].sort().join(",")}|${[...this.live].sort().join(",")}`;
		if (signature !== this.signature) {
			this.signature = signature;
			await this.notify();
		}
	}

	private async register(exposed: string, server: McpServerRecord, tool: McpTool): Promise<void> {
		// A server cannot shadow a tool the endpoint publishes itself.
		if (exposed === randomNumber.name) return;
		const descriptor = this.describe(exposed, tool);
		if (!descriptor) return;
		this.descriptors.set(exposed, descriptor);
		this.owned.set(exposed, { serverId: server.id, toolName: tool.name });
		await this.add(descriptor, () => this.live.has(server.id) && this.owned.get(exposed)?.serverId === server.id);
	}

	private async hide(exposed: string): Promise<void> {
		const descriptor = this.descriptors.get(exposed);
		this.owned.delete(exposed);
		if (descriptor) await this.add(descriptor, () => false);
	}

	/** Build the descriptor a harness sees, dropping anything it would reject. */
	private describe(exposed: string, tool: McpTool): McpSchema.Tool | undefined {
		try {
			const annotations = hints(tool.annotations);
			return new McpSchema.Tool({
				name: exposed,
				title: tool.title ?? exposed,
				...(tool.description ? { description: tool.description } : {}),
				inputSchema: tool.inputSchema as never,
				...(Object.keys(annotations).length ? { annotations } : {}),
			});
		} catch (error) {
			// One server's malformed schema must not cost the others their tools.
			log(`skipping ${exposed}: ${describeError(error)}`);
			return undefined;
		}
	}

	/** Register (or replace) one tool on the live server. */
	private async add(tool: McpSchema.Tool, visible: () => boolean): Promise<void> {
		if (!this.server) return;
		const server = this.server;
		await Effect.runPromise(
			server
				.addTool({
					tool,
					annotations: Context.make(McpSchema.EnabledWhen, () => visible()),
					handle: (args: unknown) => Effect.promise(() => this.invoke(tool.name, args)),
				})
				.pipe(Effect.provideService(McpSchema.McpRequestContext, requestContext())),
		).catch((error) => log(`could not register ${tool.name}: ${describeError(error)}`));
	}

	/** Tell every connected harness that the catalogue changed. */
	private async notify(): Promise<void> {
		if (!this.server) return;
		await Effect.runPromise(this.server.notifications["notifications/tools/list_changed"]({})).catch((error) =>
			log(`could not send a list-changed notification: ${describeError(error)}`),
		);
	}

	/**
	 * Call the upstream tool this name belongs to.
	 *
	 * The owner is looked up per call rather than closed over, so a tool that has
	 * been disabled or replaced cannot be reached through a stale registration.
	 */
	private async invoke(exposed: string, args: unknown): Promise<McpSchema.CallToolResult> {
		if (exposed === randomNumber.name) return runRandomNumber(args);
		const owner = this.owned.get(exposed);
		if (!owner) return toFailure(`\`${exposed}\` is no longer available.`);
		const server = (await this.servers()).find((entry) => entry.id === owner.serverId);
		if (!server?.enabled) return toFailure(`\`${exposed}\` is no longer available.`);
		try {
			const { token } = await ensureToken(server);
			return toResult(await callTool({ url: server.url, token }, owner.toolName, args));
		} catch (error) {
			return toFailure(`${server.name} could not run that: ${describeError(error)}`);
		}
	}
}

/**
 * A stand-in for the request a tool is registered during.
 *
 * `addTool` wants one because it may await delivery of the notification it
 * sends, and there is no request in flight when the dashboard changes something.
 */
function requestContext(): Context.Service.Shape<typeof McpSchema.McpRequestContext> {
	return McpSchema.McpRequestContext.of({
		clientId: 0,
		protocolVersion: "2025-06-18",
		clientCapabilities: {},
		requestMetadata: {},
	});
}
