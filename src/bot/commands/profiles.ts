/**
 * Permission profiles at the server level.
 *
 * A profile is a named permission set every channel can select. Standard, Full,
 * and None are built in; a server admin can add custom profiles from the setup
 * menu and then choose one per channel with `/eryn policy`.
 */

import { describeError } from "../../errors";
import {
	actionButton,
	buttonRow,
	selectRow,
	type DiscordActionRow,
	type DiscordButton,
	type DiscordModal,
	type DiscordSelectOption,
} from "../../discord/components";
import type { Policy, PolicyEffect, PolicyPreset, ProfilesState } from "../../session/models";
import {
	DEFAULT_PROFILE,
	GROUP_LABELS,
	MCP_ALL,
	POLICY_GROUPS,
	PRESET_HINTS,
	profileDefinition,
	summaryLines,
} from "../../session/policy";
import { SETUP_CLOSE_ID, SETUP_MENU_ID } from "../ids";
import {
	MAX_SELECT_OPTIONS,
	claim,
	closeRow,
	removeRow,
	responder,
	textInput,
	textModal,
	type InteractionRequest,
} from "./interaction";

/** The setup menu's permissions button, owned here so this screen can re-render itself. */
export const PROFILES_SCREEN_ID = `${SETUP_MENU_ID}:profiles`;

const DEFAULT_SELECT_ID = "setup:profiles:default";
const MANAGE_ID = "setup:profiles:manage";
const MANAGE_SELECT_ID = "setup:profiles:manage:select";
const NEW_ID = "setup:profiles:new";
const NEW_MODAL_ID = "setup:profiles:new:modal";
const GROUP_SELECT_ID = "setup:profiles:group";
const DETAIL_PREFIX = "setup:profiles:detail:";
const RENAME_PREFIX = "setup:profiles:rename:";
const DELETE_PREFIX = "setup:profiles:delete:";
const DELETE_CONFIRM_PREFIX = "setup:profiles:deleteconfirm:";
const EFFECT_PREFIX = "setup:profiles:effect:";

function customProfiles(state: ProfilesState) {
	return state.profiles.filter((profile) => !profile.builtin);
}

function hint(profile: ProfilesState["profiles"][number]): string {
	return PRESET_HINTS[profile.id as PolicyPreset] ?? "Custom profile";
}

function profileOptions(state: ProfilesState): DiscordSelectOption[] {
	return state.profiles.slice(0, MAX_SELECT_OPTIONS).map((profile) => ({
		label: profile.name,
		value: profile.id,
		description: hint(profile).slice(0, 100),
		default: profile.id === state.defaultProfile,
	}));
}

function profileScreenText(state: ProfilesState): string {
	const fallback = state.profiles.find((profile) => profile.id === state.defaultProfile);
	const lines = [
		`**Default profile: ${fallback?.name ?? state.defaultProfile}**`,
		"Every channel uses this profile unless it has its own override.",
		"",
		...state.profiles.map(
			(profile) => `**${profile.name}**${profile.builtin ? "" : " (custom)"} — ${hint(profile)}`,
		),
	];
	const text = lines.join("\n");
	return text.length > 1_900 ? `${text.slice(0, 1_899)}…` : text;
}

export async function profileScreen(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	if (request.dmGuildId) {
		await answer.update("Manage permission profiles from the server with `/eryn setup`.", [
			closeRow(request),
		]);
		return;
	}
	const state = await request.session.profiles();
	const buttons: DiscordButton[] = [actionButton("New profile", NEW_ID, 1)];
	if (customProfiles(state).length) buttons.push(actionButton("Edit custom", MANAGE_ID, 2));
	buttons.push(actionButton("Back", SETUP_MENU_ID, 2), actionButton("Close", SETUP_CLOSE_ID, 2));
	await answer.update(profileScreenText(state), [
		selectRow({
			type: 3,
			custom_id: DEFAULT_SELECT_ID,
			placeholder: "Default profile for this server",
			options: profileOptions(state),
		}),
		buttonRow(buttons),
	]);
}

async function setDefault(request: InteractionRequest, id: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	try {
		await request.session.setDefaultProfile(id);
	} catch (error) {
		await answer.update(`Could not change the default profile: ${describeError(error)}`, [
			closeRow(request),
		]);
		return;
	}
	const state = await request.session.profiles();
	await answer.update(profileScreenText(state), [
		selectRow({
			type: 3,
			custom_id: DEFAULT_SELECT_ID,
			placeholder: "Default profile for this server",
			options: profileOptions(state),
		}),
		buttonRow([
			actionButton("New profile", NEW_ID, 1),
			...(customProfiles(state).length ? [actionButton("Edit custom", MANAGE_ID, 2)] : []),
			actionButton("Back", SETUP_MENU_ID, 2),
			actionButton("Close", closeId(), 2),
		]),
	]);
}

async function manage(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const state = await request.session.profiles();
	const custom = customProfiles(state);
	if (!custom.length) {
		await answer.update("There are no custom profiles yet.", [
			buttonRow([actionButton("Back", PROFILES_SCREEN_ID, 2), actionButton("Close", closeId(), 2)]),
		]);
		return;
	}
	await answer.update("Pick a profile to edit.", [
		selectRow({
			type: 3,
			custom_id: MANAGE_SELECT_ID,
			placeholder: "Custom profile",
			options: custom.slice(0, MAX_SELECT_OPTIONS).map((profile) => ({
				label: profile.name,
				value: profile.id,
			})),
		}),
		buttonRow([actionButton("Back", PROFILES_SCREEN_ID, 2), actionButton("Close", closeId(), 2)]),
	]);
}

function closeId(): string {
	return SETUP_CLOSE_ID;
}

async function detail(request: InteractionRequest, id: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const state = await request.session.profiles();
	const profile = state.profiles.find((candidate) => candidate.id === id);
	if (!profile) {
		await answer.update("That profile no longer exists.", [
			buttonRow([actionButton("Back", PROFILES_SCREEN_ID, 2), actionButton("Close", closeId(), 2)]),
		]);
		return;
	}
	const lines = [
		`**${profile.name}**${profile.builtin ? " (built-in)" : ""}`,
		profile.builtin
			? "Built-in profiles can be used as the server default or per channel, but not edited."
			: "A custom profile. It can be selected as the server default or per channel.",
		"",
		...summaryLines({ tools: profile.tools, mcp: profile.mcp } as Policy, []),
	];
	const text = lines.join("\n");
	const rows: DiscordActionRow[] = [];
	if (profile.builtin) {
		rows.push(
			buttonRow([actionButton("Back", PROFILES_SCREEN_ID, 2), actionButton("Close", closeId(), 2)]),
		);
	} else {
		rows.push(
			selectRow({
				type: 3,
				custom_id: GROUP_SELECT_ID,
				placeholder: "Edit a permission group",
				options: groupOptions(profile),
			}),
			buttonRow([
				actionButton("Rename", `${RENAME_PREFIX}${profile.id}`, 2),
				actionButton("Delete", `${DELETE_PREFIX}${profile.id}`, 4),
				actionButton("Back", PROFILES_SCREEN_ID, 2),
				actionButton("Close", closeId(), 2),
			]),
		);
	}
	await answer.update(text.length > 1_900 ? `${text.slice(0, 1_899)}…` : text, rows);
}

function groupOptions(profile: ProfilesState["profiles"][number]): DiscordSelectOption[] {
	const options: DiscordSelectOption[] = POLICY_GROUPS.map((group) => ({
		label: GROUP_LABELS[group],
		value: `${profile.id}:${group}`,
		description: `Currently ${effectWord(profile.tools[group])}`.slice(0, 100),
	}));
	options.push({
		label: "All MCP servers",
		value: `${profile.id}:mcp`,
		description: `Currently ${effectWord(profile.mcp[MCP_ALL])}`.slice(0, 100),
	});
	return options.slice(0, MAX_SELECT_OPTIONS);
}

function effectWord(effect: PolicyEffect | undefined): string {
	return effect === "block" ? "blocked" : effect === "ask" ? "asks first" : "allowed";
}

function groupTitle(key: string): string {
	return key === "mcp" ? "All MCP servers" : (GROUP_LABELS[key as keyof typeof GROUP_LABELS] ?? key);
}

function currentEffect(profile: ProfilesState["profiles"][number], key: string): PolicyEffect {
	return key === "mcp" ? (profile.mcp[MCP_ALL] ?? "allow") : (profile.tools[key] ?? "allow");
}

async function groupScreen(request: InteractionRequest, id: string, key: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const state = await request.session.profiles();
	const profile = state.profiles.find((candidate) => candidate.id === id);
	if (!profile || profile.builtin) {
		await detail(request, id);
		return;
	}
	await answer.update(
		[
			`**${groupTitle(key)} in ${profile.name}**`,
			`Currently **${effectWord(currentEffect(profile, key))}**.`,
			"",
			"**Allow** runs it. **Ask** posts a card first. **Block** hides it from the agent.",
		].join("\n"),
		[
			buttonRow([
				actionButton("Allow", `${EFFECT_PREFIX}${id}:${key}:allow`, 3),
				actionButton("Ask", `${EFFECT_PREFIX}${id}:${key}:ask`, 2),
				actionButton("Block", `${EFFECT_PREFIX}${id}:${key}:block`, 4),
			]),
			buttonRow([
				actionButton("Back", `${DETAIL_PREFIX}${id}`, 2),
				actionButton("Close", closeId(), 2),
			]),
		],
	);
}

async function applyEffect(
	request: InteractionRequest,
	id: string,
	key: string,
	effect: PolicyEffect,
): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const state = await request.session.profiles();
	const profile = state.profiles.find((candidate) => candidate.id === id);
	if (!profile || profile.builtin) {
		await detail(request, id);
		return;
	}
	const tools = { ...profile.tools };
	const mcp = { ...profile.mcp };
	if (key === "mcp") mcp[MCP_ALL] = effect;
	else tools[key] = effect;
	try {
		await request.session.putProfile({ id, name: profile.name, tools, mcp });
	} catch (error) {
		await answer.update(`Could not change the profile: ${describeError(error)}`, [closeRow(request)]);
		return;
	}
	await detail(request, id);
}

function slug(name: string): string {
	const base =
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 24) || "profile";
	return `${base}-${Date.now().toString(36)}`;
}

function newProfileModal(request: InteractionRequest): DiscordModal {
	return textModal(request.id(NEW_MODAL_ID), "New permission profile", [
		textInput({
			custom_id: "name",
			label: "Profile name",
			required: true,
			max_length: 60,
			placeholder: "For example, Research",
		}),
	]);
}

function renameModal(request: InteractionRequest, id: string): DiscordModal {
	return textModal(request.id(`${RENAME_PREFIX}${id}:modal`), "Rename profile", [
		textInput({
			custom_id: "name",
			label: "Profile name",
			required: true,
			max_length: 60,
		}),
	]);
}

async function createProfile(request: InteractionRequest, name: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const state = await request.session.profiles();
	const custom = customProfiles(state);
	const base =
		profileDefinition(state.defaultProfile, custom) ?? profileDefinition(DEFAULT_PROFILE, custom);
	const id = slug(name);
	try {
		await request.session.putProfile({
			id,
			name: name.trim().slice(0, 60),
			tools: base?.tools ?? {},
			mcp: base?.mcp ?? {},
		});
	} catch (error) {
		await answer.reply(`Could not create the profile: ${describeError(error)}`, [closeRow(request)]);
		return;
	}
	await detail(request, id);
}

async function renameProfile(request: InteractionRequest, id: string, name: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const state = await request.session.profiles();
	const profile = state.profiles.find((candidate) => candidate.id === id);
	if (!profile || profile.builtin) {
		await answer.reply("That profile no longer exists.", [closeRow(request)]);
		return;
	}
	try {
		await request.session.putProfile({
			id,
			name: name.trim().slice(0, 60),
			tools: profile.tools,
			mcp: profile.mcp,
		});
	} catch (error) {
		await answer.reply(`Could not rename the profile: ${describeError(error)}`, [closeRow(request)]);
		return;
	}
	await detail(request, id);
}

async function confirmDelete(request: InteractionRequest, id: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const state = await request.session.profiles();
	const profile = state.profiles.find((candidate) => candidate.id === id);
	if (!profile || profile.builtin) {
		await answer.update("That profile cannot be removed.", [closeRow(request)]);
		return;
	}
	await answer.update(
		`Delete **${profile.name}**? Channels using it fall back to **Standard**.`,
		[
			removeRow(request, request.id(`${DELETE_CONFIRM_PREFIX}${id}`), PROFILES_SCREEN_ID),
		],
	);
}

async function removeProfile(request: InteractionRequest, id: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	try {
		await request.session.removeProfile(id);
	} catch (error) {
		await answer.update(`Could not remove the profile: ${describeError(error)}`, [closeRow(request)]);
		return;
	}
	await profileScreen(request);
}

/** Every id this screen owns. Return `true` so the dispatcher stops. */
export async function profileComponent(
	request: InteractionRequest,
	customId: string,
	values: readonly string[],
): Promise<boolean> {
	if (customId === PROFILES_SCREEN_ID) return await claim(request, "update", () => profileScreen(request));
	if (customId === MANAGE_ID) return await claim(request, "update", () => manage(request));
	if (customId === NEW_ID) {
		await responder(request).modal(newProfileModal(request)).catch(() => undefined);
		return true;
	}
	if (customId === DEFAULT_SELECT_ID) {
		const id = values[0];
		if (id) return await claim(request, "update", () => setDefault(request, id));
	}
	if (customId === MANAGE_SELECT_ID) {
		const id = values[0];
		if (id) return await claim(request, "update", () => detail(request, id));
	}
	if (customId === GROUP_SELECT_ID) {
		const value = values[0];
		if (value) {
			const separator = value.lastIndexOf(":");
			if (separator > 0) {
				const id = value.slice(0, separator);
				const key = value.slice(separator + 1);
				return await claim(request, "update", () => groupScreen(request, id, key));
			}
		}
	}
	if (customId.startsWith(DELETE_CONFIRM_PREFIX)) {
		const id = customId.slice(DELETE_CONFIRM_PREFIX.length);
		if (id) return await claim(request, "update", () => removeProfile(request, id));
	}
	if (customId.startsWith(DELETE_PREFIX)) {
		const id = customId.slice(DELETE_PREFIX.length);
		if (id) return await claim(request, "update", () => confirmDelete(request, id));
	}
	if (customId.startsWith(RENAME_PREFIX) && !customId.endsWith(":modal")) {
		const id = customId.slice(RENAME_PREFIX.length);
		if (id) {
			await responder(request).modal(renameModal(request, id)).catch(() => undefined);
			return true;
		}
	}
	if (customId.startsWith(DETAIL_PREFIX)) {
		const id = customId.slice(DETAIL_PREFIX.length);
		if (id) return await claim(request, "update", () => detail(request, id));
	}
	if (customId.startsWith(EFFECT_PREFIX)) {
		const rest = customId.slice(EFFECT_PREFIX.length);
		const last = rest.lastIndexOf(":");
		const second = rest.lastIndexOf(":", last - 1);
		if (second > 0) {
			const id = rest.slice(0, second);
			const key = rest.slice(second + 1, last);
			const effect = rest.slice(last + 1);
			if (effect === "allow" || effect === "ask" || effect === "block") {
				return await claim(request, "update", () => applyEffect(request, id, key, effect));
			}
		}
	}
	return false;
}

/** Modal submissions: a new profile, or a rename. */
export async function profileModal(
	request: InteractionRequest,
	customId: string,
	values: Record<string, string>,
): Promise<boolean> {
	if (customId === NEW_MODAL_ID) {
		return await claim(request, "reply", () => createProfile(request, values.name ?? ""));
	}
	if (customId.startsWith(RENAME_PREFIX) && customId.endsWith(":modal")) {
		const id = customId.slice(RENAME_PREFIX.length, -":modal".length);
		if (id) {
			return await claim(request, "reply", () =>
				renameProfile(request, id, values.name ?? ""),
			);
		}
	}
	return false;
}
