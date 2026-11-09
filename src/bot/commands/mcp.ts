/**
 * External MCP servers.
 *
 * Listing, linking, testing, and removing them, plus the browser sign-in a
 * server can demand before it accepts Eryn. A link is guild-wide, so this
 * screen is only reachable in the server, never from an install DM sent by an
 * older build.
 */

import { describeError } from "../../errors";
import {
	actionButton,
	buttonRow,
	linkButton,
	selectRow,
	type DiscordButton,
	type DiscordModal,
	type DiscordSelectOption,
} from "../../discord/components";
import { describeTools } from "../../mcp/describe";
import type { McpLink, McpProbeResponse, PublicLink } from "../../session/models";
import { SETUP_MENU_ID, payloadId } from "../ids";
import {
	claim,
	responder,
	backRow,
	removeRow,
	textInput,
	textModal,
	MAX_SELECT_OPTIONS,
	type InteractionRequest,
} from "./interaction";

/** Discord rejects a link button whose URL is longer than this. */
const MAX_LINK_URL = 512;

/** The setup menu's MCP button, owned here so this screen can re-render itself. */
export const MCP_SCREEN_ID = `${SETUP_MENU_ID}:mcp`;

const SCREEN_ADD_ID = "setup:mcp:add";
const SCREEN_TEST_ID = "setup:mcp:test";
const SCREEN_REMOVE_ID = "setup:mcp:remove";
const ADD_MODAL_ID = "mcp:add";
const REMOVE_SELECT_ID = "mcp:remove";
const REMOVE_CONFIRM_ID = payloadId("mcp:remove:confirm:");
const TEST_ALL_ID = "mcp:test:all";
const TEST_ID = payloadId("mcp:test:");
const AUTH_CHECK_ID = payloadId("mcp:oauth:");

function mcpAddModal(): DiscordModal {
	return textModal(ADD_MODAL_ID, "Add an MCP server", [
		textInput({
			custom_id: "name",
			label: "Name (optional)",
			max_length: 60,
			placeholder: "Defaults to the server's host",
		}),
		textInput({
			custom_id: "url",
			label: "Server URL",
			required: true,
			max_length: 300,
			placeholder: "https://example.com/mcp",
		}),
		textInput({
			custom_id: "token",
			label: "Access token (optional)",
			max_length: 500,
			placeholder: "Leave blank unless the server gave you one",
		}),
	]);
}

export async function mcpScreen(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const links = await request.session.links();
	const buttons: DiscordButton[] = [actionButton("Link a server", SCREEN_ADD_ID, 1)];
	if (links.length) {
		buttons.push(actionButton("Test all", SCREEN_TEST_ID, 2));
		buttons.push(actionButton("Remove", SCREEN_REMOVE_ID, 3));
	}
	buttons.push(actionButton("Back", SETUP_MENU_ID, 2));
	await answer.reply(formatLinks(links), [buttonRow(buttons)]);
}

export async function mcpComponent(
	request: InteractionRequest,
	customId: string,
	values: readonly string[],
): Promise<boolean> {
	// The exact "test all" id is checked before the `mcp:test:<id>` family, whose
	// prefix it shares.
	if (customId === TEST_ALL_ID) {
		return await claim(request, "update", () => testAllLinks(request));
	}
	const test = TEST_ID.read(customId);
	if (test !== undefined) {
		return await claim(request, "update", () => testOneLink(request, test));
	}
	const authCheck = AUTH_CHECK_ID.read(customId);
	if (authCheck !== undefined) {
		return await claim(request, "update", () => checkAuth(request, authCheck));
	}
	const removeConfirm = REMOVE_CONFIRM_ID.read(customId);
	if (removeConfirm !== undefined) {
		return await claim(request, "update", () => removeLink(request, removeConfirm));
	}
	switch (customId) {
		case SCREEN_ADD_ID:
			await responder(request).modal(mcpAddModal());
			return true;
		case SCREEN_TEST_ID:
			return await claim(request, "update", () => testAllLinks(request));
		case SCREEN_REMOVE_ID:
			return await claim(request, "update", () => promptRemoveMcp(request));
		case REMOVE_SELECT_ID:
			return await claim(request, "update", () => confirmRemoveLink(request, values[0] ?? ""));
	}
	return false;
}

export async function mcpModal(
	request: InteractionRequest,
	customId: string,
	values: Record<string, string>,
): Promise<boolean> {
	if (customId !== ADD_MODAL_ID) return false;
	return await claim(request, "reply", () => addLink(request, values));
}

async function promptRemoveMcp(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const links = await request.session.links();
	if (!links.length) {
		await answer.reply("No MCP servers are linked to this server.", [backRow(request, MCP_SCREEN_ID)]);
		return;
	}
	await answer.reply("Which MCP server should I remove?", [
		selectRow({ type: 3, custom_id: REMOVE_SELECT_ID, placeholder: "Pick a server", options: linkOptions(links) }),
		buttonRow([actionButton("Cancel", MCP_SCREEN_ID, 2)]),
	]);
}

/** Removing a link throws away its token, so it is confirmed like a provider. */
async function confirmRemoveLink(request: InteractionRequest, linkId: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const link = (await request.session.links()).find((candidate) => candidate.id === linkId);
	if (!link) {
		await answer.reply("That MCP server is no longer linked.", [backRow(request, MCP_SCREEN_ID)]);
		return;
	}
	await answer.reply(`Remove **${link.name}**? Eryn will stop using its tools immediately.`, [
		removeRow(request, REMOVE_CONFIRM_ID.of(linkId), MCP_SCREEN_ID),
	]);
}

async function removeLink(request: InteractionRequest, linkId: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const link = (await request.session.links()).find((candidate) => candidate.id === linkId);
	try {
		await request.session.removeLink(linkId);
	} catch (error) {
		await answer.update(
			`Could not remove **${link?.name ?? linkId}**: ${describeError(error)}`,
			[backRow(request, MCP_SCREEN_ID)],
		);
		return;
	}
	await answer.update(`Removed **${link?.name ?? linkId}**.`, [backRow(request, MCP_SCREEN_ID)]);
}

/** Probe a URL, then either link it or start the sign-in it asked for. */
async function addLink(request: InteractionRequest, values: Record<string, string>): Promise<void> {
	const answer = responder(request);
	const url = values.url?.trim();
	if (!url) {
		await answer.reply("An MCP server URL is required.", [backRow(request, MCP_SCREEN_ID)]);
		return;
	}
	let endpoint: URL;
	try {
		endpoint = new URL(url);
	} catch {
		await answer.reply("That URL is not valid.", [backRow(request, MCP_SCREEN_ID)]);
		return;
	}
	const name = values.name?.trim() || endpoint.host;
	const token = values.token?.trim();

	// Testing is a round trip to someone else's server, so acknowledge first and
	// edit the ephemeral reply when there is an answer.
	await answer.defer();
	const probe = await request.session.probe(url, token);
	if (!probe.ok) {
		// A 401 with a Bearer challenge is the server saying it supports a
		// sign-in. If discovery finds nothing, the reply falls back to a token.
		if (probe.needsAuth) {
			await startAuth(request, name, url, probe);
			return;
		}
		await answer.reply(`Could not connect to **${name}**: ${probe.error ?? "the server did not answer"}`, [
			backRow(request, MCP_SCREEN_ID),
		]);
		return;
	}

	const link: McpLink = {
		id: crypto.randomUUID(),
		name,
		url,
		createdAt: Date.now(),
		...(token ? { token } : {}),
	};
	await request.session.addLink(link);
	await answer.reply(
		[`**${name} is connected.**`, describeTools(probe.tools), "Eryn will use it on the next turn."]
			.filter(Boolean)
			.join("\n"),
		[
			buttonRow([
				actionButton("Test", TEST_ID.of(link.id), 2),
				actionButton("Back to servers", MCP_SCREEN_ID, 2),
			]),
		],
	);
}

/** The buttons kept on a message while a browser sign-in is in progress. */
function signInRow(attemptId: string, url?: string) {
	const buttons: DiscordButton[] = [];
	if (url && url.length <= MAX_LINK_URL) buttons.push(linkButton("Sign in", url));
	buttons.push(actionButton("I've finished", AUTH_CHECK_ID.of(attemptId), 3));
	buttons.push(actionButton("Back", MCP_SCREEN_ID, 2));
	return buttonRow(buttons);
}

/** Send the admin to the server's sign-in page, or explain why one cannot start. */
async function startAuth(
	request: InteractionRequest,
	name: string,
	url: string,
	probe: McpProbeResponse,
): Promise<void> {
	const answer = responder(request);
	const started = await request.session.mcpAuthStart({
		name,
		url,
		applicationId: request.interaction.application_id,
		interactionToken: request.interaction.token,
		...(probe.resourceMetadataUrl ? { resourceMetadataUrl: probe.resourceMetadataUrl } : {}),
		...(probe.scope ? { scope: probe.scope } : {}),
	});
	if (!started.ok || !started.url || !started.attemptId) {
		await answer.reply(
			[
				`**${name}** needs authorisation before Eryn can use it.`,
				started.error ?? "",
				"",
				"If you have a token for it, link the server again and put the token in **Access token**.",
			]
				.filter(Boolean)
				.join("\n"),
			[backRow(request, MCP_SCREEN_ID)],
		);
		return;
	}
	// The callback lands on the Worker, not this interaction, so the start link
	// carries a signed attempt rather than the server's own URL.
	const signInUrl = started.startUrl ?? started.url;
	await answer.reply(
		[
			`**${name}** needs you to sign in before Eryn can use it.`,
			...(signInUrl.length > MAX_LINK_URL ? ["", signInUrl] : []),
			"",
			"Open the link, approve the access, then press **I've finished**.",
		].join("\n"),
		[signInRow(started.attemptId, signInUrl)],
	);
}

/**
 * The "I've finished" button, and the state a browser callback leaves behind.
 *
 * Both paths write the same attempt record, so whichever arrives second just
 * reads the outcome; the button never needs the code itself.
 */
async function checkAuth(request: InteractionRequest, attemptId: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const status = await request.session.mcpAuthStatus(attemptId);

	if (status.status === "complete") {
		const name = status.link?.name ?? "The server";
		await answer.update(`**${name} is connected.** Eryn will use it on the next turn.`, [
			status.link
				? buttonRow([
						actionButton("Test", TEST_ID.of(status.link.id), 2),
						actionButton("Back to servers", MCP_SCREEN_ID, 2),
					])
				: backRow(request, MCP_SCREEN_ID),
		]);
		return;
	}
	if (status.status === "failed") {
		await answer.update(
			`The sign-in did not complete: ${status.message ?? "the server gave no reason"}. Link the server again to retry.`,
			[backRow(request, MCP_SCREEN_ID)],
		);
		return;
	}
	if (status.status === "missing") {
		await answer.update("That sign-in is no longer available. Link the server again to retry.", [
			backRow(request, MCP_SCREEN_ID),
		]);
		return;
	}

	// Still pending: keep the sign-in reachable, because replacing the message
	// would otherwise take the link away with it.
	const url = await request.session.mcpAuthUrl(attemptId).catch(() => undefined);
	await answer.update(
		[
			url
				? "Still waiting for the sign-in. Finish it in your browser, then press **I've finished** again."
				: "Still waiting for the sign-in, but its link could not be reloaded. Go **Back** and link the server again if the browser page is gone.",
			...(url && url.length > MAX_LINK_URL ? ["", url] : []),
		].join("\n"),
		[signInRow(attemptId, url)],
	);
}

/** Test every link, one at a time, and report each in a line. */
async function testAllLinks(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const links = await request.session.links();
	if (!links.length) {
		await answer.reply("No MCP servers are linked to this server.", [backRow(request, MCP_SCREEN_ID)]);
		return;
	}
	const results: string[] = [];
	const shown = links.slice(0, 10);
	for (const link of shown) {
		results.push(`• **${link.name}** — ${await describeLinkTest(request, link)}`);
	}
	if (links.length > shown.length) results.push(`…and ${links.length - shown.length} more.`);
	await answer.reply(clamp(["**MCP server test**", ...results].join("\n"), 1_900), [
		buttonRow([actionButton("Test again", TEST_ALL_ID, 1), actionButton("Back", MCP_SCREEN_ID, 2)]),
	]);
}

async function testOneLink(request: InteractionRequest, linkId: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const link = (await request.session.links()).find((candidate) => candidate.id === linkId);
	const name = link?.name ?? "That MCP server";
	if (!link) {
		await answer.update(`**${name}** is no longer linked.`, [backRow(request, MCP_SCREEN_ID)]);
		return;
	}
	await answer.update(`**${name}** — ${await describeLinkTest(request, link)}`, [
		buttonRow([actionButton("Test again", TEST_ID.of(linkId), 2), actionButton("Back", MCP_SCREEN_ID, 2)]),
	]);
}

/** One link's test result, as a sentence for a Discord message. */
async function describeLinkTest(request: InteractionRequest, link: PublicLink): Promise<string> {
	try {
		const result = await request.session.testLink(link.id);
		if (!result.ok) return clamp(`failed: ${result.error ?? "the server did not answer"}`, 240);
		const names = result.tools.slice(0, 6).map((tool) => tool.name).join(", ");
		const tools = result.tools.length
			? `${result.tools.length} tool${result.tools.length === 1 ? "" : "s"}${names ? ` (${names}${result.tools.length > 6 ? ", …" : ""})` : ""}`
			: "no tools";
		return clamp(`working — ${tools}`, 240);
	} catch (error) {
		return clamp(`failed: ${describeError(error)}`, 240);
	}
}

/** Keep a message inside Discord's limit rather than letting the send fail. */
function clamp(value: string, limit: number): string {
	return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function linkOptions(links: readonly PublicLink[]): DiscordSelectOption[] {
	return links.slice(0, MAX_SELECT_OPTIONS).map((link) => ({
		label: link.name.slice(0, 100),
		value: link.id,
		description: hostOf(link.url).slice(0, 100),
	}));
}

function formatLinks(links: readonly PublicLink[]): string {
	if (!links.length) {
		return [
			"**MCP servers**",
			"MCP servers give Eryn extra tools. Link one by its streamable HTTP URL and Eryn can use it on the next turn.",
		].join("\n");
	}
	const shown = links.slice(0, 15);
	const lines = shown.map((link) => `• **${link.name}** — ${hostOf(link.url)}`);
	if (links.length > shown.length) lines.push(`…and ${links.length - shown.length} more.`);
	return ["**MCP servers**", ...lines].join("\n");
}

/** The host of a link's URL, for display; a malformed URL is shown as-is. */
function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
