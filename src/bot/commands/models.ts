/**
 * Choosing the model: the catalogue select, a search over it, and a free-form
 * reference for anything the catalogue does not list.
 */

import {
	actionButton,
	buttonRow,
	selectRow,
	type DiscordSelectOption,
	type DiscordModal,
} from "../../discord/components";
import type { ModelOption } from "../../session/models";
import { describeError } from "../../errors";
import { SETUP_CLOSE_ID, SETUP_MENU_ID } from "../ids";
import {
	claim,
	responder,
	backRow,
	retryRow,
	textInput,
	textModal,
	MAX_SELECT_OPTIONS,
	type InteractionRequest,
} from "./interaction";

/** The setup menu's "Choose model" button, owned here so this module can re-render itself. */
export const MODEL_SCREEN_ID = `${SETUP_MENU_ID}:model`;

const SELECT_ID = "setup:model";
const MANUAL_ID = "setup:model:manual";
const MODAL_ID = "setup:model:modal";
const SEARCH_ID = "setup:model:search";
const SEARCH_MODAL_ID = "setup:model:search:modal";

/** The model select's entries, in catalogue order, with the current one preselected. */
function modelOptions(models: readonly ModelOption[], current: string | undefined): DiscordSelectOption[] {
	return models.slice(0, MAX_SELECT_OPTIONS).map((model) => ({
		label: model.name.slice(0, 100),
		value: model.id,
		// Status is only interesting when the model is not plain "available".
		description: [model.provider, ["alpha", "beta"].includes(model.status) ? model.status : undefined]
			.filter(Boolean)
			.join(" · ")
			.slice(0, 100),
		...(model.id === current ? { default: true } : {}),
	}));
}

function modelModal(request: InteractionRequest): DiscordModal {
	return textModal(request.id(MODAL_ID), "Choose a model", [
		textInput({
			custom_id: "model",
			label: "Model reference",
			required: true,
			max_length: 200,
			placeholder: "opencode-go/deepseek-v4.1-flash",
		}),
	]);
}

function modelSearchModal(request: InteractionRequest): DiscordModal {
	return textModal(request.id(SEARCH_MODAL_ID), "Search models", [
		textInput({
			custom_id: "query",
			label: "Model name, id, or provider",
			required: true,
			max_length: 100,
			placeholder: "claude, gpt-5, opencode-go",
		}),
	]);
}

/** The model catalogue, limited to models from a provider this server connected. */
async function connectedModels(request: InteractionRequest): Promise<ModelOption[]> {
	// Only models from a connected provider can run; offering the rest is how a
	// guild ends up selecting `opencode-go/...` with only `opencode` connected.
	return (await request.session.models()).filter((model) => model.connected);
}

/** The picker buttons shared by the catalogue, search results, and failures. */
function searchRow(request: InteractionRequest) {
	return buttonRow([
		actionButton("Search models", request.id(SEARCH_ID), 2),
		actionButton("Enter a model reference", request.id(MANUAL_ID), 2),
		actionButton("Back", request.id(SETUP_MENU_ID), 2),
	]);
}

export async function modelScreen(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const models = await connectedModels(request);
	// A catalogue with connected models means a provider is in place, so the
	// public install greeting has done its job. Dismiss it even if the admin
	// wanders off before picking a model.
	if (models.length) await request.ctx.dismissGreeting(request.guildId).catch(() => undefined);
	if (!models.length) {
		const status = await request.session.config().catch(() => undefined);
		const connected = status?.providers.map((provider) => provider.integrationID) ?? [];
		await answer.reply(
			connected.length
				? [
						"**No models are available yet.**",
						`Connected providers: **${connected.join("**, **")}**. Try again in a moment.`,
					].join("\n")
				: ["**No provider is connected yet.**", "Go back and connect one, then choose a model."].join("\n"),
			[
				buttonRow([
					actionButton("Try again", request.id(MODEL_SCREEN_ID), 1),
					actionButton("Back", request.id(SETUP_MENU_ID), 2),
				]),
			],
		);
		return;
	}
	const status = await request.session.config().catch(() => undefined);
	const current = status?.model;
	await answer.reply(
		[
			"**Model**",
			...(current ? [`Current: \`${current}\``] : []),
			"Pick the model Eryn should run here.",
			...(models.length > MAX_SELECT_OPTIONS
				? [`Showing the first ${MAX_SELECT_OPTIONS} here; use **Search models** for the rest.`]
				: []),
		].join("\n"),
		[
			selectRow({
				type: 3,
				custom_id: request.id(SELECT_ID),
				placeholder: "Pick a model",
				options: modelOptions(models, current),
			}),
			searchRow(request),
		],
	);
}

/** Show the connected models matching a search, as a select of at most 25. */
async function searchModels(request: InteractionRequest, query: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const needle = query.trim().toLowerCase();
	const matches = (await connectedModels(request)).filter(
		(model) => !needle || `${model.id} ${model.name} ${model.provider}`.toLowerCase().includes(needle),
	);
	if (!matches.length) {
		await answer.reply(`No models match “${query.trim()}”. Try a shorter search.`, [
			buttonRow([
				actionButton("Search again", request.id(SEARCH_ID), 2),
				actionButton("Back", request.id(MODEL_SCREEN_ID), 2),
			]),
		]);
		return;
	}
	const current = (await request.session.config().catch(() => undefined))?.model;
	await answer.reply(
		matches.length >= MAX_SELECT_OPTIONS
			? `**Models matching “${query.trim()}”** (showing the first ${MAX_SELECT_OPTIONS})`
			: `**Models matching “${query.trim()}”**`,
		[
			selectRow({
				type: 3,
				custom_id: request.id(SELECT_ID),
				placeholder: "Pick a model",
				options: modelOptions(matches, current),
			}),
			buttonRow([
				actionButton("Search again", request.id(SEARCH_ID), 2),
				actionButton("Enter a model reference", request.id(MANUAL_ID), 2),
				actionButton("Back", request.id(MODEL_SCREEN_ID), 2),
			]),
		],
	);
}

async function selectModel(request: InteractionRequest, model: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	if (!model) {
		await answer.reply("No model was selected.", [backRow(request, MODEL_SCREEN_ID)]);
		return;
	}
	try {
		await request.session.setModel(model);
	} catch (error) {
		await answer.reply(`Could not use \`${model}\`: ${describeError(error)}`, [
			retryRow(request, request.id(MANUAL_ID), MODEL_SCREEN_ID),
		]);
		return;
	}
	await answer.reply(
		[
			`**Model set to \`${model}\`.**`,
			"Mention Eryn in a channel to start, or run `/eryn setup` to change anything else.",
		].join("\n"),
		[
			buttonRow([
				actionButton("Back to setup", request.id(SETUP_MENU_ID), 2),
				actionButton("Close", request.id(SETUP_CLOSE_ID), 2),
			]),
		],
	);
}

export async function modelComponent(
	request: InteractionRequest,
	customId: string,
	values: readonly string[],
): Promise<boolean> {
	switch (customId) {
		case MODEL_SCREEN_ID:
			return await claim(request, "update", () => modelScreen(request));
		case SELECT_ID:
			return await claim(request, "update", () => selectModel(request, values[0] ?? ""));
		case SEARCH_ID:
			await responder(request).modal(modelSearchModal(request));
			return true;
		case MANUAL_ID:
			await responder(request).modal(modelModal(request));
			return true;
	}
	return false;
}

/** Model search and the free-form reference share no ids with the select. */
export async function modelModalSubmit(
	request: InteractionRequest,
	customId: string,
	values: Record<string, string>,
): Promise<boolean> {
	switch (customId) {
		case SEARCH_MODAL_ID:
			return await claim(request, "reply", () => searchModels(request, values.query ?? ""));
		case MODAL_ID:
			return await claim(request, "reply", () => selectModel(request, values.model?.trim() ?? ""));
	}
	return false;
}
