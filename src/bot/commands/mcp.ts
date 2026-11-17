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
	type DiscordComponent,
	type DiscordModal,
	type DiscordSelectOption,
} from "../../discord/components";
import { describeTools } from "../../mcp/describe";
import { applyElicitation, elicitationOf, parseElicitation } from "../../mcp/elicitation";
import { type Mutable } from "../../mutable.ts";
import type { ElicitationMode, McpLink, McpProbeResponse, PublicLink } from "../../session/models";
import type { SessionClient } from "../client";
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

const SCREEN_APPROVALS_ID = "setup:mcp:approvals";

const ADD_MODAL_ID = "mcp:add";

const REMOVE_SELECT_ID = "mcp:remove";

const REMOVE_CONFIRM_ID = payloadId("mcp:remove:confirm:");

const APPROVALS_SELECT_ID = "mcp:approvals";

const APPROVAL_ID = payloadId("mcp:mode:");

const TEST_ALL_ID = "mcp:test:all";

const TEST_ID = payloadId("mcp:test:");

const AUTH_CHECK_ID = payloadId("mcp:oauth:");

/**
 * Where a linked server's questions can go, in the order the buttons offer them.
 *
 * The labels are the admin's view of the outcome, because the modes themselves
 * (Executor calls them `native`, `browser`, and `model`) mean nothing on their
 * own.
 */
const APPROVAL_MODES: readonly { mode: ElicitationMode; label: string; hint: string }[] = [
	{ mode: "discord", label: "Discord", hint: "posts the question in this channel" },
	{ mode: "browser", label: "Browser", hint: "opens the server's own page" },
	{ mode: "agent", label: "Agent", hint: "lets Eryn answer by itself" },
	{ mode: "off", label: "Off", hint: "declines anything that needs an answer" },
];

/** A link's mode in words, with the default Eryn falls back to. */
function approvalLabel(mode: ElicitationMode | undefined): string {
	return APPROVAL_MODES.find((entry) => entry.mode === (mode ?? "discord"))?.label ?? "Discord";
}

/** The four explanations, shared by the screen that asks and the one that changes. */
function approvalLegend(): string[] {
	return APPROVAL_MODES.map((entry) => `• **${entry.label}** — ${entry.hint}.`);
}

function approvalScreenText(link: PublicLink): string {
	return [
		`**Approvals for ${link.name}**`,
		`Currently **${approvalLabel(link.elicitation)}**.`,
		"",
		"Where should the server's questions that need a person go?",
		...approvalLegend(),
	].join("\n");
}

/**
 * The four choices, then whatever the screen offers underneath.
 *
 * A select would hold the descriptions in one control, but these are two or
 * three words each and the buttons are one click, so the explanation sits in
 * the message instead.
 */
function approvalRows(link: PublicLink, tail: readonly DiscordButton[]): DiscordComponent[] {
	const current = link.elicitation ?? "discord";

	return [
		buttonRow(
			APPROVAL_MODES.map((entry) =>
				actionButton(
					entry.mode === current ? `${entry.label} ✓` : entry.label,
					APPROVAL_ID.of(`${link.id}:${entry.mode}`),
					entry.mode === current ? 1 : 2,
				),
			),
		),
		buttonRow(tail),
	];
}

function mcpAddModal(): DiscordModal {
	return textModal(ADD_MODAL_ID, "Add an MCP server", [
		textInput({
			custom_id: "name",
			label: "Name (optional)",
			required: false,
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
			required: false,
			max_length: 500,
			placeholder: "Leave blank to sign in with OAuth instead",
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
		buttons.push(actionButton("Approvals", SCREEN_APPROVALS_ID, 2));
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

	const approval = APPROVAL_ID.read(customId);

	if (approval !== undefined) {
		return await claim(request, "update", () => setApproval(request, approval));
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
			return await claim(request, "reply", () => responder(request).modal(mcpAddModal()));
		case SCREEN_TEST_ID:
			return await claim(request, "update", () => testAllLinks(request));
		case SCREEN_REMOVE_ID:
			return await claim(request, "update", () => promptRemoveMcp(request));
		case SCREEN_APPROVALS_ID:
			return await claim(request, "update", () => promptApprovals(request));
		case REMOVE_SELECT_ID:
			return await claim(request, "update", () => confirmRemoveLink(request, values[0] ?? ""));
		case APPROVALS_SELECT_ID:
			return await claim(request, "update", () => showApprovals(request, values[0] ?? ""));
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

/** Which server's approval routing to change, when the choice is not obvious. */
async function promptApprovals(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const links = await request.session.links();

	if (!links.length) {
		await answer.reply("No MCP servers are linked to this server.", [backRow(request, MCP_SCREEN_ID)]);

		return;
	}

	await answer.reply(
		["**MCP approvals**", "Pick a server to change where its approval questions are answered."].join("\n"),
		[
			selectRow({
				type: 3,
				custom_id: APPROVALS_SELECT_ID,
				placeholder: "Pick a server",
				options: approvalOptions(links),
			}),
			buttonRow([actionButton("Cancel", MCP_SCREEN_ID, 2)]),
		],
	);
}

/** One link's approval screen, after it was picked from the list. */
async function showApprovals(request: InteractionRequest, linkId: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const link = (await request.session.links()).find((candidate) => candidate.id === linkId);

	if (!link) {
		await answer.update("That MCP server is no longer linked.", [backRow(request, MCP_SCREEN_ID)]);

		return;
	}

	await answer.update(approvalScreenText(link), [
		...approvalRows(link, [actionButton("Back to servers", MCP_SCREEN_ID, 2)]),
	]);
}

/**
 * Move one link's questions. The link itself, token included, is untouched:
 * the session object reads it, applies the mode, and writes it back.
 */
async function setApproval(request: InteractionRequest, payload: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const separator = payload.lastIndexOf(":");
	const linkId = separator > 0 ? payload.slice(0, separator) : "";
	const mode = parseElicitation(separator > 0 ? payload.slice(separator + 1) : undefined);
	const link = linkId ? (await request.session.links()).find((candidate) => candidate.id === linkId) : undefined;

	if (!link || !mode) {
		await answer.update("That MCP server is no longer linked.", [backRow(request, MCP_SCREEN_ID)]);

		return;
	}

	try {
		await request.session.setLinkElicitation(link.id, mode);
	} catch (error) {
		await answer.update(`Could not change approvals for **${link.name}**: ${describeError(error)}`, [
			...approvalRows(link, [actionButton("Back to servers", MCP_SCREEN_ID, 2)]),
		]);

		return;
	}

	const updated: PublicLink = { ...link, elicitation: mode };
	await answer.update(approvalScreenText(updated), [
		...approvalRows(updated, [actionButton("Back to servers", MCP_SCREEN_ID, 2)]),
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
	const rawUrl = values.url?.trim();

	if (!rawUrl) {
		await answer.reply("An MCP server URL is required.", [backRow(request, MCP_SCREEN_ID)]);

		return;
	}

	let endpoint: URL;

	try {
		endpoint = new URL(rawUrl);
	} catch {
		await answer.reply("That URL is not valid.", [backRow(request, MCP_SCREEN_ID)]);

		return;
	}

	const name = values.name?.trim() || endpoint.host;
	const token = values.token?.trim();
	// The URL may already name a mode, as Executor's links do. Otherwise the
	// link starts on Discord, and the connected screen offers the other three as
	// one click each.
	const elicitation: ElicitationMode = elicitationOf(rawUrl) ?? "discord";
	const url = applyElicitation(endpoint.toString(), elicitation);

	// Testing is a round trip to someone else's server, so acknowledge first and
	// edit the ephemeral reply when there is an answer.
	await answer.defer();
	const probe = await request.session.probe(url, token);

	if (!probe.ok) {
		// A 401 with a Bearer challenge is the server saying it supports a
		// sign-in. If discovery finds nothing, the reply falls back to a token.
		if (probe.needsAuth) {
			await startAuth({ request, name, url, probe, elicitation });

			return;
		}

		await answer.reply(`Could not connect to **${name}**: ${probe.error ?? "the server did not answer"}`, [
			backRow(request, MCP_SCREEN_ID),
		]);

		return;
	}

	const link: Mutable<McpLink> = {
		id: crypto.randomUUID(),
		name,
		url,
		elicitation,
		createdAt: Date.now(),
	};

	if (token) link.token = token;

	await request.session.addLink(link);
	await answer.reply(
		[
			`**${name} is connected.**`,
			describeTools(probe.tools),
			"Eryn will use it on the next turn.",
			"",
			`**Where should ${name}'s requests for approval go?**`,
			...approvalLegend(),
		]
			.filter(Boolean)
			.join("\n"),
		approvalRows(link, [
			actionButton("Test", TEST_ID.of(link.id), 2),
			actionButton("Back to servers", MCP_SCREEN_ID, 2),
		]),
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

/** Everything starting a server's sign-in needs from the form that asked for it. */
interface StartAuthInput {
	readonly request: InteractionRequest;
	readonly name: string;
	readonly url: string;
	readonly probe: McpProbeResponse;
	readonly elicitation: ElicitationMode;
}

/** Send the admin to the server's sign-in page, or explain why one cannot start. */
async function startAuth(input: StartAuthInput): Promise<void> {
	const { request, name, probe } = input;
	const answer = responder(request);

	const payload: Mutable<Parameters<SessionClient["mcpAuthStart"]>[0]> = {
		name: input.name,
		url: input.url,
		elicitation: input.elicitation,
		applicationId: request.interaction.application_id,
		interactionToken: request.interaction.token,
	};

	if (probe.resourceMetadataUrl) payload.resourceMetadataUrl = probe.resourceMetadataUrl;

	if (probe.scope) payload.scope = probe.scope;

	const started = await request.session.mcpAuthStart(payload);

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
	const lines = [`**${name}** needs you to sign in before Eryn can use it.`];

	if (signInUrl.length > MAX_LINK_URL) lines.push("", signInUrl);

	lines.push("", "Open the link, approve the access, then press **I've finished**.");

	await answer.reply(lines.join("\n"), [signInRow(started.attemptId, signInUrl)]);
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
		const connectedLines = [`**${name} is connected.** Eryn will use it on the next turn.`];

		if (status.link) {
			connectedLines.push("", `**Where should ${name}'s requests for approval go?**`, ...approvalLegend());
		}

		await answer.update(
			connectedLines.join("\n"),
			status.link
				? approvalRows(status.link, [
						actionButton("Test", TEST_ID.of(status.link.id), 2),
						actionButton("Back to servers", MCP_SCREEN_ID, 2),
					])
				: [backRow(request, MCP_SCREEN_ID)],
		);

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

	const pendingLines = [
		url
			? "Still waiting for the sign-in. Finish it in your browser, then press **I've finished** again."
			: "Still waiting for the sign-in, but its link could not be reloaded. Go **Back** and link the server again if the browser page is gone.",
	];

	if (url && url.length > MAX_LINK_URL) pendingLines.push("", url);

	await answer.update(pendingLines.join("\n"), [signInRow(attemptId, url)]);
}

/** Describe each link in turn, so ten probes never hit one server at once. */
async function describeLinkTests(
	request: InteractionRequest,
	links: readonly McpLink[],
): Promise<string[]> {
	if (links.length === 0) return [];

	const [link, ...rest] = links;
	const line = `• **${link.name}** — ${await describeLinkTest(request, link)}`;

	return [line, ...(await describeLinkTests(request, rest))];
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

	const shown = links.slice(0, 10);
	const results = await describeLinkTests(request, shown);

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

/** The same list for the approvals screen, where the current mode is the useful hint. */
function approvalOptions(links: readonly PublicLink[]): DiscordSelectOption[] {
	return links.slice(0, MAX_SELECT_OPTIONS).map((link) => ({
		label: link.name.slice(0, 100),
		value: link.id,
		description: `${hostOf(link.url)} · approvals: ${approvalLabel(link.elicitation)}`.slice(0, 100),
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

	const lines = shown.map(
		(link) => `• **${link.name}** — ${hostOf(link.url)} · approvals: **${approvalLabel(link.elicitation)}**`,
	);

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
