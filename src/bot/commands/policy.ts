/**
 * `/eryn policy`: restrict what the agent may do in this channel or thread.
 *
 * The menu is contextual. Run in a thread, it edits the thread; run in a
 * channel, it edits the channel. Presets are one click, and the customise path
 * is two selects (group, then effect), which keeps every screen inside Discord's
 * five-row limit without exposing OpenCode's rule syntax.
 */

import { describeError } from "../../errors";
import {
	actionButton,
	buttonRow,
	selectRow,
	type DiscordSelectOption,
} from "../../discord/components";
import {
	GROUP_LABELS,
	MCP_ALL,
	POLICY_GROUPS,
	PRESET_LABELS,
	matchPreset,
	policyTitle,
	summaryLines,
	type PolicyGroup,
} from "../../session/policy";
import type { Policy, PolicyEffect, PolicyPreset, PolicyState } from "../../session/models";
import {
	claim,
	closeRow,
	responder,
	MAX_SELECT_OPTIONS,
	type InteractionRequest,
} from "./interaction";

export const POLICY_MENU_ID = "policy:menu";
const PRESET_ID = "policy:preset:";
const CUSTOMISE_ID = "policy:customise";
const RESET_ID = "policy:reset";
const CLOSE_ID = "policy:close";
const GROUP_ID = "policy:group:";
const EFFECT_ID = "policy:effect:";
const BACK_ID = "policy:customise";

interface Target {
	readonly channelId: string;
	readonly threadId?: string;
	/** "this thread" or "#channel". */
	readonly label: string;
}

/** Where the interaction happened, which is the scope it configures. */
async function targetOf(request: InteractionRequest): Promise<Target | undefined> {
	const channelId = request.interaction.channel_id;
	if (!channelId) return undefined;
	const channel = await request.ctx.rest.channel(channelId).catch(() => undefined);
	if (!channel) return undefined;
	// A normal channel also has a parent_id: its category. Only Discord's thread
	// types (public, private, announcement) are a thread scope.
	if ([10, 11, 12].includes(channel.type)) {
		return { channelId: channel.parent_id ?? channelId, threadId: channelId, label: "this thread" };
	}
	return { channelId, label: `#${channel.name ?? "channel"}` };
}

function stateRequest(target: Target) {
	return {
		channelId: target.channelId,
		...(target.threadId ? { threadId: target.threadId } : {}),
	};
}

function scopeRequest(target: Target) {
	return {
		scope: target.threadId ? ("thread" as const) : ("channel" as const),
		...stateRequest(target),
	};
}

export async function policyMenu(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	// The public policy card opens a fresh ephemeral menu; editing it in place
	// would show the configuration to everyone in the channel.
	const publicSource =
		request.interaction.type === 3 &&
		request.interaction.guild_id !== undefined &&
		((request.interaction.message?.flags ?? 0) & 64) === 0;
	if (publicSource) await answer.deferNew();
	else await answer.defer();
	const target = await targetOf(request);
	if (!target) {
		await answer.reply("Run `/eryn policy` in a channel or thread.", [closeRow(request)]);
		return;
	}
	const state = await request.session.policy(stateRequest(target));
	await answer.reply(renderMenu(state, target), menuRows(request, state));
}

function renderMenu(state: PolicyState, target: Target): string {
	const own = state.own !== undefined;
	const text = [
		`**Permissions in ${target.label}**`,
		`${own ? "This scope overrides its parent." : "This scope inherits from its parent."} Currently: **${policyTitle(state.effective)}**.`,
		"",
		...summaryLines(state.effective, state.mcpServers),
		"",
		`Presets: ${(Object.keys(PRESET_LABELS) as PolicyPreset[])
			.map((preset) => `**${PRESET_LABELS[preset]}**`)
			.join(" · ")}`,
	].join("\n");
	return text.length > 1_900 ? `${text.slice(0, 1_899)}…` : text;
}

function menuRows(request: InteractionRequest, state: PolicyState) {
	const active = matchPreset(state.effective);
	const presets = (Object.keys(PRESET_LABELS) as PolicyPreset[]).map((preset) =>
		actionButton(PRESET_LABELS[preset], `${PRESET_ID}${preset}`, active === preset ? 1 : 2),
	);
	const actions = [
		actionButton("Customise", CUSTOMISE_ID, 2),
		actionButton("Reset to inherit", RESET_ID, 2, state.own === undefined),
		actionButton("Close", CLOSE_ID, 2),
	];
	return [buttonRow(presets), buttonRow(actions)];
}

async function applyPreset(request: InteractionRequest, preset: PolicyPreset): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const target = await targetOf(request);
	if (!target) return;
	try {
		await request.session.setPolicy({ ...scopeRequest(target), policy: { preset } });
	} catch (error) {
		await answer.update(`Could not change the policy: ${describeError(error)}`, [closeRow(request)]);
		return;
	}
	const state = await request.session.policy(stateRequest(target));
	await answer.update(renderMenu(state, target), menuRows(request, state));
}

async function customise(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const target = await targetOf(request);
	if (!target) return;
	const state = await request.session.policy(stateRequest(target));
	await answer.update(
		[
			`**Customise permissions in ${target.label}**`,
			"Pick a group, then choose what Eryn may do with it.",
		].join("\n"),
		[
			selectRow({
				type: 3,
				custom_id: `${GROUP_ID}pick`,
				placeholder: "Pick a group",
				options: groupOptions(state),
			}),
			buttonRow([actionButton("Back", BACK_ID, 2), actionButton("Close", CLOSE_ID, 2)]),
		],
	);
}

function groupOptions(state: PolicyState): DiscordSelectOption[] {
	const options: DiscordSelectOption[] = POLICY_GROUPS.map((group) => ({
		label: GROUP_LABELS[group],
		value: group,
		description: `Currently ${effectWord(state.effective.tools?.[group])}`.slice(0, 100),
	}));
	const mcpAll = state.effective.mcp?.[MCP_ALL] ?? "allow";
	options.push({
		label: "All MCP servers",
		value: "mcp",
		description: `Currently ${effectWord(mcpAll)}`.slice(0, 100),
	});
	for (const server of state.mcpServers) {
		options.push({
			label: server.slice(0, 100),
			value: `mcp:${server}`,
			description: `Currently ${effectWord(state.effective.mcp?.[server] ?? mcpAll)}`.slice(0, 100),
		});
	}
	return options.slice(0, MAX_SELECT_OPTIONS);
}

function effectWord(effect: PolicyEffect | undefined): string {
	return effect === "block" ? "blocked" : effect === "ask" ? "asks first" : "allowed";
}

function groupTitle(key: string): string {
	if (key === "mcp") return "All MCP servers";
	if (key.startsWith("mcp:")) return key.slice(4);
	return GROUP_LABELS[key as PolicyGroup] ?? key;
}

function currentEffect(state: PolicyState, key: string): PolicyEffect {
	if (key === "mcp") return state.effective.mcp?.[MCP_ALL] ?? "allow";
	if (key.startsWith("mcp:")) return state.effective.mcp?.[key.slice(4)] ?? state.effective.mcp?.[MCP_ALL] ?? "allow";
	return state.effective.tools?.[key] ?? "allow";
}

async function groupScreen(request: InteractionRequest, key: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const target = await targetOf(request);
	if (!target) return;
	const state = await request.session.policy(stateRequest(target));
	await answer.update(
		[
			`**${groupTitle(key)}**`,
			`Currently **${effectWord(currentEffect(state, key))}** in ${target.label}.`,
			"",
			"**Allow** runs it. **Ask** posts a card first. **Block** hides it from the agent.",
		].join("\n"),
		[
			buttonRow([
				actionButton("Allow", `${EFFECT_ID}${key}:allow`, 3),
				actionButton("Ask", `${EFFECT_ID}${key}:ask`, 2),
				actionButton("Block", `${EFFECT_ID}${key}:block`, 4),
			]),
			buttonRow([
				actionButton("Use preset", `${EFFECT_ID}${key}:inherit`, 2),
				actionButton("Back", BACK_ID, 2),
				actionButton("Close", CLOSE_ID, 2),
			]),
		],
	);
}

async function applyEffect(
	request: InteractionRequest,
	key: string,
	effect: PolicyEffect | "inherit",
): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const target = await targetOf(request);
	if (!target) return;
	const state = await request.session.policy(stateRequest(target));
	const tools: Record<string, PolicyEffect> = { ...(state.own?.tools ?? {}) };
	const mcp: Record<string, PolicyEffect> = { ...(state.own?.mcp ?? {}) };

	if (key === "mcp") {
		if (effect === "inherit") delete mcp[MCP_ALL];
		else mcp[MCP_ALL] = effect;
	} else if (key.startsWith("mcp:")) {
		const server = key.slice(4);
		if (effect === "inherit") delete mcp[server];
		else mcp[server] = effect;
	} else {
		if (effect === "inherit") delete tools[key];
		else tools[key] = effect;
	}

	const own = state.own
		? {
				...(state.own.preset ? { preset: state.own.preset } : {}),
				...(state.own.elicitation ? { elicitation: state.own.elicitation } : {}),
			}
		: {};
	const patch: Policy = {
		...own,
		...(Object.keys(tools).length ? { tools } : {}),
		...(Object.keys(mcp).length ? { mcp } : {}),
	};

	try {
		await request.session.setPolicy({ ...scopeRequest(target), policy: patch });
	} catch (error) {
		await answer.update(`Could not change the policy: ${describeError(error)}`, [closeRow(request)]);
		return;
	}
	const next = await request.session.policy(stateRequest(target));
	await answer.update(renderMenu(next, target), menuRows(request, next));
}

async function reset(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const target = await targetOf(request);
	if (!target) return;
	try {
		await request.session.clearPolicy(scopeRequest(target));
	} catch (error) {
		await answer.update(`Could not reset the policy: ${describeError(error)}`, [closeRow(request)]);
		return;
	}
	const state = await request.session.policy(stateRequest(target));
	await answer.update(renderMenu(state, target), menuRows(request, state));
}

/** Every id this screen owns. Return `true` so the dispatcher stops. */
export async function policyComponent(
	request: InteractionRequest,
	customId: string,
	values: readonly string[],
): Promise<boolean> {
	if (customId === POLICY_MENU_ID) return await claim(request, "update", () => policyMenu(request));
	if (customId === CUSTOMISE_ID) return await claim(request, "update", () => customise(request));
	if (customId === RESET_ID) return await claim(request, "update", () => reset(request));
	if (customId === CLOSE_ID) {
		await responder(request).close().catch(() => undefined);
		return true;
	}
	if (customId.startsWith(PRESET_ID)) {
		const value = customId.slice(PRESET_ID.length) as PolicyPreset;
		if (value in PRESET_LABELS) return await claim(request, "update", () => applyPreset(request, value));
	}
	if (customId === `${GROUP_ID}pick`) {
		const key = values[0];
		if (key) return await claim(request, "update", () => groupScreen(request, key));
	}
	if (customId.startsWith(EFFECT_ID)) {
		const rest = customId.slice(EFFECT_ID.length);
		const separator = rest.lastIndexOf(":");
		if (separator > 0) {
			const key = rest.slice(0, separator);
			const effect = rest.slice(separator + 1);
			if (effect === "allow" || effect === "ask" || effect === "block" || effect === "inherit") {
				return await claim(request, "update", () => applyEffect(request, key, effect));
			}
		}
	}
	return false;
}
