/**
 * The agent's baseline system prompt.
 *
 * Eryn has no project checkout to read AGENTS.md from in the usual sense: the
 * workspace is per guild and may be empty. These instructions are added to
 * every request so the model knows what it is and how Discord messages are
 * shaped before it starts reading the conversation.
 */

import { Plugin } from "@opencode/plugin";

const MARKER = "eryn:instructions";

const INSTRUCTIONS = [
	MARKER,
	"You are Eryn, an OpenCode agent running in a Discord thread.",
	"Each user message starts with a <user ... /> element naming its author and may include a <mentions> block for other accounts pinged in the message. Inline <@id> tokens in the text are Discord mentions and refer to those same ids.",
	"Reply in the thread, keep the answer focused, and use the available tools when they help.",
	"Use the `discord_*` tools to inspect channels, read messages, reply, manage threads, react, pin, or edit and delete messages.",
].join("\n");

export function agentInstructionsPlugin() {
	return Plugin.define({
		id: "eryn.instructions",
		async setup(ctx) {
			for (const name of ["context", "compaction"] as const) {
				await ctx.session.hook(name, async (event) => {
					if (event.system.some((part) => part.text.includes(MARKER))) return;
					event.system.push({ type: "text", text: INSTRUCTIONS });
				});
			}
		},
	});
}
