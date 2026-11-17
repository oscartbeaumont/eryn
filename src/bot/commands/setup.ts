/**
 * The setup menu: what `/eryn setup` shows, and the buttons that lead from it
 * into the provider, model, and MCP screens.
 *
 * Every screen is ephemeral and replaces the previous one, so the flow reads as
 * one message the admin edits in place; a modal step adds a short form and
 * leaves the screen that opened it behind. Clicking the public install greeting
 * opens a fresh ephemeral menu rather than editing that message.
 */

import {
	actionButton,
	buttonRow,
	linkButton,
	type DiscordButton,
	type DiscordComponent,
} from "../../discord/components";
import { SETUP_CLOSE_ID, SETUP_MENU_ID } from "../ids";
import { grantPermissionsUrl, missingPermissionNames } from "../permissions";
import { MCP_SCREEN_ID, mcpScreen } from "./mcp";
import { claim, responder, closeRow, type InteractionRequest } from "./interaction";
import { MODEL_SCREEN_ID } from "./models";
import { PROFILES_SCREEN_ID } from "./profiles";
import { PROVIDER_SCREEN_ID } from "./providers";

/** What the setup menu's status block reports. */
interface SetupSummary {
	readonly ready: boolean;
	readonly providers: string;
	readonly model: string;
	readonly links: number;
	/** The default profile, named even when only the id is known. */
	readonly defaultName: string;
	/** The default profile as a guild without provider status shows it. */
	readonly profileName: string;
	/** Whether the profile list could be read at all. */
	readonly profileKnown: boolean;
	readonly missing: readonly string[];
}

/** The permissions the bot's role lacks, and the link that grants them. */
interface PermissionGap {
	readonly missing: readonly string[];
	readonly grantUrl?: string;
}

/** A guild installed before a tool existed still has the old role. */
async function permissionGap(request: InteractionRequest): Promise<PermissionGap> {
	// Discord applies new permissions only on install or re-authorisation, so
	// point at the link that updates the role in place. `undefined` means the
	// lookup failed, in which case the menu stays quiet rather than guessing.
	const current = await request.ctx.botPermissions(request.guildId).catch(() => undefined);

	if (current === undefined) return { missing: [] };

	const missing = missingPermissionNames(current);

	if (missing.length === 0) return { missing };

	return {
		missing,
		grantUrl: grantPermissionsUrl(request.ctx.applicationId, request.guildId, current),
	};
}

/** The status block the menu shows. */
function menuLines(summary: SetupSummary): string[] {
	const lines: string[] = [];

	if (summary.ready) {
		lines.push(
			"**Eryn is ready here.**",
			`Provider: **${summary.providers}**`,
			`Model: \`${summary.model}\``,
			`MCP servers: ${summary.links ? `${summary.links} linked` : "none"}`,
			`Default profile: **${summary.defaultName}**`,
		);
	} else {
		lines.push("**Eryn is not set up here yet.**", "Connect an inference provider to get started.");

		if (summary.links) lines.push(`MCP servers: ${summary.links} linked`);

		if (summary.profileKnown) lines.push(`Default profile: **${summary.profileName}**`);
	}

	if (summary.missing.length) {
		lines.push(
			"",
			`**Missing permissions:** ${summary.missing.join(", ")}. Some tools will fail until they are granted.`,
		);
	}

	return lines;
}

/** The menu's button rows, plus the grant link when permissions are missing. */
function menuRows(request: InteractionRequest, ready: boolean, grantUrl: string | undefined): DiscordComponent[] {
	const buttons: DiscordButton[] = [
		actionButton(
			ready ? "Change provider" : "Connect provider",
			request.id(PROVIDER_SCREEN_ID),
			ready ? 2 : 1,
		),
	];

	if (ready) buttons.push(actionButton("Choose model", request.id(MODEL_SCREEN_ID), 2));

	if (!request.dmGuildId) {
		buttons.push(actionButton("MCP servers", request.id(MCP_SCREEN_ID), 2));
		buttons.push(actionButton("Permissions", request.id(PROFILES_SCREEN_ID), 2));
	}

	buttons.push(actionButton("Close", request.id(SETUP_CLOSE_ID), 2));
	const rows: DiscordComponent[] = [buttonRow(buttons)];

	if (grantUrl) rows.push(buttonRow([linkButton("Grant permissions", grantUrl)]));

	return rows;
}

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

	const profiles = await request.session.profiles().catch(() => undefined);

	const defaultProfile = profiles?.profiles.find(
		(profile) => profile.id === profiles.defaultProfile,
	);

	const gap = await permissionGap(request);

	const summary: SetupSummary = {
		ready: status.ready,
		providers: status.providers.map((provider) => provider.integrationID).join(", ") || "none",
		model: status.model,
		links: status.links.length,
		defaultName: defaultProfile?.name ?? profiles?.defaultProfile ?? "Standard",
		profileName: defaultProfile?.name ?? "Standard",
		profileKnown: profiles !== undefined,
		missing: gap.missing,
	};

	await answer.reply(menuLines(summary).join("\n"), menuRows(request, status.ready, gap.grantUrl));
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
		"• `/eryn setup` — providers, models, MCP servers, the server's default permission profile, and current status (needs Manage Server)",
		"• `/eryn policy` — choose a profile or override tools in this channel or thread (needs Manage Server)",
		"• `/eryn reset` — wipe Eryn's files and restore the defaults (needs Manage Server)",
		"• `/eryn stop` — stop the run in this thread",
		"• `/eryn compact` — compact this conversation's history",
		"• `/eryn command <name> [arguments]` — run an OpenCode command",
		"• `/eryn commands` — list this conversation's commands",
		"• `/eryn help` — show this",
	].join("\n");
}
