/**
 * System-prompt guidance for linked MCP servers.
 *
 * Some MCP servers, notably Executor, group app tools by namespace. A plain
 * `search({ query })` can return only the harness's built-in tools and miss the
 * app namespace entirely. An empty result then looks like "the app is not
 * connected", which is how a linked calendar gets reported as missing.
 *
 * The guidance is added to every request for a guild with MCP links. It is
 * deliberately about how to search, not which apps exist: the server remains
 * the source of truth for its namespaces.
 */

import { Plugin } from "@opencode/plugin";

const MARKER = "eryn:mcp-guidance";

export function mcpGuidancePlugin(servers: readonly string[]) {
	const names = servers.filter(Boolean);
	if (names.length === 0) return undefined;
	const guidance = [
		MARKER,
		"Linked MCP servers may group their app tools by namespace.",
		'A query-only search such as `search({ query: "calendar" })` can return only built-in tools and miss the app namespace. An empty query result does not mean the app is not connected.',
		'When a request mentions a service (calendar, mail, GitHub, PostHog, and so on), try `search({ namespace: "<service-id>" })` first, for example `google-calendar`, or use the server\'s own discovery tool before telling the user it is unavailable.',
		`Linked servers: ${names.join(", ")}.`,
	].join("\n");

	return Plugin.define({
		id: "eryn.mcp-guidance",
		async setup(ctx) {
			for (const name of ["context", "compaction"] as const) {
				await ctx.session.hook(name, async (event) => {
					if (event.system.some((part) => part.text.includes(MARKER))) return;
					event.system.push({ type: "text", text: guidance });
				});
			}
		},
	});
}
