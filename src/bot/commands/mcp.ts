/**
 * External MCP servers.
 *
 * Listing, linking, testing, and removing them, plus the browser sign-in a
 * server can demand before it accepts Eryn. A link is guild-wide, so this
 * screen is only reachable in the server, never from the install DM.
 */

import { publicOrigin } from "../../config";
import { sign } from "../../crypto";
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
import { describeTools, MCP_START_PATH } from "../../mcp/links";
import type { McpLink, McpProbeResponse, PublicLink } from "../../session/models";
import { SETUP_MENU_ID, payloadId } from "../ids";
import { guarded, responder, textInput, textModal, MAX_SELECT_OPTIONS, type InteractionRequest } from "./interaction";

const SCREEN_ADD_ID = "setup:mcp:add";
const SCREEN_TEST_ID = "setup:mcp:test";
const SCREEN_REMOVE_ID = "setup:mcp:remove";
const ADD_MODAL_ID = "mcp:add";
const REMOVE_SELECT_ID = "mcp:remove";
const TEST_ALL_ID = "mcp:test:all";
const TEST_ID = payloadId("mcp:test:");
const AUTH_CHECK_ID = payloadId("mcp:oauth:");

function mcpAddModal(): DiscordModal {
	return textModal(ADD_MODAL_ID, "Add an MCP server", [
		textInput({ custom_id: "name", label: "Name", required: true, max_length: 60, placeholder: "my-mcp-server" }),
		textInput({
			custom_id: "url",
			label: "Streamable HTTP URL",
			required: true,
			max_length: 300,
			placeholder: "https://example.com/mcp",
		}),
		textInput({
			custom_id: "token",
			label: "Bearer token (optional)",
			max_length: 500,
			placeholder: "Leave blank to test without one",
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
		await guarded(request, "update", () => testAllLinks(request));
		return true;
	}
	const test = TEST_ID.read(customId);
	if (test !== undefined) {
		await guarded(request, "update", () => testOneLink(request, test));
		return true;
	}
	const authCheck = AUTH_CHECK_ID.read(customId);
	if (authCheck !== undefined) {
		await guarded(request, "update", () => checkAuth(request, authCheck));
		return true;
	}
	switch (customId) {
		case SCREEN_ADD_ID:
			await responder(request).modal(mcpAddModal());
			return true;
		case SCREEN_TEST_ID:
			await guarded(request, "update", () => testAllLinks(request));
			return true;
		case SCREEN_REMOVE_ID:
			await guarded(request, "update", () => promptRemoveMcp(request));
			return true;
		case REMOVE_SELECT_ID:
			await guarded(request, "update", () => removeLink(request, values[0] ?? ""));
			return true;
	}
	return false;
}

export async function mcpModal(
	request: InteractionRequest,
	customId: string,
	values: Record<string, string>,
): Promise<boolean> {
	if (customId !== ADD_MODAL_ID) return false;
	await guarded(request, "reply", () => addLink(request, values));
	return true;
}

async function promptRemoveMcp(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const links = await request.session.links();
	if (!links.length) {
		await answer.reply("No MCP servers are linked to this server.");
		return;
	}
	await answer.reply("Which linked MCP server should I remove?", [
		selectRow({ type: 3, custom_id: REMOVE_SELECT_ID, placeholder: "Pick a server", options: linkOptions(links) }),
	]);
}

async function removeLink(request: InteractionRequest, linkId: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const link = (await request.session.links()).find((candidate) => candidate.id === linkId);
	await request.session.removeLink(linkId);
	await answer.update(`Removed **${link?.name ?? linkId}**.`);
}

/** Probe a URL, then either link it or start the sign-in it asked for. */
async function addLink(request: InteractionRequest, values: Record<string, string>): Promise<void> {
	const answer = responder(request);
	const url = values.url?.trim();
	if (!url) {
		await answer.reply("An MCP server URL is required.");
		return;
	}
	let endpoint: URL;
	try {
		endpoint = new URL(url);
	} catch {
		await answer.reply("That URL is not valid.");
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
		await answer.reply(`Could not connect to **${name}**: ${probe.error ?? "the server did not answer"}`);
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
		`**${name} is connected.** ${describeTools(probe.tools)} Eryn will use it on the next turn.`,
		[buttonRow([actionButton("Test", TEST_ID.of(link.id), 3)])],
	);
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
				"If you have a token for it, run `/eryn setup`, open MCP servers, and link it with the token.",
			]
				.filter(Boolean)
				.join("\n"),
		);
		return;
	}
	// The callback lands on the Worker, not this interaction, so the start link
	// carries a signed attempt rather than the server's own URL.
	const secret = request.ctx.env.SESSION_SECRET?.trim();
	const state = secret ? await sign({ guildId: request.guildId, attemptId: started.attemptId }, secret) : undefined;
	const signInUrl = state ? `${publicOrigin(request.ctx.env)}${MCP_START_PATH}/${state}` : started.url;
	await answer.reply(
		[
			`**${name}** needs you to sign in before Eryn can use it.`,
			"",
			"Open the link, approve the access, then press **I've finished**. The sign-in finishes in your browser, so this message can stay here.",
		].join("\n"),
		[
			buttonRow([
				linkButton("Sign in", signInUrl),
				actionButton("I've finished", AUTH_CHECK_ID.of(started.attemptId), 3),
			]),
		],
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
	const components = status.link ? [buttonRow([actionButton("Test", TEST_ID.of(status.link.id), 3)])] : undefined;

	if (status.status === "complete") {
		const name = status.link?.name ?? "The server";
		await answer.update(`**${name} is connected.** Eryn will use it on the next turn.`, components);
		return;
	}
	if (status.status === "failed") {
		await answer.update(
			`The sign-in did not complete: ${status.message ?? "the server gave no reason"}.\n\nStart again from \`/eryn setup\` under MCP servers.`,
		);
		return;
	}
	if (status.status === "missing") {
		await answer.update("That sign-in is no longer available. Start again from `/eryn setup` under MCP servers.");
		return;
	}
	await answer.update("Still waiting for the sign-in. Finish it in your browser, then press **I've finished** again.", [
		buttonRow([actionButton("I've finished", AUTH_CHECK_ID.of(attemptId), 3)]),
	]);
}

/** Test every link, one at a time, and report each in a line. */
async function testAllLinks(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const links = await request.session.links();
	if (!links.length) {
		await answer.reply("No MCP servers are linked to this server.");
		return;
	}
	const results: string[] = [];
	const shown = links.slice(0, 10);
	for (const link of shown) {
		results.push(`• **${link.name}** — ${await describeLinkTest(request, link)}`);
	}
	if (links.length > shown.length) results.push(`…and ${links.length - shown.length} more.`);
	await answer.reply(clamp(["**MCP server test**", ...results].join("\n"), 1_900), [
		buttonRow([actionButton("Test again", TEST_ALL_ID, 1)]),
	]);
}

async function testOneLink(request: InteractionRequest, linkId: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const link = (await request.session.links()).find((candidate) => candidate.id === linkId);
	const name = link?.name ?? "That MCP server";
	if (!link) {
		await answer.update(`**${name}** is no longer linked.`);
		return;
	}
	await answer.update(`**${name}** — ${await describeLinkTest(request, link)}`, [
		buttonRow([actionButton("Test again", TEST_ID.of(linkId))]),
	]);
}

/** One link's test result, as a sentence for a Discord message. */
async function describeLinkTest(request: InteractionRequest, link: PublicLink): Promise<string> {
	try {
		const result = await request.session.testLink(link.id);
		if (!result.ok) return clamp(`failed: ${result.error ?? "the server did not answer"}`, 240);
		return clamp(`working — ${describeTools(result.tools)}`, 240);
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
	if (!links.length) return "No MCP servers are linked to this server.";
	const shown = links.slice(0, 15);
	const lines = shown.map((link) => `• **${link.name}** — ${hostOf(link.url)}`);
	if (links.length > shown.length) lines.push(`…and ${links.length - shown.length} more.`);
	return ["**MCP servers linked to this server:**", ...lines].join("\n");
}

/** The host of a link's URL, for display; a malformed URL is shown as-is. */
function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
