/**
 * The agent's baseline system prompt.
 *
 * The editable part lives in the server and channel `AGENTS.md` files. A small
 * fixed section stays here because the messaging contract is mechanical:
 * without it the model writes into output nobody reads.
 */

import { Plugin } from "@opencode/plugin";

import { appendToSystemPrompt } from "../hooks.ts";

const MARKER = "eryn:instructions";

const CORE = [
	"You are Eryn, a personal agent.",
	"Your own output is not posted to any messaging surface. To answer, call `send_message`; omit its `channel` to reply where the current message arrived.",
	"The filesystem is virtual: use the provided read, write, edit, list, and bash tools.",
].join("\n");

export function agentInstructionsPlugin(
	read: () => string | undefined,
	readChannel?: (sessionID: string) => Promise<string | undefined>,
) {
	return Plugin.define({
		id: "eryn.instructions",
		async setup(ctx) {
			await appendToSystemPrompt(ctx, MARKER, async (sessionID) => {
				const editable = read()?.trim();
				const channel = readChannel ? (await readChannel(sessionID))?.trim() : undefined;

				return [MARKER, CORE, editable, channel].filter(Boolean).join("\n\n");
			});
		},
	});
}
