/**
 * The tool catalogue the gateway can expose.
 *
 * One flat list, assembled from the three built-in groups plus whatever tools a
 * hosted server's upstream MCP servers advertised. Each entry carries the group
 * it belongs to and whether calling it mutates anything. The access level is
 * derived here rather than inside the individual tool modules so the console can
 * present a group's read/write split without asking any of them.
 */

import type { McpServer, ServerSummary, UpstreamConnection } from "../model";
import type { CatalogTool } from "../model";
import { DISCORD_TOOLS } from "./discord";
import { GITHUB_TOOLS } from "./github";
import { GOOGLE_TOOLS } from "./google";

export interface CatalogEntry extends CatalogTool {
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties: false;
	};
}

/**
 * The tools that change something. Everything else reads.
 *
 * Listing them explicitly, rather than guessing from a name, keeps the
 * classification honest as tools are added: a new tool is read-only until it is
 * named here, which is the safe default.
 */
const WRITE_TOOLS = new Set([
	// Discord
	"discord_post",
	"discord_create_thread",
	// GitHub
	"github_create_issue",
	"github_update_issue",
	"github_comment",
	"github_create_pull",
	"github_review",
	// Google Calendar
	"google_create_event",
	"google_update_event",
	"google_delete_event",
]);

/** The groups the built-in tools belong to; an upstream may not use these names. */
export const BUILTIN_GROUPS = ["discord", "github", "google_calendar"] as const;

export function accessOf(name: string): "read" | "write" {
	return WRITE_TOOLS.has(name) ? "write" : "read";
}

function entry(
	tool: { name: string; title: string; description: string; inputSchema: CatalogEntry["inputSchema"] },
	group: CatalogEntry["group"],
	access?: "read" | "write",
): CatalogEntry {
	return {
		name: tool.name,
		title: tool.title,
		description: tool.description,
		inputSchema: tool.inputSchema,
		group,
		access: access ?? accessOf(tool.name),
	};
}

/** Every built-in tool the deployment knows about, in group order. */
export function catalog(): CatalogEntry[] {
	return [
		...DISCORD_TOOLS.map((tool) => entry(tool, "discord")),
		...GITHUB_TOOLS.map((tool) => entry(tool, "github")),
		...GOOGLE_TOOLS.map((tool) => entry(tool, "google_calendar")),
	];
}

/** The catalog as the console's tool picker wants it, without the schemas. */
export function catalogForConsole(): CatalogTool[] {
	return catalog().map(({ name, title, description, group, access }) => ({ name, title, description, group, access }));
}

export function groupOf(name: string): CatalogEntry["group"] | undefined {
	return catalog().find((tool) => tool.name === name)?.group;
}

/**
 * The name a hosted server exposes an upstream tool under.
 *
 * MCP tool names may only carry letters, digits, `_` and `-`, and two servers
 * may well both offer `search`, so every upstream tool is prefixed with its
 * connection's slug.
 */
export function exposedToolName(connection: string, tool: string): string {
	const combined = `${connection}_${tool}`.replace(/[^A-Za-z0-9_-]+/g, "_");
	return combined.length > 100 ? combined.slice(0, 100) : combined;
}

/** The entries one hosted server's upstream connections contribute. */
export function upstreamEntries(server: { connections?: readonly UpstreamConnection[] }): CatalogEntry[] {
	const entries: CatalogEntry[] = [];
	const taken = new Set(catalog().map((tool) => tool.name));
	for (const connection of server.connections ?? []) {
		if (!connection.enabled) continue;
		for (const tool of connection.tools) {
			const name = exposedToolName(connection.name, tool.name);
			// A later connection can only collide with one read earlier, so the
			// first one keeps the name and the rest are left out rather than
			// silently shadowing a tool that already works.
			if (taken.has(name)) continue;
			taken.add(name);
			entries.push({
				name,
				title: tool.title ?? tool.name,
				description: tool.description ?? `The ${tool.name} tool on ${connection.title ?? connection.name}.`,
				inputSchema: (tool.inputSchema as CatalogEntry["inputSchema"] | undefined) ?? {
					type: "object",
					properties: {},
					additionalProperties: false,
				},
				group: connection.name,
				access: tool.access,
			});
		}
	}
	return entries;
}

/** Every entry a hosted server can offer: the built-ins, then its upstreams. */
export function entriesFor(server: Pick<McpServer, "connections">): CatalogEntry[] {
	return [...catalog(), ...upstreamEntries(server)];
}

/**
 * The tool names a configuration allows.
 *
 * `groups` is the coarse control, a per-tool `access` override decides what a
 * tool counts as, and `tools` narrows the result: an `include` list can only
 * remove tools the groups already offered, and `exclude` always removes. That
 * ordering is what makes the three safe to combine — a per-tool rule can never
 * widen access past what the group granted.
 */
export function visibleToolNames(access: ServerSummary["tools"], entries: readonly CatalogEntry[] = catalog()): string[] {
	const include = access.tools?.include;
	const exclude = new Set(access.tools?.exclude ?? []);
	const overrides = access.tools?.access ?? {};
	const allowed = new Set<string>();
	for (const tool of entries) {
		const level = access.groups[tool.group] ?? "none";
		if (level === "none") continue;
		const kind = overrides[tool.name] ?? tool.access;
		if (level === "read" && kind !== "read") continue;
		if (level === "write" && kind !== "write") continue;
		allowed.add(tool.name);
	}
	if (include && include.length) {
		const keep = new Set(include);
		for (const name of [...allowed]) if (!keep.has(name)) allowed.delete(name);
	}
	for (const name of exclude) allowed.delete(name);
	return [...allowed];
}

/**
 * Recover the access a link was granted with from the tool names it stored.
 *
 * Grants written before links carried a whole `ToolAccess` only have the names
 * the link exposed. Those names say what every group's level was — a group with
 * all of its reads and none of its writes was granted `read` — so the level can
 * be recovered and the link keeps following its server as tools are added.
 */
export function inferAccess(names: readonly string[], entries: readonly CatalogEntry[] = catalog()): ServerSummary["tools"] {
	const kept = new Set(names);
	const groups: Record<string, "none" | "read" | "write" | "all"> = {};
	for (const group of new Set(entries.map((tool) => tool.group))) {
		const inGroup = entries.filter((tool) => tool.group === group);
		const included = inGroup.filter((tool) => kept.has(tool.name));
		if (!included.length) continue;
		const reads = included.some((tool) => tool.access === "read");
		const writes = included.some((tool) => tool.access === "write");
		groups[group] = reads && writes ? "all" : reads ? "read" : "write";
	}
	return { groups };
}
