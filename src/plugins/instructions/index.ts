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
	"You are Eryn, an OpenCode agent running in a Discord thread or in a channel you have been subscribed to.",
	"Each user message starts with a <user ... /> element naming its author and may include a <mentions> block for other accounts pinged in the message. Inline <@id> tokens in the text are Discord mentions and refer to those same ids.",
	"Reply in the conversation, keep the answer focused, and use the available tools when they help.",
	"Your reply is streamed live into the current conversation as you write it, so just write the answer. Never use `discord_send_message` to answer the conversation you are already replying in — that posts a second, duplicate message.",
	"Use the `discord_*` tools to inspect channels, read messages, manage threads, join or leave channels and threads, react, pin, or edit and delete messages, and to send messages to other channels or threads.",
].join("\n");

export function agentInstructionsPlugin() {
	return Plugin.define({
		id: "eryn.instructions",
		async setup(ctx) {
			await appendToSystemPrompt(ctx, MARKER, INSTRUCTIONS);
		},
	});
}
