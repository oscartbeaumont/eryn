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
import { scopedId } from "../ids";
import {
	guarded,
	responder,
	textInput,
	textModal,
	MAX_SELECT_OPTIONS,
	type InteractionRequest,
} from "./interaction";

const SELECT_ID = "setup:model";
const MANUAL_ID = "setup:model:manual";
const MODAL_ID = "setup:model:modal";
const SEARCH_ID = "setup:model:search";
const SEARCH_MODAL_ID = "setup:model:search:modal";

/** The model select's entries, in catalogue order. */
function modelOptions(models: readonly ModelOption[]): DiscordSelectOption[] {
	return models.slice(0, MAX_SELECT_OPTIONS).map((model) => ({
		label: `${model.connected ? "★ " : ""}${model.name}`.slice(0, 100),
		value: model.id,
		description: `${model.provider} · ${model.status}`.slice(0, 100),
	}));
}

function modelModal(request: InteractionRequest): DiscordModal {
	return textModal(scopedId(MODAL_ID, request.dmGuildId), "Choose a model", [
		textInput({
			custom_id: "model",
			label: "provider/model reference",
			required: true,
			max_length: 200,
			placeholder: "opencode-go/deepseek-v4.1-flash",
		}),
	]);
}

function modelSearchModal(request: InteractionRequest): DiscordModal {
	return textModal(scopedId(SEARCH_MODAL_ID, request.dmGuildId), "Search models", [
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

export async function modelScreen(request: InteractionRequest): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const id = (base: string) => scopedId(base, request.dmGuildId);
	const models = await connectedModels(request);
	if (!models.length) {
		const status = await request.session.config().catch(() => undefined);
		const connected = status?.providers.map((provider) => provider.integrationID).join(", ") || "none";
		await answer.reply(
			`I could not read a model catalogue yet. Connected providers: **${connected}**. If that looks right, try again in a moment; otherwise reconnect the provider with \`/eryn setup\`.`,
		);
		return;
	}
	await answer.reply("Which model should Eryn run here?", [
		selectRow({ type: 3, custom_id: id(SELECT_ID), placeholder: "Pick a model", options: modelOptions(models) }),
		buttonRow([
			actionButton("Search models", id(SEARCH_ID), 2),
			actionButton("Enter a model reference", id(MANUAL_ID), 2),
		]),
	]);
}

/** Show the connected models matching a search, as a select of at most 25. */
async function searchModels(request: InteractionRequest, query: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	const id = (base: string) => scopedId(base, request.dmGuildId);
	const needle = query.trim().toLowerCase();
	const matches = (await connectedModels(request)).filter(
		(model) => !needle || `${model.id} ${model.name} ${model.provider}`.toLowerCase().includes(needle),
	);
	if (!matches.length) {
		await answer.reply(`No models match “${query.trim()}”.`, [
			buttonRow([actionButton("Search again", id(SEARCH_ID), 2)]),
		]);
		return;
	}
	await answer.reply(`Models matching “${query.trim()}”`, [
		selectRow({ type: 3, custom_id: id(SELECT_ID), placeholder: "Pick a model", options: modelOptions(matches) }),
		buttonRow([
			actionButton("Search again", id(SEARCH_ID), 2),
			actionButton("Enter a model reference", id(MANUAL_ID), 2),
		]),
	]);
}

async function selectModel(request: InteractionRequest, model: string): Promise<void> {
	const answer = responder(request);
	await answer.defer();
	if (!model) {
		await answer.reply("No model was selected.");
		return;
	}
	await request.session.setModel(model);
	await answer.reply(`Model set to \`${model}\`. Mention @eryn in a channel to start.`);
}

export async function modelComponent(
	request: InteractionRequest,
	customId: string,
	values: readonly string[],
): Promise<boolean> {
	switch (customId) {
		case SELECT_ID:
			await guarded(request, "update", () => selectModel(request, values[0] ?? ""));
			return true;
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
			await guarded(request, "reply", () => searchModels(request, values.query ?? ""));
			return true;
		case MODAL_ID:
			await guarded(request, "reply", () => selectModel(request, values.model?.trim() ?? ""));
			return true;
	}
	return false;
}
