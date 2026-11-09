/**
 * The setup menu: what `/eryn setup` shows, and the buttons that lead from it
 * into the provider, model, and MCP screens.
 *
 * Every screen is ephemeral and replaces the previous one, so the flow reads as
 * one message the admin edits in place; a modal step adds a short form and
 * leaves the screen that opened it behind. Clicking the public install greeting
 * opens a fresh ephemeral menu rather than editing that message.
 */

import { actionButton, buttonRow, type DiscordButton } from "../../discord/components";
import { SETUP_CLOSE_ID, SETUP_MENU_ID } from "../ids";
import { MCP_SCREEN_ID, mcpScreen } from "./mcp";
import { claim, responder, closeRow, type InteractionRequest } from "./interaction";
import { MODEL_SCREEN_ID } from "./models";
import { PROVIDER_SCREEN_ID } from "./providers";

export async function setupMenu(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	// Every screen is ephemeral, but a component can sit on a public message: the
	// install greeting's Start setup button. Editing that message would show the
	// configuration to the whole channel, so a public source opens a fresh
	// ephemeral message instead.
	const publicSource =
		request.interaction.type === 3 &&
		request.interaction.guild_id !== undefined &&
		((request.interaction.message?.flags ?? 0) & 64) === 0;
	if (publicSource) await answer.deferNew();
	else await answer.defer();

	const status = await request.session.config().catch(() => undefined);
	if (!status) {
		await answer.reply("Eryn could not read this server's setup right now. Try again in a moment.", [
			buttonRow([
				actionButton("Try again", request.id(SETUP_MENU_ID), 1),
				actionButton("Close", request.id(SETUP_CLOSE_ID), 2),
			]),
		]);
		return;
	}
	// The greeting exists to lead an admin into this menu, so once the server is
	// configured it has done its job.
	if (status.ready) await request.ctx.dismissGreeting(request.guildId).catch(() => undefined);
	const providers = status.providers.map((provider) => provider.integrationID).join(", ") || "none";
	const links = status.links.length;
	const lines = status.ready
		? [
				"**Eryn is ready here.**",
				`Provider: **${providers}**`,
				`Model: \`${status.model}\``,
				`MCP servers: ${links ? `${links} linked` : "none"}`,
			]
		: [
				"**Eryn is not set up here yet.**",
				"Connect an inference provider to get started.",
				...(links ? [`MCP servers: ${links} linked`] : []),
			];
	const buttons: DiscordButton[] = [
		actionButton(
			status.ready ? "Change provider" : "Connect provider",
			request.id(PROVIDER_SCREEN_ID),
			status.ready ? 2 : 1,
		),
	];
	if (status.ready) buttons.push(actionButton("Choose model", request.id(MODEL_SCREEN_ID), 2));
	if (!request.dmGuildId) buttons.push(actionButton("MCP servers", request.id(MCP_SCREEN_ID), 2));
	buttons.push(actionButton("Close", request.id(SETUP_CLOSE_ID), 2));
	await answer.reply(lines.join("\n"), [buttonRow(buttons)]);
}

/** Each menu button routes to the screen that owns it. */
export async function setupComponent(request: InteractionRequest, customId: string): Promise<boolean> {
	switch (customId) {
		case SETUP_MENU_ID:
			return await claim(request, "update", () => setupMenu(request));
		case MCP_SCREEN_ID:
			return await claim(request, "update", () => openMcp(request));
		case SETUP_CLOSE_ID:
			// Closing is best effort: if Discord has already dropped the menu there
			// is nothing left to delete.
			await responder(request).close().catch(() => undefined);
			return true;
	}
	return false;
}

/** Links belong to the server, so an install DM from an older build hands the admin off to the guild. */
async function openMcp(request: InteractionRequest): Promise<void> {
	if (request.dmGuildId) {
		await responder(request).update("Manage MCP servers from the server with `/eryn setup`.", [
			closeRow(request),
		]);
		return;
	}
	await mcpScreen(request);
}

export function helpText(): string {
	return [
		"**Eryn commands**",
		"• `/eryn setup` — providers, models, MCP servers, and current status (needs Manage Server)",
		"• `/eryn stop` — stop the run in this thread",
		"• `/eryn help` — show this",
	].join("\n");
}
