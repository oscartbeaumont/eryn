/**
 * The tool catalogue the gateway can expose.
 *
 * One flat list, assembled from the three groups, each entry carrying the group
 * it belongs to and whether calling it mutates anything. The access level is
 * derived here rather than inside the individual tool modules so the console can
 * present a group's read/write split without asking any of them.
 */

import type { ServerSummary } from "../model";
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

export function accessOf(name: string): "read" | "write" {
	return WRITE_TOOLS.has(name) ? "write" : "read";
}

function entry(
	tool: { name: string; title: string; description: string; inputSchema: CatalogEntry["inputSchema"] },
	group: CatalogEntry["group"],
): CatalogEntry {
	return {
		name: tool.name,
		title: tool.title,
		description: tool.description,
		inputSchema: tool.inputSchema,
		group,
		access: accessOf(tool.name),
	};
}

/** Every tool the deployment knows about, in group order. */
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
 * The tool names a configuration allows.
 *
 * `groups` is the coarse control and `tools` narrows it: an `include` list can
 * only remove tools the groups already offered, and `exclude` always removes.
 * That ordering is what makes the two safe to combine — a per-tool rule can
 * never widen access past what the group granted.
 */
export function visibleToolNames(access: ServerSummary["tools"], entries: readonly CatalogEntry[] = catalog()): string[] {
	const include = access.tools?.include;
	const exclude = new Set(access.tools?.exclude ?? []);
	const allowed = new Set<string>();
	for (const tool of entries) {
		const level = access.groups[tool.group] ?? "none";
		if (level === "none") continue;
		if (level === "read" && tool.access !== "read") continue;
		if (level === "write" && tool.access !== "write") continue;
		allowed.add(tool.name);
	}
	if (include && include.length) {
		const keep = new Set(include);
		for (const name of [...allowed]) if (!keep.has(name)) allowed.delete(name);
	}
	for (const name of exclude) allowed.delete(name);
	return [...allowed];
}
