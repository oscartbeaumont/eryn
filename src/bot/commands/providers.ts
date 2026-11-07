/**
 * Connecting inference providers.
 *
 * Choosing a provider, picking how it is connected, and the three ways that
 * flow finishes: an API key in a modal, a browser sign-in that is confirmed
 * afterwards, or a device code typed back into a modal. Removing a provider
 * lives here too, since it undoes the same connection.
 */

import { describeError } from "../../errors";
import {
	actionButton,
	buttonRow,
	linkButton,
	selectRow,
	type DiscordButton,
	type DiscordComponent,
	type DiscordSelectOption,
	type DiscordModal,
} from "../../discord/components";
import type { IntegrationOption } from "../../session/models";
import { SETUP_CLOSE_ID, SETUP_MENU_ID, payloadId, scopedId } from "../ids";
import {
	guarded,
	responder,
	textInput,
	textModal,
	MAX_SELECT_OPTIONS,
	type InteractionRequest,
} from "./interaction";
import { modelScreen } from "./models";

/** The setup menu's provider button, owned here so this module can re-render itself. */
export const PROVIDER_SCREEN_ID = `${SETUP_MENU_ID}:provider`;

/** The "Remove provider" button on the provider screen. */
export const REMOVE_PROVIDER_ID = "setup:provider:remove";

const SELECT_ID = "setup:provider";
const SEARCH_ID = "setup:search";
const REMOVE_SELECT_ID = "setup:provider:remove:select";
const PICK_ID = payloadId("setup:provider:pick:");
const METHOD_ID = payloadId("setup:method:");
const KEY_ID = payloadId("setup:key:");
const CODE_ID = payloadId("setup:code:");
const OAUTH_CHECK_ID = payloadId("setup:oauthcheck:");
const REMOVE_CONFIRM_ID = payloadId("setup:provider:remove:confirm:");

/** Discord rejects a link button whose URL is longer than this. */
const MAX_LINK_URL = 512;

/**
 * Providers worth showing first.
 *
 * models.dev has far more providers than a Discord select can hold, so the
 * initial list is the common ones; everything else is reachable by search.
 */
const PREFERRED_PROVIDERS = [
	"opencode",
	"opencode-go",
	"openrouter",
	"openai",
	"anthropic",
	"google",
	"google-vertex",
	"deepseek",
	"mistral",
	"groq",
	"xai",
	"cerebras",
	"togetherai",
	"fireworks",
	"deepinfra",
	"amazon-bedrock",
	"azure",
	"github-copilot",
	"ollama",
	"lmstudio",
];

/** Connected first, then the preferred order, then alphabetical. */
function providerRank(provider: { id: string; connected: boolean }): number {
	if (provider.connected) return -1;
	const index = PREFERRED_PROVIDERS.indexOf(provider.id);
	return index >= 0 ? index : PREFERRED_PROVIDERS.length;
}

/** The providers this deployment can connect, connected first then preferred. */
function connectable(providers: readonly IntegrationOption[]): IntegrationOption[] {
	return providers
		.filter((provider) => provider.connected || provider.methods.some((method) => method.supported))
		.sort((a, b) => providerRank(a) - providerRank(b) || a.name.localeCompare(b.name));
}

/** The provider select's entries, in the order the list is already sorted. */
function providerOptions(providers: readonly IntegrationOption[]): DiscordSelectOption[] {
	return providers.slice(0, MAX_SELECT_OPTIONS).map((provider) => ({
		label: provider.name.slice(0, 100),
		value: provider.id,
		description: (provider.connected ? "connected" : provider.methods.map((method) => method.label).join(", ")).slice(0, 100),
	}));
}

function providerSearchModal(request: InteractionRequest): DiscordModal {
	return textModal(scopedId(SEARCH_ID, request.dmGuildId), "Search providers", [
		textInput({
			custom_id: "query",
			label: "Provider name or id",
			required: true,
			max_length: 100,
			placeholder: "openrouter",
		}),
	]);
}

function keyModal(request: InteractionRequest, integrationID: string): DiscordModal {
	return textModal(KEY_ID.of(integrationID, request.dmGuildId), "Connect with an API key", [
		textInput({ custom_id: "key", label: `${integrationID} API key`, required: true, max_length: 500 }),
	]);
}

function codeModal(request: InteractionRequest, integrationID: string): DiscordModal {
	return textModal(CODE_ID.of(integrationID, request.dmGuildId), "Enter the sign-in code", [
		textInput({ custom_id: "code", label: "Code", required: true, max_length: 500 }),
	]);
}

/** The provider list, with a select for the full set and buttons for the common ones. */
export async function providerScreen(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const id = (base: string) => scopedId(base, request.dmGuildId);
	// Connections come from the status, not the catalogue: a connected provider
	// still has to be removable when the catalogue is empty or slow.
	const status = await request.session.config().catch(() => undefined);
	if (!status) {
		await answer.reply("Eryn could not read this server's providers right now. Try again in a moment.", [
			buttonRow([actionButton("Back", id(SETUP_MENU_ID), 2)]),
		]);
		return;
	}
	const connected = status.providers.map((provider) => provider.integrationID);
	const navigation: DiscordButton[] = [];
	// Provider removal is guild-wide, so the install DM still sends admins here.
	if (connected.length && !request.dmGuildId) navigation.push(actionButton("Remove provider", REMOVE_PROVIDER_ID, 4));
	navigation.push(actionButton("Back", id(SETUP_MENU_ID), 2));

	const providers = connectable(await request.session.providers());
	if (!providers.length) {
		await answer.reply(
			[
				"**Providers**",
				connected.length
					? `Connected: **${connected.join("**, **")}**`
					: "No provider is connected yet — Eryn needs one to answer.",
				connected.length
					? "This deployment has no other provider it can connect right now."
					: "Eryn cannot connect any inference provider in this deployment right now.",
			].join("\n"),
			[buttonRow(navigation)],
		);
		return;
	}
	const recommended = PREFERRED_PROVIDERS.map((wanted) => providers.find((provider) => provider.id === wanted))
		.filter((provider): provider is IntegrationOption => provider !== undefined)
		.slice(0, 5);
	const components: DiscordComponent[] = [];
	if (recommended.length) {
		components.push(
			buttonRow(
				recommended.map((provider) => actionButton(provider.name, PICK_ID.of(provider.id, request.dmGuildId), 2)),
			),
		);
	}
	components.push(
		selectRow({ type: 3, custom_id: id(SELECT_ID), placeholder: "Browse all providers", options: providerOptions(providers) }),
		buttonRow([actionButton("Search all providers", id(SEARCH_ID), 2)]),
	);
	components.push(buttonRow(navigation));

	await answer.reply(
		[
			"**Providers**",
			connected.length
				? `Connected: **${connected.join("**, **")}**`
				: "No provider is connected yet — Eryn needs one to answer.",
			connected.length
				? "Pick another to add it, or a connected one to replace its credentials."
				: "Pick a provider below.",
			...(providers.length > MAX_SELECT_OPTIONS
				? [`Showing the first ${MAX_SELECT_OPTIONS} here; use **Search all providers** for the rest.`]
				: []),
			...(providers.some((provider) => provider.id === "opencode")
				? ["OpenCode Go models are included with the OpenCode Console connection."]
				: []),
		].join("\n"),
		components,
	);
}

/** Show the providers matching a search, as a select of at most 25. */
async function searchProviders(request: InteractionRequest, query: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const id = (base: string) => scopedId(base, request.dmGuildId);
	const needle = query.trim().toLowerCase();
	const goQuery = /^(oc|opencode)\s*go$/.test(needle) || needle === "ocgo";
	const matches = connectable(await request.session.providers())
		.filter((provider) =>
			goQuery
				? provider.id === "opencode"
				: !needle ||
					provider.id.toLowerCase().includes(needle) ||
					provider.name.toLowerCase().includes(needle),
		)
		.slice(0, MAX_SELECT_OPTIONS);
	if (!matches.length) {
		await answer.reply(
			`No provider matches “${query.trim()}”. Try a shorter search.${
				goQuery ? " OpenCode Go is included with OpenCode Console, not a separate provider." : ""
			}`,
			[buttonRow([actionButton("Back", id(PROVIDER_SCREEN_ID), 2)])],
		);
		return;
	}
	await answer.reply(
		goQuery
			? "OpenCode Go is included with **OpenCode Console**. Pick that connection below."
			: matches.length >= MAX_SELECT_OPTIONS
				? `**Providers matching “${query.trim()}”** (showing the first ${MAX_SELECT_OPTIONS})`
				: `**Providers matching “${query.trim()}”**`,
		[
			selectRow({
				type: 3,
				custom_id: id(SELECT_ID),
				placeholder: "Pick a provider",
				options: providerOptions(matches),
			}),
			buttonRow([actionButton("Back", id(PROVIDER_SCREEN_ID), 2)]),
		],
	);
}

/** A provider was chosen: one method starts straight away, several are offered as buttons. */
async function pickProviderMethod(request: InteractionRequest, integrationID: string): Promise<void> {
	const answer = responder(request);
	// The provider list can build the host, so ack after the one branch that
	// needs to open a modal as the initial interaction response.
	const providers = await request.session.providers();
	const provider = providers.find((candidate) => candidate.id === integrationID);
	if (!provider) {
		await answer.reply("That provider is no longer available.", [
			buttonRow([actionButton("Back", scopedId(PROVIDER_SCREEN_ID, request.dmGuildId), 2)]),
		]);
		return;
	}
	const methods = provider.methods.filter((method) => method.supported);
	if (!methods.length) {
		await answer.reply(`**${provider.name}** has no way to be connected in this deployment.`, [
			buttonRow([actionButton("Back", scopedId(PROVIDER_SCREEN_ID, request.dmGuildId), 2)]),
		]);
		return;
	}
	if (methods.length === 1) {
		const method = methods[0]!;
		if (method.type === "key") {
			await answer.modal(keyModal(request, integrationID));
			return;
		}
		await startProviderMethod(request, integrationID, method.id ?? "key");
		return;
	}
	await answer.defer();
	await answer.update(
		provider.connected
			? `**${provider.name}** is connected. How should it be reconnected?`
			: `How should **${provider.name}** be connected?`,
		[
			buttonRow(
				methods.slice(0, 5).map((method, index) =>
					actionButton(
						method.label,
						METHOD_ID.of(
							`${integrationID}:${method.type === "key" ? "key" : (method.id ?? "key")}`,
							request.dmGuildId,
						),
						index === 0 ? 1 : 2,
					),
				),
			),
			buttonRow([actionButton("Back", scopedId(PROVIDER_SCREEN_ID, request.dmGuildId), 2)]),
		],
	);
}

/** Begin a sign-in, or open the key modal; the method's type decides which. */
async function startProviderMethod(
	request: InteractionRequest,
	integrationID: string,
	methodID: string,
): Promise<void> {
	const answer = responder(request);
	if (methodID === "key") {
		await answer.modal(keyModal(request, integrationID));
		return;
	}
	await answer.defer();
	const result = await request.session.providerConnect({
		integrationID,
		methodID,
		action: "start",
		answer: {},
	});
	if (result.error || !result.url || !result.attemptID) {
		await answer.update(`Could not start the sign-in: ${result.error ?? "the provider returned no URL"}`, [
			buttonRow([actionButton("Back", scopedId(PROVIDER_SCREEN_ID, request.dmGuildId), 2)]),
		]);
		return;
	}
	// A device-code flow shows a code to type on the provider's page rather than
	// sending the browser back to us, so it finishes with a code, not a poll.
	if (result.mode === "code") {
		const buttons: DiscordButton[] = [];
		if (result.url.length <= MAX_LINK_URL) buttons.push(linkButton("Open sign-in page", result.url));
		buttons.push(actionButton("Enter code", CODE_ID.of(integrationID, request.dmGuildId), 1));
		buttons.push(actionButton("Back", scopedId(PROVIDER_SCREEN_ID, request.dmGuildId), 2));
		await answer.update(
			[
				`**${integrationID}** needs a code to finish signing in.`,
				...(result.instructions ? [result.instructions] : []),
				...(result.url.length > MAX_LINK_URL ? ["", result.url] : []),
				"",
				"Open the page, then choose **Enter code**.",
			].join("\n"),
			[buttonRow(buttons)],
		);
		return;
	}
	const buttons: DiscordButton[] = [];
	if (result.url.length <= MAX_LINK_URL) buttons.push(linkButton("Sign in", result.url));
	buttons.push(actionButton("I've finished", OAUTH_CHECK_ID.of(`${integrationID}:${result.attemptID}`, request.dmGuildId), 3));
	buttons.push(actionButton("Back", scopedId(PROVIDER_SCREEN_ID, request.dmGuildId), 2));
	await answer.update(
		[
			`**${integrationID}** signs in through your browser.`,
			...(result.instructions ? [result.instructions] : []),
			...(result.url.length > MAX_LINK_URL ? ["", result.url] : []),
			"",
			"Finish the flow, then confirm here.",
		].join("\n"),
		[buttonRow(buttons)],
	);
}

/** The "I've finished" button on a browser sign-in. */
async function checkSignIn(request: InteractionRequest, integrationID: string, attemptID: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const result = await request.session.providerConnect({ integrationID, attemptID, action: "status" });
	const status = result.status?.status ?? "pending";
	if (status === "complete") {
		await modelScreen(request);
		return;
	}
	if (status === "failed" || status === "expired") {
		await answer.update(
			`The sign-in did not complete: ${result.status?.message ?? "the provider gave no reason"}. Start it again from **Providers**.`,
			[buttonRow([actionButton("Back", scopedId(PROVIDER_SCREEN_ID, request.dmGuildId), 2)])],
		);
		return;
	}
	await answer.update(
		`Sign-in status: **${status}**${result.status?.message ? ` — ${result.status.message}` : ""}. Finish the flow, then press **I've finished** again.`,
		[
			buttonRow([
				actionButton("I've finished", OAUTH_CHECK_ID.of(`${integrationID}:${attemptID}`, request.dmGuildId), 3),
				actionButton("Back", scopedId(PROVIDER_SCREEN_ID, request.dmGuildId), 2),
			]),
		],
	);
}

/** Finish a device-code sign-in with the code the provider showed. */
async function completeSignIn(request: InteractionRequest, integrationID: string, code: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const trimmed = code.trim();
	if (!trimmed) {
		await answer.reply("No code was provided.", [
			buttonRow([
				actionButton("Try again", CODE_ID.of(integrationID, request.dmGuildId), 2),
				actionButton("Back", scopedId(PROVIDER_SCREEN_ID, request.dmGuildId), 2),
			]),
		]);
		return;
	}
	const result = await request.session.providerConnect({
		integrationID,
		action: "complete",
		code: trimmed,
	});
	if (result.error) {
		await answer.reply(`Could not finish **${integrationID}**: ${result.error}`, [
			buttonRow([
				actionButton("Try again", CODE_ID.of(integrationID, request.dmGuildId), 2),
				actionButton("Back", scopedId(PROVIDER_SCREEN_ID, request.dmGuildId), 2),
			]),
		]);
		return;
	}
	await modelScreen(request);
}

/** Finish a key connection from the modal the method picker raised. */
async function connectWithKey(request: InteractionRequest, integrationID: string, key: string): Promise<void> {
	const answer = responder(request);
	if (!key) {
		await answer.reply("No key was provided.", [
			buttonRow([
				actionButton("Try again", KEY_ID.of(integrationID, request.dmGuildId), 2),
				actionButton("Back", scopedId(PROVIDER_SCREEN_ID, request.dmGuildId), 2),
			]),
		]);
		return;
	}
	// Connecting can build the host and reconcile the model, which can outlast
	// Discord's three second window for a modal submit.
	await answer.defer();
	const result = await request.session.providerConnect({ integrationID, key, methodID: "key" });
	if (result.error) {
		await answer.reply(`Could not connect **${integrationID}**: ${result.error}`, [
			buttonRow([
				actionButton("Try again", KEY_ID.of(integrationID, request.dmGuildId), 2),
				actionButton("Back", scopedId(PROVIDER_SCREEN_ID, request.dmGuildId), 2),
			]),
		]);
		return;
	}
	await modelScreen(request);
}

async function promptRemoveProvider(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const id = (base: string) => scopedId(base, request.dmGuildId);
	const status = await request.session.config().catch(() => undefined);
	if (!status) {
		await answer.reply("Eryn could not read this server's providers right now. Try again in a moment.", [
			buttonRow([actionButton("Back", id(PROVIDER_SCREEN_ID), 2)]),
		]);
		return;
	}
	const providers = status.providers;
	if (!providers.length) {
		await answer.reply("No providers are connected to this server.", [
			buttonRow([actionButton("Back", id(PROVIDER_SCREEN_ID), 2)]),
		]);
		return;
	}
	if (providers.length === 1) {
		await confirmProviderRemoval(request, providers[0]!.integrationID);
		return;
	}
	await answer.reply("Which provider should I remove?", [
		selectRow({
			type: 3,
			custom_id: REMOVE_SELECT_ID,
			placeholder: "Pick a provider",
			options: providers.slice(0, MAX_SELECT_OPTIONS).map((provider) => ({
				label: provider.integrationID.slice(0, 100),
				value: provider.integrationID,
				description: provider.method.slice(0, 100),
			})),
		}),
		buttonRow([actionButton("Cancel", id(PROVIDER_SCREEN_ID), 2)]),
	]);
}

async function confirmProviderRemoval(request: InteractionRequest, integrationID: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	if (!integrationID) {
		await answer.reply("No provider was selected.");
		return;
	}
	await answer.reply(`Remove **${integrationID}**? Eryn will stop using it immediately.`, [
		buttonRow([
			actionButton("Remove", REMOVE_CONFIRM_ID.of(integrationID, request.dmGuildId), 4),
			actionButton("Cancel", scopedId(PROVIDER_SCREEN_ID, request.dmGuildId), 2),
		]),
	]);
}

async function removeProvider(request: InteractionRequest, integrationID: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	try {
		await request.session.disconnectProvider(integrationID);
	} catch (error) {
		await answer.reply(`Could not remove **${integrationID}**: ${describeError(error)}`, [
			buttonRow([
				actionButton("Try again", REMOVE_CONFIRM_ID.of(integrationID, request.dmGuildId), 4),
				actionButton("Back", scopedId(PROVIDER_SCREEN_ID, request.dmGuildId), 2),
			]),
		]);
		return;
	}
	const status = await request.session.config().catch(() => undefined);
	await answer.reply(
		[
			`Removed **${integrationID}**.`,
			...(status?.ready === false ? ["No provider is connected now, so Eryn cannot run until you connect another."] : []),
		].join("\n"),
		[
			buttonRow([
				actionButton("Back", scopedId(PROVIDER_SCREEN_ID, request.dmGuildId), 2),
				actionButton("Close", scopedId(SETUP_CLOSE_ID, request.dmGuildId), 2),
			]),
		],
	);
}

export async function providerComponent(
	request: InteractionRequest,
	customId: string,
	values: readonly string[],
): Promise<boolean> {
	const pick = PICK_ID.read(customId);
	if (pick !== undefined) {
		await guarded(request, "update", () => pickProviderMethod(request, pick));
		return true;
	}
	const removeConfirm = REMOVE_CONFIRM_ID.read(customId);
	if (removeConfirm !== undefined) {
		await guarded(request, "update", () => removeProvider(request, removeConfirm));
		return true;
	}
	const method = METHOD_ID.read(customId);
	if (method !== undefined) {
		const [integrationID, methodID] = method.split(":");
		await guarded(request, "update", () => startProviderMethod(request, integrationID ?? "", methodID ?? "key"));
		return true;
	}
	const oauthCheck = OAUTH_CHECK_ID.read(customId);
	if (oauthCheck !== undefined) {
		const [integrationID, attemptID] = oauthCheck.split(":");
		await guarded(request, "update", () => checkSignIn(request, integrationID ?? "", attemptID ?? ""));
		return true;
	}
	// The "Enter code" button carries the same id as the modal it opens, so the
	// same codec addresses both the click and the submit.
	const code = CODE_ID.read(customId);
	if (code !== undefined) {
		await guarded(request, "reply", () => responder(request).modal(codeModal(request, code)));
		return true;
	}
	// Likewise the "Try again" button on a failed key connection.
	const key = KEY_ID.read(customId);
	if (key !== undefined) {
		await guarded(request, "reply", () => responder(request).modal(keyModal(request, key)));
		return true;
	}
	switch (customId) {
		case PROVIDER_SCREEN_ID:
			await guarded(request, "update", () => providerScreen(request));
			return true;
		case SELECT_ID:
			await guarded(request, "update", () => pickProviderMethod(request, values[0] ?? ""));
			return true;
		case SEARCH_ID:
			await guarded(request, "reply", () => responder(request).modal(providerSearchModal(request)));
			return true;
		case REMOVE_PROVIDER_ID:
			await guarded(request, "update", () => promptRemoveProvider(request));
			return true;
		case REMOVE_SELECT_ID:
			await guarded(request, "update", () => confirmProviderRemoval(request, values[0] ?? ""));
			return true;
	}
	return false;
}

export async function providerModal(
	request: InteractionRequest,
	customId: string,
	values: Record<string, string>,
): Promise<boolean> {
	const key = KEY_ID.read(customId);
	if (key !== undefined) {
		await guarded(request, "reply", () => connectWithKey(request, key, values.key?.trim() ?? ""));
		return true;
	}
	const code = CODE_ID.read(customId);
	if (code !== undefined) {
		await guarded(request, "reply", () => completeSignIn(request, code, values.code ?? ""));
		return true;
	}
	if (customId === SEARCH_ID) {
		await guarded(request, "reply", () => searchProviders(request, values.query ?? ""));
		return true;
	}
	return false;
}
