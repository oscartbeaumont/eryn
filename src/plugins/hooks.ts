/**
 * Shared plumbing for plugins that contribute to the system prompt.
 *
 * The agent loop builds the messages the model will actually read in two
 * hooks: `context` for a normal request and `compaction` for a request that
 * rewrites the conversation. A prompt block has to be added to both, or a
 * compacted conversation loses the context it was carrying. This is the one
 * place that knows which hooks those are.
 */

import type { Plugin } from "@opencode/plugin";

/** Both hooks that build the messages a request will read. */
const PROMPT_HOOKS = ["context", "compaction"] as const;

/**
 * Append a block to both prompt hooks.
 *
 * `block` may be a fixed string or a function of the session, which is what a
 * plugin needs when the block depends on the conversation's metadata.
 *
 * `marker` makes it idempotent: the same request can pass through a hook more
 * than once, and a repeated block reads as a second, contradictory prompt. A
 * producer that has nothing to add returns `undefined`.
 */
export async function appendToSystemPrompt(
	ctx: Plugin.Context,
	marker: string,
	block: string | ((sessionID: string) => Promise<string | undefined>),
): Promise<void> {
	for (const name of PROMPT_HOOKS) {
		await ctx.session.hook(name, async (event) => {
			if (event.system.some((part) => part.text.includes(marker))) return;
			const text = typeof block === "string" ? block : await block(event.sessionID);
			if (!text) return;
			event.system.push({ type: "text", text });
		});
	}
}
