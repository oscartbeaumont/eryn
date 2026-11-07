/**
 * Interaction dispatch for the bot.
 *
 * One global `/eryn` command group routes into the setup menu, and a component
 * or modal is handed to the flow that raised it. Everything here is ephemeral
 * and every flow keeps its own state, so this module is only the directory of
 * who owns which id.
 */

import type { DiscordCommand, DiscordCommandOption } from "../../discord/api";
import type { DiscordInteraction } from "../../discord/socket";
import { modalValues } from "../../discord/socket";
import { unmarshalId } from "../ids";
import {
	canManage,
	denyConfiguration,
	guarded,
	rejectInteraction,
	responder,
	type CommandContext,
	type InteractionRequest,
} from "./interaction";
import { mcpComponent, mcpModal } from "./mcp";
import { modelComponent, modelModalSubmit, modelScreen } from "./models";
import { providerComponent, providerModal, providerScreen } from "./providers";
import { helpText, setupComponent, setupMenu } from "./setup";

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

/** A handler for the ids one flow raised; it answers the ones it recognises. */
type Handler<Values> = (
	request: InteractionRequest,
	customId: string,
	values: Values,
) => Promise<boolean>;

const COMPONENT_HANDLERS: readonly Handler<readonly string[]>[] = [
	setupComponent,
	providerComponent,
	modelComponent,
	mcpComponent,
];

const MODAL_HANDLERS: readonly Handler<Record<string, string>>[] = [providerModal, modelModalSubmit, mcpModal];

/** Dispatch any interaction Eryn receives. */
export async function handleInteraction(ctx: CommandContext, interaction: DiscordInteraction): Promise<void> {
	// A component carries the select's values; a modal carries its fields.
	switch (interaction.type) {
		case 2:
			return await handleCommand(ctx, interaction);
		case 3:
			return await dispatch(ctx, interaction, COMPONENT_HANDLERS, interaction.data?.values ?? []);
		case 5:
			return await dispatch(ctx, interaction, MODAL_HANDLERS, modalValues(interaction));
	}
}

/** The session and id scope for one interaction, resolved from its guild. */
function requestFor(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	guildId: string,
	dmGuildId?: string,
): InteractionRequest {
	return { ctx, interaction, guildId, dmGuildId, session: ctx.session(guildId) };
}

// --- Application commands ------------------------------------------------------

async function handleCommand(ctx: CommandContext, interaction: DiscordInteraction): Promise<void> {
	const data = interaction.data;
	if (data?.name !== "eryn") return;
	const group = data.options?.[0];
	const sub = group?.type === 2 ? group.options?.[0] : group;
	const command = sub?.name;
	const path = group && group.type === 2 && command ? `${group.name}:${command}` : command;

	const guildId = interaction.guild_id;
	if (!guildId) {
		await rejectInteraction(ctx, interaction, "Run `/eryn` inside a server, so I know which setup to change.");
		return;
	}
	// Stopping a run and reading help are not configuration; everything else is.
	if (path !== "stop" && path !== "help" && !canManage(interaction)) {
		return await denyConfiguration(ctx, interaction);
	}
	const request = requestFor(ctx, interaction, guildId);

	switch (path) {
		case "setup":
		case "setup:status":
			return await guarded(request, "reply", () => setupMenu(request));
		// Old clients may still send the pre-menu subcommands.
		case "setup:provider":
			return await guarded(request, "reply", () => providerScreen(request));
		case "setup:model":
			return await guarded(request, "reply", () => modelScreen(request));
		case "stop":
			return await guarded(request, "reply", async () => {
				const channelId = interaction.channel_id;
				if (!channelId || !(await ctx.ownsConversation(channelId))) {
					await responder(request).reply("There is no Eryn run here.");
					return;
				}
				await responder(request).reply("Stopping the current run…");
				await request.session.interrupt(channelId, false).catch(() => undefined);
			});
		case "help":
			return await responder(request).reply(helpText());
		default:
			return await responder(request).reply("I did not recognise that command.");
	}
}

// --- Components and modals -----------------------------------------------------

/**
 * The guild a component or modal configures. A DM has no guild context, so ids
 * raised from the install message carry it instead; see `unmarshalId`.
 */
function resolveGuild(
	interaction: DiscordInteraction,
	customId: string,
): { customId: string; guildId: string; dmGuildId?: string } | undefined {
	const { id, dmGuildId } = unmarshalId(customId);
	// A guild always wins: old builds also posted their install button (which
	// carries a guild id) in the server, and that flow should still see the full
	// menu rather than the DM one.
	const inGuild = interaction.guild_id;
	const guildId = inGuild ?? dmGuildId;
	return guildId ? { customId: id, guildId, dmGuildId: inGuild ? undefined : dmGuildId } : undefined;
}

/** Hand a component or modal to the flow that owns its id. */
async function dispatch<Values>(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	handlers: readonly Handler<Values>[],
	values: Values,
): Promise<void> {
	const raw = interaction.data?.custom_id;
	if (!raw) return;
	if (!canManage(interaction)) return await denyConfiguration(ctx, interaction);

	const target = resolveGuild(interaction, raw);
	if (!target) {
		await rejectInteraction(ctx, interaction, "Run this inside a server.");
		return;
	}
	const request = requestFor(ctx, interaction, target.guildId, target.dmGuildId);
	for (const handle of handlers) {
		if (await handle(request, target.customId, values)) return;
	}
}
