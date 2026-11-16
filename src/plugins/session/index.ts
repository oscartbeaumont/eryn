/**
 * The session identity block, mirroring the local OpenCode session plugin.
 *
 * The agent reads `hostname` from here when it writes the attribution footer
 * that `AGENTS.md` asks for, and `model` gives it the provider and model it is
 * actually running. OpenCode does not otherwise put either value in the prompt.
 */

import { Plugin } from "@opencode/plugin";

import { escapeXml } from "../../discord/xml";

const MARKER = "eryn:session";

export function sessionPlugin(hostname: string) {
	return Plugin.define({
		id: "eryn.session",
		async setup(ctx) {
			for (const name of ["context", "compaction"] as const) {
				await ctx.session.hook(name, async (event) => {
					if (event.system.some((part) => part.text.includes(MARKER))) return;
					const model = `${event.model.providerID}/${event.model.id}`;
					event.system.push({
						type: "text",
						text: `<!-- ${MARKER} -->\n<session id="${escapeXml(event.sessionID)}" hostname="${escapeXml(hostname)}" model="${escapeXml(model)}"/>`,
					});
				});
			}
		},
	});
}
