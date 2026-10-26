/**
 * The whole setup surface, as Discord interactions.
 *
 * One global `/eryn` command group, plus the buttons, selects, and modals its
 * answers raise. Everything here is ephemeral and every value with a chance of
 * being long is an interaction reply or a modal; business logic lives in the
 * guild's session object, which this file only calls.
 */

import { CLIENT_ID, publicOrigin } from "../config";
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
import { describeTools } from "../mcp/links";
import type { McpLink, ToolAccess } from "../session/models";
import { GatewayClient, SessionClient, type HostedServer } from "./client";

const MAX_SELECT_OPTIONS = 25;
/** Discord's own id limit; our encoded ids must stay under it. */
const MAX_CUSTOM_ID = 100;

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
	providerSelect: "setup:provider",
	providerSearch: "setup:search",
	method: (integrationID: string, methodID: string) => clip(`setup:method:${integrationID}:${methodID}`),
	keyModal: (integrationID: string) => clip(`setup:key:${integrationID}`),
	codeModal: (integrationID: string) => clip(`setup:code:${integrationID}`),
	oauthCheck: (integrationID: string, attemptID: string) => clip(`setup:oauthcheck:${integrationID}:${attemptID}`),
	modelSelect: "setup:model",
	modelManual: "setup:model:manual",
	modelModal: "setup:model:modal",
	mcpAddModal: "mcp:add",
	mcpAddHosted: "mcp:add:hosted",
	mcpAddExternal: "mcp:add:external",
	mcpLinkSelect: "mcp:link",
	mcpLinkPick: (serverId: string, preset: string) => clip(`mcp:link:${serverId}:${preset}`),
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

/** The world the command handlers read from. */
export interface CommandContext {
	readonly env: Env;
	readonly log: (message: string) => void;
	readonly session: (guildId: string) => SessionClient;
	readonly gateway: GatewayClient;
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
				description: "Connect a provider or choose the model Eryn runs",
				type: 2,
				options: [
					{ name: "provider", description: "Connect an inference provider for this server", type: 1 },
					{ name: "model", description: "Choose the model Eryn runs", type: 1 },
					{ name: "status", description: "Show this server's Eryn setup", type: 1 },
				],
			},
			{
				name: "mcp",
				description: "Link MCP servers to this server",
				type: 2,
				options: [
					{
						name: "add",
						description: "Add an MCP server: one of yours, or any external server",
						type: 1,
						options: [{ name: "url", description: "An external server's streamable HTTP URL", type: 3 }],
					},
					{ name: "link", description: "Link one of your Eryn-hosted MCP servers", type: 1 },
					{ name: "list", description: "List this server's linked MCP servers", type: 1 },
					{ name: "test", description: "Test the linked MCP servers", type: 1 },
					{ name: "remove", description: "Remove a linked MCP server", type: 1 },
				],
			},
			{ name: "stop", description: "Stop the Eryn run in this thread", type: 1 },
			{ name: "help", description: "How Eryn is set up, and where the console is", type: 1 },
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

function responder(ctx: CommandContext, interaction: DiscordInteraction) {
	const edit = (content: string, components?: readonly DiscordComponent[]) =>
		ctx.rest.interactionEditOriginal(CLIENT_ID, interaction.token, content, {
			...(components?.length ? { components } : {}),
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
				await ctx.rest.interactionUpdate(interaction.id, interaction.token, "Working…");
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
				...(components?.length ? { components } : {}),
			});
		},
		modal: (modal: DiscordModal) => ctx.rest.interactionModal(interaction.id, interaction.token, modal),
	};
}

function userIdOf(interaction: DiscordInteraction): string {
	return interaction.member?.user?.id ?? interaction.user?.id ?? "";
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
	const session = ctx.session(guildId);
	const userId = userIdOf(interaction);

	switch (path) {
		case "setup:provider":
			return await guarded(ctx, interaction, "reply", () => setupProvider(ctx, interaction, session));
		case "setup:model":
			return await guarded(ctx, interaction, "reply", () => setupModel(ctx, interaction, session));
		case "setup:status":
			return await guarded(ctx, interaction, "reply", async () => {
				await answer.defer();
				const status = await session.config();
				const providers = status.providers.length
					? status.providers.map((provider) => `• ${provider.integrationID}`).join("\n")
					: "none";
				const links = status.links.length ? status.links.map((link) => `• ${link.name} (${link.kind})`).join("\n") : "none";
				await answer.reply(
					[
						status.ready ? "**Eryn is ready here.**" : "**Eryn is not set up here yet.** Connect a provider with `/eryn setup provider`.",
						`Model: \`${status.model}\``,
						`Providers:\n${providers}`,
						`MCP servers:\n${links}`,
					].join("\n"),
				);
			});
		case "mcp:add": {
			const first = sub && "options" in sub ? sub.options?.[0] : undefined;
			const url = typeof first?.value === "string" ? first.value : undefined;
			if (url) {
				await answer.modal(mcpAddModal(url));
			} else {
				await answer.reply(
					[
						"**Add an MCP server**",
						"",
						"**Eryn-hosted** — link one of your own hosted servers. No sign-in: Eryn mints a token scoped to this Discord server for you.",
						"**External server** — any other MCP server. Eryn tests it first, then uses its token or its own sign-in if it needs one.",
					].join("\n"),
					[
						buttonRow([
							actionButton("Eryn-hosted", CID.mcpAddHosted, 1),
							actionButton("External server", CID.mcpAddExternal),
						]),
					],
				);
			}
			return;
		}
		case "mcp:link":
			return await guarded(ctx, interaction, "reply", () => mcpLinkStart(ctx, interaction, userId));
		case "mcp:list":
			return await guarded(ctx, interaction, "reply", async () => {
				await answer.defer();
				const links = await session.links();
				await answer.reply(
					formatLinks(links),
					links.length ? [buttonRow([actionButton("Test all", CID.mcpTestAll, 1)])] : undefined,
				);
			});
		case "mcp:test":
			return await guarded(ctx, interaction, "reply", () => testAllLinks(ctx, interaction, session));
		case "mcp:remove":
			return await guarded(ctx, interaction, "reply", async () => {
				await answer.defer();
				const links = await session.links();
				if (!links.length) {
					await answer.reply("No MCP servers are linked to this server.");
					return;
				}
				await answer.reply(
					"Which linked MCP server should I remove?",
					[selectRow({ type: 3, custom_id: CID.mcpRemoveSelect, placeholder: "Pick a server", options: linkOptions(links) })],
				);
			});
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
			return await answer.reply(helpText(ctx));
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
	await answer.reply(
		providers.length > shown.length
			? `Which provider should this server use for inference?\nShowing ${shown.length} of ${providers.length}; use **Search providers** for the rest.`
			: "Which provider should this server use for inference?",
		[
			selectRow({ type: 3, custom_id: providerSelectId(dmGuildId), placeholder: "Pick a provider", options }),
			buttonRow([actionButton("Search providers", providerSearchId(dmGuildId), 2)]),
		],
	);
}

async function setupModel(ctx: CommandContext, interaction: DiscordInteraction, session: SessionClient): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	// Only models from a connected provider can run; offering the rest is how a
	// guild ends up selecting `opencode-go/...` with only `opencode` connected.
	const models = (await session.models()).filter((model) => model.connected);
	if (!models.length) {
		const status = await session.config().catch(() => undefined);
		const connected = status?.providers.map((provider) => provider.integrationID).join(", ") || "none";
		await answer.reply(
			`I could not read a model catalogue yet. Connected providers: **${connected}**. If that looks right, try again in a moment; otherwise reconnect the provider with \`/eryn setup provider\`.`,
		);
		return;
	}
	const options: DiscordSelectOption[] = models.slice(0, MAX_SELECT_OPTIONS - 1).map((model) => ({
		label: `${model.connected ? "★ " : ""}${model.name}`.slice(0, 100),
		value: model.id,
		description: `${model.provider} · ${model.status}`.slice(0, 100),
	}));
	await answer.reply("Which model should Eryn run here?", [
		selectRow({ type: 3, custom_id: CID.modelSelect, placeholder: "Pick a model", options }),
		buttonRow([actionButton("Enter a model reference", CID.modelManual)]),
	]);
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

function modelModal(): DiscordModal {
	return {
		custom_id: CID.modelModal,
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
	// The install DM's "Start setup" button carries the guild id, because a DM
	// has no guild context of its own. Every id raised from that flow carries it
	// too, so the conversation works entirely inside the DM.
	if (customId.startsWith(INSTALL_PREFIX)) {
		const parts = customId.slice(INSTALL_PREFIX.length).split(":");
		const dmGuildId = parts.shift() ?? "";
		const rest = parts.join(":");
		const session = ctx.session(dmGuildId);
		if (!rest) {
			return await guarded(ctx, interaction, "reply", () => setupProvider(ctx, interaction, session, dmGuildId));
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
				await answer.update(
					status === "complete"
						? `**${integrationID} is connected.** Eryn will use it on the next turn.`
						: `Sign-in status: **${status}**`,
				);
			});
		}
		return;
	}
	if (!guildId) {
		await responder(ctx, interaction).reply("Run this inside a server.");
		return;
	}
	const session = ctx.session(guildId);
	const userId = userIdOf(interaction);
	const values = interaction.data?.values ?? [];

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
			await answer.update(
				status === "complete"
					? `**${integrationID} is connected.** Eryn will use it on the next turn.`
					: `Sign-in status: **${status}**${result.status?.message ? ` — ${result.status.message}` : ""}`,
			);
		});
	}
	if (customId === CID.modelSelect) {
		const model = values[0] ?? "";
		return await guarded(ctx, interaction, "update", async () => {
			await session.setModel(model);
			await responder(ctx, interaction).update(`Model set to \`${model}\`.`);
		});
	}
	if (customId === CID.modelManual) {
		await responder(ctx, interaction).modal(modelModal());
		return;
	}
	if (customId === CID.mcpAddHosted) {
		return await guarded(ctx, interaction, "reply", () => mcpLinkStart(ctx, interaction, userId));
	}
	if (customId === CID.mcpAddExternal) {
		return await guarded(ctx, interaction, "reply", async () => {
			await responder(ctx, interaction).modal(mcpAddModal());
		});
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
	if (customId === CID.mcpLinkSelect) {
		const serverId = values[0] ?? "";
		return await guarded(ctx, interaction, "update", () => pickLinkPreset(ctx, interaction, userId, guildId, serverId));
	}
	if (customId.startsWith("mcp:link:")) {
		const [, , serverId, preset] = customId.split(":");
		return await guarded(ctx, interaction, "update", () =>
			completeLink(ctx, interaction, session, userId, guildId, serverId ?? "", preset ?? "rw"),
		);
	}
	if (customId === CID.mcpRemoveSelect) {
		const linkId = values[0] ?? "";
		return await guarded(ctx, interaction, "update", async () => {
			const links = await session.links();
			const link = links.find((candidate) => candidate.id === linkId);
			await session.removeLink(linkId);
			if (link?.kind === "eryn" && link.mcpServerId) {
				await ctx.gateway.revoke(userId, guildId, link.mcpServerId).catch((error) => ctx.log(`revoke failed: ${describeError(error)}`));
			}
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
	const providers = await session.providers();
	const provider = providers.find((candidate) => candidate.id === integrationID);
	if (!provider) {
		await answer.update("That provider is no longer available.");
		return;
	}
	const methods = provider.methods.filter((method) => method.supported);
	if (!methods.length) {
		await answer.update(`**${provider.name}** has no way to be connected in this deployment.`);
		return;
	}
	if (methods.length === 1) {
		await startMethod(
			ctx,
			interaction,
			session,
			integrationID,
			methods[0]!.type === "key" ? "key" : (methods[0]!.id ?? "key"),
			dmGuildId,
		);
		return;
	}
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
		const buttons: DiscordButton[] = [
			linkButton("Open sign-in page", result.url),
			actionButton("Enter code", codeModalId(dmGuildId, integrationID), 1),
		];
		await answer.update(
			`**${integrationID}** needs a code to finish signing in.${
				result.instructions ? `\n\n${result.instructions}` : ""
			}\n\nOpen the page, then choose **Enter code**.`,
			[buttonRow(buttons)],
		);
		return;
	}
	const buttons: DiscordButton[] = [linkButton("Sign in", result.url)];
	buttons.push(actionButton("I've finished", oauthCheckId(dmGuildId, integrationID, result.attemptID), 3));
	await answer.update(
		`**${integrationID}** signs in through your browser. Open the link, finish the flow, then confirm.${
			result.instructions ? `\n\n${result.instructions}` : ""
		}`,
		[buttonRow(buttons)],
	);
}

async function mcpLinkStart(ctx: CommandContext, interaction: DiscordInteraction, userId: string): Promise<void> {
	const answer = responder(ctx, interaction);
	if (!userId) {
		await answer.reply("I could not tell who you are, so I cannot list your hosted MCP servers.");
		return;
	}
	await answer.defer();
	const servers = (await ctx.gateway.servers(userId)).filter((server) => server.enabled);
	if (!servers.length) {
		await answer.reply(
			`You have no hosted MCP servers yet. Create one at ${publicOrigin(ctx.env)}/console, then link it here.`,
		);
		return;
	}
	await answer.reply(
		[
			"Which of your hosted MCP servers should this Discord server use?",
			"Linking is internal: no sign-in, and Eryn mints a token scoped to this server for you.",
		].join("\n"),
		[
			selectRow({
				type: 3,
				custom_id: CID.mcpLinkSelect,
				placeholder: "Pick a hosted server",
				options: servers.slice(0, MAX_SELECT_OPTIONS).map((server) => ({
					label: (server.title ?? server.name).slice(0, 100),
					value: server.id,
					description: server.name.slice(0, 100),
				})),
			}),
		],
	);
}

async function pickLinkPreset(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	userId: string,
	guildId: string,
	serverId: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	const servers = await ctx.gateway.servers(userId);
	const server = servers.find((candidate) => candidate.id === serverId);
	if (!server) {
		await answer.update("That hosted server is no longer available.");
		return;
	}
	await answer.update(
		`How much should **${server.title ?? server.name}** be allowed to do in this server?`,
		[
			buttonRow([
				actionButton("Read + write", CID.mcpLinkPick(serverId, "rw"), 1),
				actionButton("Read only", CID.mcpLinkPick(serverId, "r"), 2),
			]),
		],
	);
}

async function completeLink(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
	userId: string,
	guildId: string,
	serverId: string,
	preset: string,
): Promise<void> {
	const answer = responder(ctx, interaction);
	await answer.defer();
	const servers = await ctx.gateway.servers(userId);
	const server = servers.find((candidate) => candidate.id === serverId);
	if (!server) {
		await answer.update("That hosted server is no longer available.");
		return;
	}
	const tools = preset === "r" ? readOnly(server.tools) : server.tools;
	const granted = await ctx.gateway.grant(userId, guildId, serverId, tools);
	const link: McpLink = {
		id: crypto.randomUUID(),
		kind: "eryn",
		name: server.name,
		url: granted.url,
		mcpServerId: serverId,
		token: granted.token,
		tools,
		createdAt: Date.now(),
	};
	await session.addLink(link);
	await answer.update(
		`Linked **${server.title ?? server.name}** to this server (${preset === "r" ? "read only" : "read + write"}). Eryn will use it on the next turn.`,
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
	const providers = (await session.providers()).filter(
		(provider) => provider.methods.some((method) => method.supported) || provider.connected,
	);
	const matches = providers
		.filter(
			(provider) =>
				!needle ||
				provider.id.toLowerCase().includes(needle) ||
				provider.name.toLowerCase().includes(needle),
		)
		.sort((a, b) => providerRank(a) - providerRank(b) || a.name.localeCompare(b.name))
		.slice(0, MAX_SELECT_OPTIONS);
	if (!matches.length) {
		await answer.reply(`No provider matches “${query.trim()}”. Try a shorter search.`);
		return;
	}
	const options: DiscordSelectOption[] = matches.map((provider) => ({
		label: provider.name.slice(0, 100),
		value: provider.id,
		description: (provider.connected ? "connected" : provider.methods.map((method) => method.label).join(", ")).slice(0, 100),
	}));
	await answer.reply(
		matches.length === MAX_SELECT_OPTIONS
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
	await answer.reply(
		result.error
			? `Could not finish **${integrationID}**: ${result.error}`
			: `**${integrationID} is connected.** Eryn will use it on the next turn.`,
	);
}

async function handleModal(ctx: CommandContext, interaction: DiscordInteraction): Promise<void> {
	const customId = interaction.data?.custom_id;
	const guildId = interaction.guild_id;
	if (!customId) return;
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
		if (!rest.startsWith("key:")) return;
		const integrationID = rest.slice("key:".length);
		return await guarded(ctx, interaction, "reply", async () => {
			const key = values.key?.trim();
			if (!key) {
				await responder(ctx, interaction).reply("No key was provided.");
				return;
			}
			const result = await session.providerConnect({ guildId: dmGuildId, integrationID, key, methodID: "key" });
			await responder(ctx, interaction).reply(
				result.error
					? `Could not connect **${integrationID}**: ${result.error}`
					: `**${integrationID} is connected.** Eryn will use it on the next turn.`,
			);
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
			await responder(ctx, interaction).reply(
				result.error ? `Could not connect **${integrationID}**: ${result.error}` : `**${integrationID} is connected.** Eryn will use it on the next turn.`,
			);
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
	if (customId === CID.modelModal) {
		const model = values.model?.trim();
		return await guarded(ctx, interaction, "reply", async () => {
			if (!model) {
				await responder(ctx, interaction).reply("No model was provided.");
				return;
			}
			await session.setModel(model);
			await responder(ctx, interaction).reply(`Model set to \`${model}\`.`);
		});
	}
	if (customId === CID.mcpAddModal) {
		return await guarded(ctx, interaction, "reply", async () => mcpAdd(ctx, interaction, session, values));
	}
}

async function mcpAdd(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	session: SessionClient,
	values: Record<string, string>,
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

	// Eryn's own endpoints have an internal path that needs no browser, so send
	// the user there instead of running an OAuth flow against ourselves.
	if (endpoint.origin === publicOrigin(ctx.env) && endpoint.pathname.startsWith("/mcp/")) {
		await answer.reply(
			"That URL is an Eryn-hosted server. Use the **Eryn-hosted** button in `/eryn mcp add` (or `/eryn mcp link`) to link it without a sign-in.",
		);
		return;
	}

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
				...(probe.resourceMetadataUrl ? { resourceMetadataUrl: probe.resourceMetadataUrl } : {}),
				...(probe.scope ? { scope: probe.scope } : {}),
			});
			if (started.ok && started.url && started.attemptId) {
				await answer.reply(
					[
						`**${name}** needs you to sign in before Eryn can use it.`,
						"",
						"Open the link, approve the access, then press **I've finished**. The sign-in finishes in your browser, so this message can stay here.",
					].join("\n"),
					[
						buttonRow([
							linkButton("Sign in", started.url),
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
					`If you have a token for it, run \`/eryn mcp add url:${url}\` and paste it in the modal.`,
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
		kind: "external",
		name,
		url,
		tools: { groups: {} },
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
			`The sign-in did not complete: ${status.message ?? "the server gave no reason"}.\n\nStart again with \`/eryn mcp add\`.`,
		);
		return;
	}
	if (status.status === "missing") {
		await answer.update("That sign-in is no longer available. Start again with `/eryn mcp add`.");
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

/** Narrow a server's access to read only, keeping its per-tool overrides. */
function readOnly(tools: ToolAccess): ToolAccess {
	const groups: Record<string, "none" | "read" | "write" | "all"> = {};
	for (const [group, level] of Object.entries(tools.groups)) {
		groups[group] = level === "none" ? "none" : "read";
	}
	return { groups, ...(tools.tools ? { tools: tools.tools } : {}) };
}

function linkOptions(links: readonly McpLink[]): DiscordSelectOption[] {
	return links.slice(0, MAX_SELECT_OPTIONS).map((link) => ({
		label: link.name.slice(0, 100),
		value: link.id,
		description: link.kind === "eryn" ? "Eryn-hosted" : "External",
	}));
}

function formatLinks(links: readonly McpLink[]): string {
	if (!links.length) return "No MCP servers are linked to this server.";
	const shown = links.slice(0, 15);
	const lines = shown.map((link) => {
		const source = link.kind === "eryn" ? "Eryn-hosted" : "External";
		return `• **${link.name}** — ${source} (${hostOf(link.url)})`;
	});
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

function helpText(ctx: CommandContext): string {
	return [
		"**Eryn setup**",
		"• `/eryn setup provider` — connect an inference provider for this server",
		"• `/eryn setup model` — choose which model Eryn runs",
		"• `/eryn setup status` — what this server has configured",
		"• `/eryn mcp add` — link one of your hosted servers, or add and test an external one",
		"• `/eryn mcp test` / `list` / `remove` — manage linked MCP servers",
		"• `/eryn stop` — stop the run in this thread",
		`\nAccounts and Eryn-hosted MCP servers are managed at ${publicOrigin(ctx.env)}/console.`,
	].join("\n");
}

/** `HostedServer` is re-exported so callers can name the shape. */
export type { HostedServer };
