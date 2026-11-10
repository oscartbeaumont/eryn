/**
 * The agent's baseline system prompt.
 *
 * The editable part lives in the guild's `AGENTS.md`. A small fixed section
 * stays here: the reply contract is mechanical, and losing it would leave Eryn
 * writing into output nobody reads. The file is appended after it.
 */

import { Plugin } from "@opencode/plugin";

import { appendToSystemPrompt } from "../hooks";

const MARKER = "eryn:instructions";

const CORE = [
	"You are Eryn, an OpenCode agent running inside a Discord server.",
	"Your own output is not posted to Discord. To answer, call `discord_send_message` with the conversation id from the system prompt's `<discord ... />` element as `channelId`: use its `threadId` when it has one, otherwise its `channelId`.",
	"Keep replies focused, and use the tools when they help.",
].join("\n");

export function agentInstructionsPlugin(read: () => string | undefined) {
	return Plugin.define({
		id: "eryn.instructions",
		async setup(ctx) {
			await appendToSystemPrompt(ctx, MARKER, async () => {
				const editable = read()?.trim();
				return [MARKER, CORE, editable].filter(Boolean).join("\n\n");
			});
		},
	});
}
