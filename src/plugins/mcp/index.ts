/**
 * Add this guild's linked MCP servers to the host.
 *
 * The links are already guild state: their URLs and sealed tokens are read by
 * the session object before a host is built. Keeping them in a plugin rather
 * than the OpenCode config means the user-editable config stays free of
 * credentials and still behaves like a normal filesystem config.
 */

import { Plugin } from "@opencode/plugin";

import { supportsElicitationParam, withElicitation } from "../../mcp/elicitation";
import type { McpLink } from "../../session/models";

export function guildMcpPlugin(links: readonly McpLink[]) {
	if (links.length === 0) return undefined;

	return Plugin.define({
		id: "eryn.mcp",
		async setup(ctx) {
			await ctx.mcp.transform((editor) => {
				for (const link of links) {
					editor.set(link.name, {
						type: "remote",
						url: supportsElicitationParam(link.url)
							? withElicitation(link.url, link.elicitation)
							: link.url,
						oauth: false,
						// Leave codemode unset. OpenCode uses Code Mode for normal
						// MCP servers and keeps Executor/PostHog direct because they
						// already expose their own execute tool.
						...(link.token ? { headers: { Authorization: `Bearer ${link.token}` } } : {}),
					});
				}
			});
		},
	});
}
