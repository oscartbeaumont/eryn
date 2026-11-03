/**
 * The whole setup surface, as Discord interactions.
 *
 * One global `/eryn` command group, plus the buttons, selects, and modals its
 * answers raise. Everything here is ephemeral and every value with a chance of
 * being long is an interaction reply or a modal; business logic lives in the
 * guild's session object, which this file only calls.
 */

import { publicOrigin } from "../config";
import { sign } from "../crypto";
import { describeError } from "../errors";
import type { DiscordCommand, DiscordCommandOption } from "../discord/api";
import {
	actionButton,
	buttonRow,
	linkButton,
	selectRow,
	type DiscordButton,
	type DiscordComponent,
	type DiscordSelectOption,
	type DiscordModal,
} from "../discord/components";
import type { DiscordInteraction } from "../discord/socket";
import { modalValues } from "../discord/socket";
import { describeTools, MCP_START_PATH } from "../mcp/links";
import type { IntegrationOption, McpLink, PublicLink } from "../session/models";
import { SessionClient } from "./client";

const MAX_SELECT_OPTIONS = 25;
/** Discord's own id limit; our encoded ids must stay under it. */
const MAX_CUSTOM_ID = 100;
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

/** The custom_id codec for every component and modal this flow raises. */
export const CID = {
	setupMenu: "setup:menu",
	setupProviderButton: "setup:menu:provider",
	setupModelButton: "setup:menu:model",
	setupMcpButton: "setup:menu:mcp",
	mcpMenuAdd: "setup:mcp:add",
	mcpMenuTest: "setup:mcp:test",
	mcpMenuRemove: "setup:mcp:remove",
	removeProvider: "setup:provider:remove",
	removeProviderSelect: "setup:provider:remove:select",
	removeProviderConfirm: (integrationID: string) => clip(`setup:provider:remove:confirm:${integrationID}`),
	providerSelect: "setup:provider",
	providerPick: (integrationID: string) => clip(`setup:provider:pick:${integrationID}`),
	providerSearch: "setup:search",
	method: (integrationID: string, methodID: string) => clip(`setup:method:${integrationID}:${methodID}`),
	keyModal: (integrationID: string) => clip(`setup:key:${integrationID}`),
	codeModal: (integrationID: string) => clip(`setup:code:${integrationID}`),
	oauthCheck: (integrationID: string, attemptID: string) => clip(`setup:oauthcheck:${integrationID}:${attemptID}`),
	modelSelect: "setup:model",
	modelManual: "setup:model:manual",
	modelModal: "setup:model:modal",
	modelSearch: "setup:model:search",
	modelSearchModal: "setup:model:search:modal",
	mcpAddModal: "mcp:add",
	mcpRemoveSelect: "mcp:remove",
	mcpAuthCheck: (attemptId: string) => clip(`mcp:oauth:${attemptId}`),
	mcpTestAll: "mcp:test:all",
	mcpTest: (linkId: string) => clip(`mcp:test:${linkId}`),
} as const;

function clip(value: string): string {
	return value.length > MAX_CUSTOM_ID ? value.slice(0, MAX_CUSTOM_ID) : value;
}

/**
 * A DM has no guild context, so the provider flow started from the install
 * message carries the guild id in every id it raises.
 */
const INSTALL_PREFIX = "install:setup:";

function providerSelectId(guildId?: string): string {
	return guildId ? clip(`${INSTALL_PREFIX}${guildId}:provider`) : CID.providerSelect;
}

function providerPickId(guildId: string | undefined, integrationID: string): string {
	return guildId
		? clip(`${INSTALL_PREFIX}${guildId}:provider:pick:${integrationID}`)
		: CID.providerPick(integrationID);
}

function methodId(guildId: string | undefined, integrationID: string, methodID: string): string {
	return guildId
		? clip(`${INSTALL_PREFIX}${guildId}:method:${integrationID}:${methodID}`)
		: CID.method(integrationID, methodID);
}

function keyModalId(guildId: string | undefined, integrationID: string): string {
	return guildId ? clip(`${INSTALL_PREFIX}${guildId}:key:${integrationID}`) : CID.keyModal(integrationID);
}

function providerSearchId(guildId?: string): string {
	return guildId ? clip(`${INSTALL_PREFIX}${guildId}:search`) : CID.providerSearch;
}

function codeModalId(guildId: string | undefined, integrationID: string): string {
	return guildId ? clip(`${INSTALL_PREFIX}${guildId}:code:${integrationID}`) : CID.codeModal(integrationID);
}

function oauthCheckId(guildId: string | undefined, integrationID: string, attemptID: string): string {
	return guildId
		? clip(`${INSTALL_PREFIX}${guildId}:oauthcheck:${integrationID}:${attemptID}`)
		: CID.oauthCheck(integrationID, attemptID);
}

/** The setup menu and the buttons that open each part of it. */
function setupActionId(action: "provider" | "model" | "mcp", guildId?: string): string {
	return guildId ? clip(`${INSTALL_PREFIX}${guildId}:menu:${action}`) : `${CID.setupMenu}:${action}`;
}

/** Model components carry the install DM's guild id the same way. */
function modelSelectId(guildId?: string): string {
	return guildId ? clip(`${INSTALL_PREFIX}${guildId}:model`) : CID.modelSelect;
}

function modelManualId(guildId?: string): string {
	return guildId ? clip(`${INSTALL_PREFIX}${guildId}:model:manual`) : CID.modelManual;
}

function modelModalId(guildId?: string): string {
	return guildId ? clip(`${INSTALL_PREFIX}${guildId}:model:modal`) : CID.modelModal;
}

function modelSearchId(guildId?: string): string {
	return guildId ? clip(`${INSTALL_PREFIX}${guildId}:model:search`) : CID.modelSearch;
}

function modelSearchModalId(guildId?: string): string {
	return guildId ? clip(`${INSTALL_PREFIX}${guildId}:model:search:modal`) : CID.modelSearchModal;
}

/** The world the command handlers read from. */
export interface CommandContext {
	readonly env: Env;
	readonly log: (message: string) => void;
	readonly applicationId: string;
	readonly session: (guildId: string) => SessionClient;
	readonly ownsThread: (threadId: string) => Promise<boolean>;
	readonly rest: {
		interactionReply: (id: string, token: string, content: string, options?: { components?: readonly DiscordComponent[]; ephemeral?: boolean }) => Promise<void>;
		interactionUpdate: (id: string, token: string, content: string, options?: { components?: readonly DiscordComponent[] }) => Promise<void>;
		interactionDefer: (id: string, token: string, ephemeral?: boolean) => Promise<void>;
		interactionEditOriginal: (
			applicationId: string,
			token: string,
			content: string,
			options?: { components?: readonly DiscordComponent[] },
		) => Promise<void>;
		interactionModal: (id: string, token: string, modal: DiscordModal) => Promise<void>;
	};
}

/** The single command group Eryn registers. */
export function erynCommand(): DiscordCommand {
	return {
		name: "eryn",
		description: "Configure Eryn in this server",
		type: 1,
		options: [
			{
				name: "setup",
				description: "Open Eryn's setup menu",
				type: 1,
			},
			{ name: "stop", description: "Stop the Eryn run in this thread", type: 1 },
			{ name: "help", description: "How Eryn is set up", type: 1 },
		],
	};
}

/**
 * Whether Discord's copy of the command already matches the one we want.
 *
 * Registering is a PUT of the whole set, and Discord bumps the command's version
 * even when nothing changed. Every version bump makes clients that still hold
 * the previous copy answer "This command is outdated", so compare first and only
 * write when the tree really differs.
 */
export function sameCommands(
	registered: readonly DiscordCommand[],
	desired: readonly DiscordCommand[],
): boolean {
	const shape = (command: DiscordCommand) => ({
		name: command.name,
		description: command.description,
		type: command.type,
		options: (command.options ?? []).map(optionShape),
	});
	return JSON.stringify(registered.map(shape)) === JSON.stringify(desired.map(shape));
}

function optionShape(option: DiscordCommandOption): unknown {
	return {
		name: option.name,
		description: option.description,
		type: option.type,
		required: option.required ?? false,
		options: (option.options ?? []).map(optionShape),
	};
}

/**
 * Interactions that have already been acknowledged.
 *
 * A responder can be created more than once for one interaction (a helper hands
 * off to another), so the "already acknowledged" state has to live outside any
 * single responder: a second acknowledgement is an error, while an edit is not.
 */
const acknowledged = new WeakSet<DiscordInteraction>();

/** Discord's MANAGE_GUILD bit; configuration is an admin action. */
const MANAGE_GUILD = 1n << 5n;

function canManage(interaction: DiscordInteraction): boolean {
	// The install DM has no guild context; it is only delivered to the installer.
	if (!interaction.guild_id) return true;
	const raw = interaction.member?.permissions;
	if (typeof raw !== "string") return false;
	try {
		return (BigInt(raw) & MANAGE_GUILD) !== 0n;
	} catch {
		return false;
	}
}

async function denyConfiguration(ctx: CommandContext, interaction: DiscordInteraction): Promise<void> {
	await ctx.rest
		.interactionReply(interaction.id, interaction.token, "Only someone with Manage Server can change Eryn's setup.", {
			ephemeral: true,
		})
		.catch(() => undefined);
}

function responder(ctx: CommandContext, interaction: DiscordInteraction) {
	/**
	 * An edit replaces the whole message, so its components default to none.
	 * Discord keeps the previous ones when the field is left out, which is how a
	 * finished flow used to keep its buttons alive for another click; callers
	 * that still want buttons pass them for the next step.
	 */
	const edit = (content: string, components?: readonly DiscordComponent[]) =>
		ctx.rest.interactionEditOriginal(ctx.applicationId, interaction.token, content, {
			components: components ?? [],
		});
	return {
		/**
		 * Acknowledge now, so a slow lookup stays inside Discord's 3-second
		 * window. A component interaction must acknowledge with an update; a
		 * command interaction uses a deferred message.
		 */
		defer: async () => {
			if (acknowledged.has(interaction)) return;
			acknowledged.add(interaction);
			if (interaction.type === 3) {
				// Drop the buttons while the work runs, so a second click cannot
				// start the same step twice.
				await ctx.rest.interactionUpdate(interaction.id, interaction.token, "Working…", { components: [] });
			} else {
				await ctx.rest.interactionDefer(interaction.id, interaction.token, true);
			}
		},
		reply: (content: string, components?: readonly DiscordComponent[]) => {
			if (acknowledged.has(interaction)) return edit(content, components);
			acknowledged.add(interaction);
			return ctx.rest.interactionReply(interaction.id, interaction.token, content, {
				...(components?.length ? { components } : {}),
			});
		},
		update: (content: string, components?: readonly DiscordComponent[]) => {
			if (acknowledged.has(interaction)) return edit(content, components);
			acknowledged.add(interaction);
			return ctx.rest.interactionUpdate(interaction.id, interaction.token, content, {
				components: components ?? [],
			});
		},
		modal: (modal: DiscordModal) => ctx.rest.interactionModal(interaction.id, interaction.token, modal),
	};
}

/** Run a handler, and always answer the interaction even when it throws. */
async function guarded(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	kind: "reply" | "update",
	run: () => Promise<void>,
): Promise<void> {
	try {
		await run();
	} catch (error) {
		ctx.log(`interaction failed: ${describeError(error)}`);
		const message = `That did not work: ${describeError(error)}`;
		const answer = responder(ctx, interaction);
		await (kind === "update" ? answer.update(message) : answer.reply(message)).catch(() => undefined);
	}
}

/** Dispatch any interaction Eryn receives. */
export async function handleInteraction(ctx: CommandContext, interaction: DiscordInteraction): Promise<void> {
	if (interaction.type === 2) return await handleCommand(ctx, interaction);
	if (interaction.type === 3) return await handleComponent(ctx, interaction);
	if (interaction.type === 5) return await handleModal(ctx, interaction);
}

// --- Application commands ------------------------------------------------------

async function handleCommand(ctx: CommandContext, interaction: DiscordInteraction): Promise<void> {
	const data = interaction.data;
	if (data?.name !== "eryn") return;
	const group = data.options?.[0];
	const sub = group?.type === 2 ? group.options?.[0] : group;
	const command = sub?.name;
	const path = group && group.type === 2 && command ? `${group.name}:${command}` : command;
	const answer = responder(ctx, interaction);

	const guildId = interaction.guild_id;
	if (!guildId) {
		await answer.reply("Run `/eryn` inside a server, so I know which setup to change.");
		return;
	}
	if (path !== "stop" && path !== "help" && !canManage(interaction)) {
		return await denyConfiguration(ctx, interaction);
	}
	const session = ctx.session(guildId);

	switch (path) {
		case "setup":
		case "setup:status":
			return await guarded(ctx, interaction, "reply", () => setupMenu(ctx, interaction, session));
		// Old clients may still send the pre-menu subcommands.
		case "setup:provider":
			return await guarded(ctx, interaction, "reply", () => setupProvider(ctx, interaction, session));
		case "setup:model":
			return await guarded(ctx, interaction, "reply", () => setupModel(ctx, interaction, session));
		case "stop":
			return await guarded(ctx, interaction, "reply", async () => {
				const channelId = interaction.channel_id;
				if (!channelId || !(await ctx.ownsThread(channelId))) {
					await answer.reply("There is no Eryn run in this thread.");
					return;
				}
				await answer.reply("Stopping the current run…");
				await session.interrupt(channelId, false).catch(() => undefined);
			});
		case "help":
			return await answer.reply(helpText());
		default:
			return await answer.reply("I did not recognise that command.");
	}
}

async function setupProvider(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
	dmGuildId?: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	const providers = (await session.providers()).filter(
		(provider) => provider.methods.some((method) => method.supported) || provider.connected,
	);
	if (!providers.length) {
		await answer.reply("No provider this deployment can connect is available right now.");
		return;
	}
	providers.sort((a, b) => providerRank(a) - providerRank(b) || a.name.localeCompare(b.name));
	const shown = providers.slice(0, MAX_SELECT_OPTIONS);
	const options: DiscordSelectOption[] = shown.map((provider) => ({
		label: provider.name.slice(0, 100),
		value: provider.id,
		description: (provider.connected ? "connected" : provider.methods.map((method) => method.label).join(", ")).slice(0, 100),
	}));
	const recommended = PREFERRED_PROVIDERS.map((id) => providers.find((provider) => provider.id === id))
		.filter((provider): provider is IntegrationOption => provider !== undefined)
		.slice(0, 5);
	const components: DiscordComponent[] = [];
	if (recommended.length) {
		components.push(
			buttonRow(
				recommended.map((provider) =>
					actionButton(provider.name.slice(0, 80), providerPickId(dmGuildId, provider.id), 2),
				),
			),
		);
	}
	components.push(
		selectRow({ type: 3, custom_id: providerSelectId(dmGuildId), placeholder: "Browse all providers", options }),
	);
	components.push(buttonRow([actionButton("Search all providers", providerSearchId(dmGuildId), 2)]));
	await answer.reply(
		[
			"Which provider should this server use for inference?",
			recommended.length ? "Pick a common provider below, or browse the full list." : "Browse the list or search for a provider.",
			...(providers.length > shown.length
				? [`Showing ${shown.length} of ${providers.length} in the list; use Search all providers for the rest.`]
				: []),
			...(providers.some((provider) => provider.id === "opencode")
				? ["OpenCode Go models are included with the OpenCode Console connection."]
				: []),
		].join("\n"),
		components,
	);
}

async function setupMenu(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
	dmGuildId?: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	const status = await session.config().catch(() => undefined);
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
			setupActionId("provider", dmGuildId),
			status?.ready ? 2 : 1,
		),
	];
	if (status?.ready) {
		buttons.push(actionButton("Choose model", setupActionId("model", dmGuildId), 2));
		if (!dmGuildId) buttons.push(actionButton("Remove provider", CID.removeProvider, 4));
	}
	if (!dmGuildId) {
		buttons.push(actionButton("MCP servers", setupActionId("mcp", dmGuildId), 2));
	}
	await answer.reply(lines.join("\n"), [buttonRow(buttons)]);
}

async function setupMcp(ctx: CommandContext, interaction: DiscordInteraction, session: SessionClient): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	const links = await session.links();
	const buttons: DiscordButton[] = [actionButton("Link a server", CID.mcpMenuAdd, 1)];
	if (links.length) {
		buttons.push(actionButton("Test all", CID.mcpMenuTest, 2));
		buttons.push(actionButton("Remove", CID.mcpMenuRemove, 3));
	}
	buttons.push(actionButton("Back", CID.setupMenu, 2));
	await answer.reply(formatLinks(links), [buttonRow(buttons)]);
}

async function setupModel(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
	dmGuildId?: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	// Only models from a connected provider can run; offering the rest is how a
	// guild ends up selecting `opencode-go/...` with only `opencode` connected.
	const models = (await session.models()).filter((model) => model.connected);
	if (!models.length) {
		const status = await session.config().catch(() => undefined);
		const connected = status?.providers.map((provider) => provider.integrationID).join(", ") || "none";
		await answer.reply(
			`I could not read a model catalogue yet. Connected providers: **${connected}**. If that looks right, try again in a moment; otherwise reconnect the provider with \`/eryn setup\`.`,
		);
		return;
	}
	const options: DiscordSelectOption[] = models.slice(0, MAX_SELECT_OPTIONS).map((model) => ({
		label: `${model.connected ? "★ " : ""}${model.name}`.slice(0, 100),
		value: model.id,
		description: `${model.provider} · ${model.status}`.slice(0, 100),
	}));
	await answer.reply("Which model should Eryn run here?", [
		selectRow({ type: 3, custom_id: modelSelectId(dmGuildId), placeholder: "Pick a model", options }),
		buttonRow([
			actionButton("Search models", modelSearchId(dmGuildId), 2),
			actionButton("Enter a model reference", modelManualId(dmGuildId), 2),
		]),
	]);
}

async function searchModels(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
	query: string,
	dmGuildId?: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	const needle = query.trim().toLowerCase();
	const models = (await session.models()).filter((model) => model.connected);
	const matches = models.filter(
		(model) =>
			!needle ||
			`${model.id} ${model.name} ${model.provider}`.toLowerCase().includes(needle),
	);
	const shown = matches.slice(0, MAX_SELECT_OPTIONS);
	if (!shown.length) {
		await answer.reply(`No models match “${query.trim()}”.`, [
			buttonRow([actionButton("Search again", modelSearchId(dmGuildId), 2)]),
		]);
		return;
	}
	const options: DiscordSelectOption[] = shown.map((model) => ({
		label: `${model.connected ? "★ " : ""}${model.name}`.slice(0, 100),
		value: model.id,
		description: `${model.provider} · ${model.status}`.slice(0, 100),
	}));
	await answer.reply(`Models matching “${query.trim()}”`, [
		selectRow({ type: 3, custom_id: modelSelectId(dmGuildId), placeholder: "Pick a model", options }),
		buttonRow([
			actionButton("Search again", modelSearchId(dmGuildId), 2),
			actionButton("Enter a model reference", modelManualId(dmGuildId), 2),
		]),
	]);
}

async function selectModel(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
	model: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	if (!model) {
		await answer.reply("No model was selected.");
		return;
	}
	await session.setModel(model);
	await answer.reply(`Model set to \`${model}\`. Mention @eryn in a channel to start.`);
}

async function promptRemoveMcp(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	const links = await session.links();
	if (!links.length) {
		await answer.reply("No MCP servers are linked to this server.");
		return;
	}
	await answer.reply("Which linked MCP server should I remove?", [
		selectRow({ type: 3, custom_id: CID.mcpRemoveSelect, placeholder: "Pick a server", options: linkOptions(links) }),
	]);
}

async function promptRemoveProvider(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	const status = await session.config().catch(() => undefined);
	const providers = status?.providers ?? [];
	if (!providers.length) {
		await answer.reply("No providers are connected to this server.");
		return;
	}
	if (providers.length === 1) {
		await promptProviderRemovalConfirm(ctx, interaction, providers[0]!.integrationID);
		return;
	}
	await answer.reply("Which provider should I remove?", [
		selectRow({
			type: 3,
			custom_id: CID.removeProviderSelect,
			placeholder: "Pick a provider",
			options: providers.slice(0, MAX_SELECT_OPTIONS).map((provider) => ({
				label: provider.integrationID.slice(0, 100),
				value: provider.integrationID,
				description: provider.method.slice(0, 100),
			})),
		}),
	]);
}

async function promptProviderRemovalConfirm(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	integrationID: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	if (!integrationID) {
		await answer.reply("No provider was selected.");
		return;
	}
	await answer.reply(`Remove **${integrationID}** from this server?`, [
		buttonRow([
			actionButton("Remove", CID.removeProviderConfirm(integrationID), 4),
			actionButton("Cancel", CID.setupMenu, 2),
		]),
	]);
}

async function removeProvider(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
	integrationID: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	try {
		await session.disconnectProvider(integrationID);
	} catch (error) {
		await answer.reply(`Could not remove **${integrationID}**: ${describeError(error)}`);
		return;
	}
	const status = await session.config().catch(() => undefined);
	await answer.reply(
		`Removed **${integrationID}**.${status?.ready ? "" : " Connect a provider before Eryn can run."}`,
		[buttonRow([actionButton("Back to setup", CID.setupMenu, 1)])],
	);
}

function mcpAddModal(url?: string): DiscordModal {
	return {
		custom_id: CID.mcpAddModal,
		title: "Add an MCP server",
		components: [
			{
				type: 1,
				components: [
					{
						type: 4,
						custom_id: "name",
						label: "Name",
						style: 1,
						required: true,
						max_length: 60,
						placeholder: "my-mcp-server",
					},
				],
			},
			{
				type: 1,
				components: [
					{
						type: 4,
						custom_id: "url",
						label: "Streamable HTTP URL",
						style: 1,
						required: true,
						max_length: 300,
						...(url ? { value: url } : { placeholder: "https://example.com/mcp" }),
					},
				],
			},
			{
				type: 1,
				components: [
					{
						type: 4,
						custom_id: "token",
						label: "Bearer token (optional)",
						style: 1,
						required: false,
						max_length: 500,
						placeholder: "Leave blank to test without one",
					},
				],
			},
		],
	};
}

function modelModal(dmGuildId?: string): DiscordModal {
	return {
		custom_id: modelModalId(dmGuildId),
		title: "Choose a model",
		components: [
			{
				type: 1,
				components: [
					{
						type: 4,
						custom_id: "model",
						label: "provider/model reference",
						style: 1,
						required: true,
						max_length: 200,
						placeholder: "opencode-go/deepseek-v4.1-flash",
					},
				],
			},
		],
	};
}

function keyModal(integrationID: string, dmGuildId?: string): DiscordModal {
	return {
		custom_id: keyModalId(dmGuildId, integrationID),
		title: "Connect with an API key",
		components: [
			{
				type: 1,
				components: [
					{
						type: 4,
						custom_id: "key",
						label: `${integrationID} API key`,
						style: 1,
						required: true,
						max_length: 500,
					},
				],
			},
		],
	};
}

function modelSearchModal(dmGuildId?: string): DiscordModal {
	return {
		custom_id: modelSearchModalId(dmGuildId),
		title: "Search models",
		components: [
			{
				type: 1,
				components: [
					{
						type: 4,
						custom_id: "query",
						label: "Model name, id, or provider",
						style: 1,
						required: true,
						max_length: 100,
						placeholder: "claude, gpt-5, opencode-go",
					},
				],
			},
		],
	};
}

function providerSearchModal(dmGuildId?: string): DiscordModal {
	return {
		custom_id: providerSearchId(dmGuildId),
		title: "Search providers",
		components: [
			{
				type: 1,
				components: [
					{
						type: 4,
						custom_id: "query",
						label: "Provider name or id",
						style: 1,
						required: true,
						max_length: 100,
						placeholder: "openrouter",
					},
				],
			},
		],
	};
}

function codeModal(integrationID: string, dmGuildId?: string): DiscordModal {
	return {
		custom_id: codeModalId(dmGuildId, integrationID),
		title: "Enter the sign-in code",
		components: [
			{
				type: 1,
				components: [
					{
						type: 4,
						custom_id: "code",
						label: "Code",
						style: 1,
						required: true,
						max_length: 500,
					},
				],
			},
		],
	};
}

// --- Components ----------------------------------------------------------------

async function handleComponent(ctx: CommandContext, interaction: DiscordInteraction): Promise<void> {
	const customId = interaction.data?.custom_id;
	const guildId = interaction.guild_id;
	if (!customId) return;
	if (!canManage(interaction)) return await denyConfiguration(ctx, interaction);
	// The install DM's "Start setup" button carries the guild id, because a DM
	// has no guild context of its own. Every id raised from that flow carries it
	// too, so the conversation works entirely inside the DM.
	if (customId.startsWith(INSTALL_PREFIX)) {
		const parts = customId.slice(INSTALL_PREFIX.length).split(":");
		const dmGuildId = parts.shift() ?? "";
		const rest = parts.join(":");
		const session = ctx.session(dmGuildId);
		if (!rest || rest === "menu") {
			return await guarded(ctx, interaction, "update", () => setupMenu(ctx, interaction, session, dmGuildId));
		}
		if (rest === "menu:provider") {
			return await guarded(ctx, interaction, "update", () => setupProvider(ctx, interaction, session, dmGuildId));
		}
		if (rest === "menu:model") {
			return await guarded(ctx, interaction, "update", () => setupModel(ctx, interaction, session, dmGuildId));
		}
		if (rest === "menu:mcp") {
			await responder(ctx, interaction).update("Manage MCP servers from the server with `/eryn setup`.");
			return;
		}
		if (rest === "model:search") {
			await responder(ctx, interaction).modal(modelSearchModal(dmGuildId));
			return;
		}
		if (rest === "model") {
			return await guarded(ctx, interaction, "update", () =>
				selectModel(ctx, interaction, session, interaction.data?.values?.[0] ?? ""),
			);
		}
		if (rest === "model:manual") {
			await responder(ctx, interaction).modal(modelModal(dmGuildId));
			return;
		}
		if (rest.startsWith("provider:pick:")) {
			return await guarded(ctx, interaction, "update", () =>
				pickProviderMethod(ctx, interaction, session, rest.slice("provider:pick:".length), dmGuildId),
			);
		}
		if (rest === "provider") {
			return await guarded(ctx, interaction, "update", () =>
				pickProviderMethod(ctx, interaction, session, interaction.data?.values?.[0] ?? "", dmGuildId),
			);
		}
		if (rest === "search") {
			return await guarded(ctx, interaction, "reply", async () => {
				await responder(ctx, interaction).modal(providerSearchModal(dmGuildId));
			});
		}
		if (rest.startsWith("code:")) {
			const integrationID = rest.slice("code:".length);
			return await guarded(ctx, interaction, "reply", async () => {
				await responder(ctx, interaction).modal(codeModal(integrationID, dmGuildId));
			});
		}
		if (rest.startsWith("method:")) {
			const [, integrationID, methodID] = rest.split(":");
			return await guarded(ctx, interaction, "update", () =>
				startMethod(ctx, interaction, session, integrationID ?? "", methodID ?? "key", dmGuildId),
			);
		}
		if (rest.startsWith("oauthcheck:")) {
			const [, integrationID, attemptID] = rest.split(":");
			return await guarded(ctx, interaction, "update", async () => {
				const answer = responder(ctx, interaction);
				await answer.defer();
				const result = await session.providerConnect({
					guildId: dmGuildId,
					integrationID: integrationID ?? "",
					attemptID: attemptID ?? "",
					action: "status",
				});
				const status = result.status?.status ?? "pending";
				if (status === "complete") {
					await setupModel(ctx, interaction, session, dmGuildId);
				} else {
					await answer.update(`Sign-in status: **${status}**`);
				}
			});
		}
		return;
	}
	if (!guildId) {
		await responder(ctx, interaction).reply("Run this inside a server.");
		return;
	}
	const session = ctx.session(guildId);
	const values = interaction.data?.values ?? [];

	if (customId === CID.setupMenu) {
		return await guarded(ctx, interaction, "update", () => setupMenu(ctx, interaction, session));
	}
	if (customId === CID.setupProviderButton) {
		return await guarded(ctx, interaction, "update", () => setupProvider(ctx, interaction, session));
	}
	if (customId === CID.setupModelButton) {
		return await guarded(ctx, interaction, "update", () => setupModel(ctx, interaction, session));
	}
	if (customId === CID.setupMcpButton) {
		return await guarded(ctx, interaction, "update", () => setupMcp(ctx, interaction, session));
	}
	if (customId === CID.mcpMenuAdd) {
		await responder(ctx, interaction).modal(mcpAddModal());
		return;
	}
	if (customId === CID.mcpMenuTest) {
		return await guarded(ctx, interaction, "update", () => testAllLinks(ctx, interaction, session));
	}
	if (customId === CID.mcpMenuRemove) {
		return await guarded(ctx, interaction, "update", () => promptRemoveMcp(ctx, interaction, session));
	}
	if (customId === CID.removeProvider) {
		return await guarded(ctx, interaction, "update", () => promptRemoveProvider(ctx, interaction, session));
	}
	if (customId === CID.removeProviderSelect) {
		return await guarded(ctx, interaction, "update", () =>
			promptProviderRemovalConfirm(ctx, interaction, values[0] ?? ""),
		);
	}
	if (customId.startsWith("setup:provider:remove:confirm:")) {
		const integrationID = customId.slice("setup:provider:remove:confirm:".length);
		return await guarded(ctx, interaction, "update", () => removeProvider(ctx, interaction, session, integrationID));
	}
	if (customId.startsWith("setup:provider:pick:")) {
		return await guarded(ctx, interaction, "update", () =>
			pickProviderMethod(ctx, interaction, session, customId.slice("setup:provider:pick:".length)),
		);
	}
	if (customId === CID.providerSelect) {
		return await guarded(ctx, interaction, "update", () =>
			pickProviderMethod(ctx, interaction, session, values[0] ?? ""),
		);
	}
	if (customId === CID.providerSearch) {
		return await guarded(ctx, interaction, "reply", async () => {
			await responder(ctx, interaction).modal(providerSearchModal());
		});
	}
	if (customId.startsWith("setup:code:")) {
		const integrationID = customId.slice("setup:code:".length);
		return await guarded(ctx, interaction, "reply", async () => {
			await responder(ctx, interaction).modal(codeModal(integrationID));
		});
	}
	if (customId.startsWith("setup:method:")) {
		const [, , integrationID, methodID] = customId.split(":");
		return await guarded(ctx, interaction, "update", () =>
			startMethod(ctx, interaction, session, integrationID ?? "", methodID ?? "key"),
		);
	}
	if (customId.startsWith("setup:oauthcheck:")) {
		const attemptID = customId.slice("setup:oauthcheck:".length).split(":").pop() ?? "";
		const integrationID = customId.slice("setup:oauthcheck:".length).split(":").shift() ?? "";
		return await guarded(ctx, interaction, "update", async () => {
			const answer = responder(ctx, interaction);
			await answer.defer();
			const result = await session.providerConnect({
				guildId,
				integrationID,
				attemptID,
				action: "status",
			});
			const status = result.status?.status ?? "pending";
			if (status === "complete") {
				await setupModel(ctx, interaction, session);
			} else {
				await answer.update(
					`Sign-in status: **${status}**${result.status?.message ? ` — ${result.status.message}` : ""}`,
				);
			}
		});
	}
	if (customId === CID.modelSelect) {
		return await guarded(ctx, interaction, "update", () =>
			selectModel(ctx, interaction, session, values[0] ?? ""),
		);
	}
	if (customId === CID.modelSearch) {
		await responder(ctx, interaction).modal(modelSearchModal());
		return;
	}
	if (customId === CID.modelManual) {
		await responder(ctx, interaction).modal(modelModal());
		return;
	}
	if (customId === CID.mcpTestAll) {
		return await guarded(ctx, interaction, "update", () => testAllLinks(ctx, interaction, session));
	}
	if (customId.startsWith("mcp:test:")) {
		const linkId = customId.slice("mcp:test:".length);
		return await guarded(ctx, interaction, "update", () => testOneLink(ctx, interaction, session, linkId));
	}
	if (customId.startsWith("mcp:oauth:")) {
		const attemptId = customId.slice("mcp:oauth:".length);
		return await guarded(ctx, interaction, "update", () => checkMcpAuth(ctx, interaction, session, attemptId));
	}
	if (customId === CID.mcpRemoveSelect) {
		const linkId = values[0] ?? "";
		return await guarded(ctx, interaction, "update", async () => {
			await responder(ctx, interaction).defer();
			const links = await session.links();
			const link = links.find((candidate) => candidate.id === linkId);
			await session.removeLink(linkId);
			await responder(ctx, interaction).update(`Removed **${link?.name ?? linkId}**.`);
		});
	}
}

async function pickProviderMethod(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
	integrationID: string,
	dmGuildId?: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
	// The provider list can build the host, so ack after the one branch that
	// needs to open a modal as the initial interaction response.
	const providers = await session.providers();
	const provider = providers.find((candidate) => candidate.id === integrationID);
	if (!provider) {
		await answer.reply("That provider is no longer available.");
		return;
	}
	const methods = provider.methods.filter((method) => method.supported);
	if (!methods.length) {
		await answer.reply(`**${provider.name}** has no way to be connected in this deployment.`);
		return;
	}
	if (methods.length === 1) {
		const method = methods[0]!;
		if (method.type === "key") {
			await answer.modal(keyModal(integrationID, dmGuildId));
			return;
		}
		await startMethod(ctx, interaction, session, integrationID, method.id ?? "key", dmGuildId);
		return;
	}
	await answer.defer();
	await answer.update(
		`How should **${provider.name}** be connected?`,
		[
			buttonRow(
				methods.slice(0, 5).map((method, index) =>
					actionButton(
						method.label,
						methodId(dmGuildId, integrationID, method.type === "key" ? "key" : (method.id ?? "key")),
						index === 0 ? 1 : 2,
					),
				),
			),
		],
	);
}

async function startMethod(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
	integrationID: string,
	methodID: string,
	dmGuildId?: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
	const guildId = dmGuildId ?? interaction.guild_id ?? "";
	if (methodID === "key") {
		await answer.modal(keyModal(integrationID, dmGuildId));
		return;
	}
	await answer.defer();
	const result = await session.providerConnect({
		guildId,
		integrationID,
		methodID,
		action: "start",
		answer: {},
	});
	if (result.error || !result.url || !result.attemptID) {
		await answer.update(`Could not start the sign-in: ${result.error ?? "the provider returned no URL"}`);
		return;
	}
	// A device-code flow shows a code to type on the provider's page rather than
	// sending the browser back to us, so it finishes with a code, not a poll.
	if (result.mode === "code") {
		const buttons: DiscordButton[] = [];
		if (result.url.length <= MAX_LINK_URL) buttons.push(linkButton("Open sign-in page", result.url));
		buttons.push(actionButton("Enter code", codeModalId(dmGuildId, integrationID), 1));
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
	buttons.push(actionButton("I've finished", oauthCheckId(dmGuildId, integrationID, result.attemptID), 3));
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

// --- Modals --------------------------------------------------------------------

/** Show the providers matching a search, as a select of at most 25. */
async function searchProviders(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
	query: string,
	dmGuildId?: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	const needle = query.trim().toLowerCase();
	const goQuery = /^(oc|opencode)\s*go$/.test(needle) || needle === "ocgo";
	const providers = (await session.providers()).filter(
		(provider) => provider.methods.some((method) => method.supported) || provider.connected,
	);
	const matches = providers
		.filter((provider) =>
			goQuery
				? provider.id === "opencode"
				: !needle ||
					provider.id.toLowerCase().includes(needle) ||
					provider.name.toLowerCase().includes(needle),
		)
		.sort((a, b) => providerRank(a) - providerRank(b) || a.name.localeCompare(b.name))
		.slice(0, MAX_SELECT_OPTIONS);
	if (!matches.length) {
		await answer.reply(
			`No provider matches “${query.trim()}”. Try a shorter search.${
				goQuery ? " OpenCode Go is included with OpenCode Console, not a separate provider." : ""
			}`,
		);
		return;
	}
	const options: DiscordSelectOption[] = matches.map((provider) => ({
		label: provider.name.slice(0, 100),
		value: provider.id,
		description: (provider.connected ? "connected" : provider.methods.map((method) => method.label).join(", ")).slice(0, 100),
	}));
	await answer.reply(
		goQuery
			? "OpenCode Go is included with **OpenCode Console**. Pick that connection below."
			: matches.length === MAX_SELECT_OPTIONS
				? `Providers matching “${query.trim()}” (showing the first ${MAX_SELECT_OPTIONS})`
				: `Providers matching “${query.trim()}”`,
		[selectRow({ type: 3, custom_id: providerSelectId(dmGuildId), placeholder: "Pick a provider", options })],
	);
}

/** Finish a device-code sign-in with the code the provider showed. */
async function completeCode(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
	integrationID: string,
	code: string,
	dmGuildId?: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	const trimmed = code.trim();
	if (!trimmed) {
		await answer.reply("No code was provided.");
		return;
	}
	const result = await session.providerConnect({
		guildId: dmGuildId ?? interaction.guild_id ?? "",
		integrationID,
		action: "complete",
		code: trimmed,
	});
	if (result.error) {
		await answer.reply(`Could not finish **${integrationID}**: ${result.error}`);
		return;
	}
	await setupModel(ctx, interaction, session, dmGuildId);
}

async function handleModal(ctx: CommandContext, interaction: DiscordInteraction): Promise<void> {
	const customId = interaction.data?.custom_id;
	const guildId = interaction.guild_id;
	if (!customId) return;
	if (!canManage(interaction)) return await denyConfiguration(ctx, interaction);
	const values = modalValues(interaction);

	// A modal raised by the install DM carries its guild id.
	if (customId.startsWith(INSTALL_PREFIX)) {
		const parts = customId.slice(INSTALL_PREFIX.length).split(":");
		const dmGuildId = parts.shift() ?? "";
		const rest = parts.join(":");
		const session = ctx.session(dmGuildId);
		if (rest === "search") {
			return await guarded(ctx, interaction, "reply", () =>
				searchProviders(ctx, interaction, session, values.query ?? "", dmGuildId),
			);
		}
		if (rest.startsWith("code:")) {
			return await guarded(ctx, interaction, "reply", () =>
				completeCode(ctx, interaction, session, rest.slice("code:".length), values.code ?? "", dmGuildId),
			);
		}
		if (rest === "model:search:modal") {
			return await guarded(ctx, interaction, "reply", () =>
				searchModels(ctx, interaction, session, values.query ?? "", dmGuildId),
			);
		}
		if (rest === "model:modal") {
			return await guarded(ctx, interaction, "reply", () =>
				selectModel(ctx, interaction, session, values.model?.trim() ?? ""),
			);
		}
		if (!rest.startsWith("key:")) return;
		const integrationID = rest.slice("key:".length);
		return await guarded(ctx, interaction, "reply", async () => {
			const key = values.key?.trim();
			if (!key) {
				await responder(ctx, interaction).reply("No key was provided.");
				return;
			}
			const result = await session.providerConnect({ guildId: dmGuildId, integrationID, key, methodID: "key" });
			if (result.error) {
				await responder(ctx, interaction).reply(`Could not connect **${integrationID}**: ${result.error}`);
				return;
			}
			await setupModel(ctx, interaction, session, dmGuildId);
		});
	}

	if (!guildId) {
		await responder(ctx, interaction).reply("Run this inside a server.");
		return;
	}
	const session = ctx.session(guildId);

	if (customId.startsWith("setup:key:")) {
		const integrationID = customId.slice("setup:key:".length);
		return await guarded(ctx, interaction, "reply", async () => {
			const key = values.key?.trim();
			if (!key) {
				await responder(ctx, interaction).reply("No key was provided.");
				return;
			}
			const result = await session.providerConnect({ guildId, integrationID, key, methodID: "key" });
			if (result.error) {
				await responder(ctx, interaction).reply(`Could not connect **${integrationID}**: ${result.error}`);
				return;
			}
			await setupModel(ctx, interaction, session);
		});
	}
	if (customId === CID.providerSearch) {
		return await guarded(ctx, interaction, "reply", () =>
			searchProviders(ctx, interaction, session, values.query ?? ""),
		);
	}
	if (customId.startsWith("setup:code:")) {
		return await guarded(ctx, interaction, "reply", () =>
			completeCode(ctx, interaction, session, customId.slice("setup:code:".length), values.code ?? ""),
		);
	}
	if (customId === CID.modelSearchModal) {
		return await guarded(ctx, interaction, "reply", () =>
			searchModels(ctx, interaction, session, values.query ?? ""),
		);
	}
	if (customId === CID.modelModal) {
		return await guarded(ctx, interaction, "reply", () =>
			selectModel(ctx, interaction, session, values.model?.trim() ?? ""),
		);
	}
	if (customId === CID.mcpAddModal) {
		return await guarded(ctx, interaction, "reply", async () => mcpAdd(ctx, interaction, session, values, guildId));
	}
}

async function mcpAdd(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
	values: Record<string, string>,
	guildId: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
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
	const host = endpoint.host;
	const name = values.name?.trim() || host;
	const token = values.token?.trim();

	// Testing is a round trip to someone else's server, so acknowledge first and
	// edit the ephemeral reply when there is an answer.
	await answer.defer();
	const probe = await session.probe(url, token);
	if (!probe.ok) {
		// A 401 with a Bearer challenge is the server saying it supports a
		// sign-in. If discovery finds nothing, the reply falls back to a token.
		if (probe.needsAuth) {
			const started = await session.mcpAuthStart({
				name,
				url,
				...(interaction.channel_id ? { channelId: interaction.channel_id } : {}),
				applicationId: interaction.application_id,
				interactionToken: interaction.token,
				...(probe.resourceMetadataUrl ? { resourceMetadataUrl: probe.resourceMetadataUrl } : {}),
				...(probe.scope ? { scope: probe.scope } : {}),
			});
			if (started.ok && started.url && started.attemptId) {
				const secret = ctx.env.SESSION_SECRET?.trim();
				const token = secret ? await sign({ guildId, attemptId: started.attemptId }, secret) : undefined;
				const signInUrl = token
					? `${publicOrigin(ctx.env)}${MCP_START_PATH}/${token}`
					: started.url;
				await answer.reply(
					[
						`**${name}** needs you to sign in before Eryn can use it.`,
						"",
						"Open the link, approve the access, then press **I've finished**. The sign-in finishes in your browser, so this message can stay here.",
					].join("\n"),
					[
						buttonRow([
							linkButton("Sign in", signInUrl),
							actionButton("I've finished", CID.mcpAuthCheck(started.attemptId), 3),
						]),
					],
				);
				return;
			}
			await answer.reply(
				[
					`**${name}** needs authorisation before Eryn can use it.`,
					started.error ?? "",
					"",
					`If you have a token for it, run \`/eryn setup\`, open MCP servers, and link it with the token.`,
				]
					.filter(Boolean)
					.join("\n"),
			);
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
	await session.addLink(link);
	await answer.reply(
		`**${name} is connected.** ${describeTools(probe.tools)} Eryn will use it on the next turn.`,
		[buttonRow([actionButton("Test", CID.mcpTest(link.id), 3)])],
	);
}

/**
 * The "I've finished" button, and the state a browser callback leaves behind.
 *
 * Both paths write the same attempt record, so whichever arrives second just
 * reads the outcome; the button never needs the code itself.
 */
async function checkMcpAuth(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
	attemptId: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	const status = await session.mcpAuthStatus(attemptId);
	const components = status.link ? [buttonRow([actionButton("Test", CID.mcpTest(status.link.id), 3)])] : undefined;

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
		buttonRow([actionButton("I've finished", CID.mcpAuthCheck(attemptId), 3)]),
	]);
}

/** Test every link, one at a time, and report each in a line. */
async function testAllLinks(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	const links = await session.links();
	if (!links.length) {
		await answer.reply("No MCP servers are linked to this server.");
		return;
	}
	const results: string[] = [];
	const shown = links.slice(0, 10);
	for (const link of shown) {
		results.push(`• **${link.name}** — ${await describeLinkTest(session, link)}`);
	}
	if (links.length > shown.length) results.push(`…and ${links.length - shown.length} more.`);
	await answer.reply(clamp(["**MCP server test**", ...results].join("\n"), 1_900), [
		buttonRow([actionButton("Test again", CID.mcpTestAll, 1)]),
	]);
}

async function testOneLink(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
	linkId: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	const link = (await session.links()).find((candidate) => candidate.id === linkId);
	const name = link?.name ?? "That MCP server";
	if (!link) {
		await answer.update(`**${name}** is no longer linked.`);
		return;
	}
	await answer.update(`**${name}** — ${await describeLinkTest(session, link)}`, [
		buttonRow([actionButton("Test again", CID.mcpTest(linkId))]),
	]);
}

/** One link's test result, as a sentence for a Discord message. */
async function describeLinkTest(session: SessionClient, link: McpLink): Promise<string> {
	try {
		const result = await session.testLink(link.id);
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

// --- Helpers -------------------------------------------------------------------

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

function helpText(): string {
	return [
		"**Eryn setup**",
		"• `/eryn setup` — providers, models, MCP servers, and current status",
		"• `/eryn stop` — stop the run in this thread",
	].join("\n");
}
