/**
 * The setup menu: what `/eryn setup` shows, and the buttons that lead from it
 * into the provider, model, and MCP screens.
 */

import { actionButton, buttonRow, type DiscordButton } from "../../discord/components";
import { SETUP_MENU_ID, scopedId } from "../ids";
import { guarded, responder, type InteractionRequest } from "./interaction";
import { mcpScreen } from "./mcp";
import { modelScreen } from "./models";
import { REMOVE_PROVIDER_ID, providerScreen } from "./providers";

const PROVIDER_ID = `${SETUP_MENU_ID}:provider`;
const MODEL_ID = `${SETUP_MENU_ID}:model`;
const MCP_ID = `${SETUP_MENU_ID}:mcp`;

export async function setupMenu(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const id = (base: string) => scopedId(base, request.dmGuildId);
	const status = await request.session.config().catch(() => undefined);
	const providers = status?.providers.map((provider) => provider.integrationID).join(", ") || "none";
	const links = status?.links.length ?? 0;
	const lines = status?.ready
		? [
				"**Eryn is ready here.**",
				`Model: \`${status.model}\``,
				`Providers: ${providers}`,
				`MCP servers: ${links ? `${links} linked` : "none"}`,
			]
		: [
				"**Eryn is not set up here yet.**",
				"Connect an inference provider to get started.",
				...(links ? [`MCP servers: ${links} linked`] : []),
			];
	const buttons: DiscordButton[] = [
		actionButton(
			status?.ready ? "Change provider" : "Connect provider",
			id(PROVIDER_ID),
			status?.ready ? 2 : 1,
		),
	];
	if (status?.ready) {
		buttons.push(actionButton("Choose model", id(MODEL_ID), 2));
		if (!request.dmGuildId) buttons.push(actionButton("Remove provider", REMOVE_PROVIDER_ID, 4));
	}
	if (!request.dmGuildId) buttons.push(actionButton("MCP servers", id(MCP_ID), 2));
	await answer.reply(lines.join("\n"), [buttonRow(buttons)]);
}

/** Each menu button routes to the screen that owns it. */
export async function setupComponent(request: InteractionRequest, customId: string): Promise<boolean> {
	switch (customId) {
		case SETUP_MENU_ID:
			await guarded(request, "update", () => setupMenu(request));
			return true;
		case PROVIDER_ID:
			await guarded(request, "update", () => providerScreen(request));
			return true;
		case MODEL_ID:
			await guarded(request, "update", () => modelScreen(request));
			return true;
		case MCP_ID:
			await guarded(request, "update", () => openMcp(request));
			return true;
	}
	return false;
}

/** Links belong to the server, so a DM hands the admin off to the guild. */
async function openMcp(request: InteractionRequest): Promise<void> {
	if (request.dmGuildId) {
		await responder(request).update("Manage MCP servers from the server with `/eryn setup`.");
		return;
	}
	await mcpScreen(request);
}

export function helpText(): string {
	return [
		"**Eryn setup**",
		"• `/eryn setup` — providers, models, MCP servers, and current status",
		"• `/eryn stop` — stop the run in this thread",
	].join("\n");
}
