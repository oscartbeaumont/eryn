/**
 * The session identity block.
 *
 * The agent reads hostname, model, and session id from here when it writes the
 * attribution footer. OpenCode does not otherwise put them in the prompt.
 */

import { Plugin } from "@opencode/plugin";

const MARKER = "eryn:session";

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

export function sessionPlugin(hostname: string) {
	return Plugin.define({
		id: "eryn.session",
		async setup(ctx) {
			for (const name of ["context", "compaction"] as const) {
				await ctx.session.hook(name, async (event) => {
					if (event.system.some((part) => part.text.includes(MARKER))) return;
					const model = event.model.providerID + "/" + event.model.id;

					event.system.push({
						type: "text",
						text:
							"<!-- " +
							MARKER +
							' -->\n<session id="' +
							escapeXml(event.sessionID) +
							'" hostname="' +
							escapeXml(hostname) +
							'" model="' +
							escapeXml(model) +
							'"/>',
					});
				});
			}
		},
	});
}
