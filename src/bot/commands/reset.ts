/**
 * `/eryn reset`: wipe the guild's files and restore the seeded defaults.
 *
 * A reset is destructive and guild-wide, so it takes an explicit confirmation.
 * Providers, the chosen model, MCP links, conversation history, and policies
 * are not files, so they survive; only the virtual filesystem is replaced.
 */

import { actionButton, buttonRow } from "../../discord/components";
import { describeError } from "../../errors";
import { SETUP_CLOSE_ID } from "../ids";
import { claim, responder, type InteractionRequest } from "./interaction";

const RESET_CONFIRM_ID = "reset:confirm";

export async function resetScreen(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	await answer.reply(
		[
			"**Reset Eryn's files?**",
			"This deletes every file in this server's filesystem — `/eryn` (config, skills, commands, agents) and `/workspace` (project files) — then restores the seeded defaults.",
			"Providers, the model, MCP links, conversation history, and policies are kept.",
		].join("\n"),
		[
			buttonRow([
				actionButton("Reset files", RESET_CONFIRM_ID, 4),
				actionButton("Cancel", request.id(SETUP_CLOSE_ID), 2),
			]),
		],
	);
}

export async function resetComponent(request: InteractionRequest, customId: string): Promise<boolean> {
	if (customId !== RESET_CONFIRM_ID) return false;
	return await claim(request, "update", () => resetFiles(request));
}

async function resetFiles(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	try {
		const { files } = await request.session.reset();
		await answer.update(
			`Reset Eryn's files: removed ${files} file${files === 1 ? "" : "s"} and restored the defaults.`,
		);
	} catch (error) {
		await answer.update(`Could not reset Eryn's files: ${describeError(error)}`, [
			buttonRow([
				actionButton("Try again", RESET_CONFIRM_ID, 4),
				actionButton("Close", request.id(SETUP_CLOSE_ID), 2),
			]),
		]);
	}
}
