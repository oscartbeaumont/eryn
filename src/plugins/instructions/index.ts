/**
 * The agent's baseline system prompt.
 *
 * Eryn has no project checkout to read AGENTS.md from in the usual sense: the
 * workspace is per guild and may be empty. These instructions are added to
 * every request so the model knows what it is and how Discord messages are
 * shaped before it starts reading the conversation.
 */

import { Plugin } from "@opencode/plugin";

import { appendToSystemPrompt } from "../hooks";

const MARKER = "eryn:instructions";

const INSTRUCTIONS = [
	MARKER,
	"You are Eryn, an OpenCode agent running in a Discord conversation; the conversation is a thread or a channel you have been subscribed to.",
	"Each user message begins with a <channel ... /> element and, when it came from a thread, a <thread ... /> element. It also names its author with a <user ... /> element and may include a <mentions> block. Inline <@id> tokens in the text are Discord mentions and refer to those same ids.",
	"Never write your reply in your output. Your output is not posted to Discord. To answer, call `discord_send_message` with the thread id when a <thread> element is present, otherwise the channel id, as `channelId`.",
	"Keep replies focused, and use the available tools when they help.",
	"Use the `discord_*` tools to inspect channels, read messages, manage threads, join or leave channels and threads, react, pin, or edit and delete messages, and to send messages.",
].join("\n");

export function agentInstructionsPlugin() {
	return Plugin.define({
		id: "eryn.instructions",
		async setup(ctx) {
			await appendToSystemPrompt(ctx, MARKER, INSTRUCTIONS);
		},
	});
}
