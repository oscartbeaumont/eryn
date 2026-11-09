/**
 * Interaction dispatch for the bot.
 *
 * One global `/eryn` command group routes into the setup menu, and a component
 * or modal is handed to the flow that raised it. Everything here is ephemeral
 * and every flow keeps its own state, so this module is only the directory of
 * who owns which id.
 */

import { Equal } from "effect";

import type { DiscordCommand, DiscordCommandOption } from "../../discord/api";
import type { DiscordInteraction } from "../../discord/socket";
import { modalValues } from "../../discord/socket";
import { describeError } from "../../errors";
import { scopedId, unmarshalId } from "../ids";
import {
	canManage,
	denyConfiguration,
	guarded,
	rejectInteraction,
	responder,
	textInput,
	textModal,
	type CommandContext,
	type InteractionRequest,
} from "./interaction";
import { mcpComponent, mcpModal } from "./mcp";
import { modelComponent, modelModalSubmit, modelScreen } from "./models";
import { policyComponent, policyMenu } from "./policy";
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
			{ name: "policy", description: "Restrict what Eryn may do in this channel or thread", type: 1 },
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
	return Equal.equals(registered.map(shape), desired.map(shape));
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
	policyComponent,
];

const MODAL_HANDLERS: readonly Handler<Record<string, string>>[] = [providerModal, modelModalSubmit, mcpModal];

/** Dispatch any interaction Eryn receives. */
export async function handleInteraction(ctx: CommandContext, interaction: DiscordInteraction): Promise<void> {
	// A component carries the select's values; a modal carries its fields.
	const customId = interaction.data?.custom_id;
	switch (interaction.type) {
		case 2:
			return await handleCommand(ctx, interaction);
		case 3:
			// Approvals and form cards belong to the conversation, not to the
			// setup flow: a requester without Manage Server can still answer one.
			if (customId?.startsWith("approval:")) return await handleApproval(ctx, interaction, customId);
			if (customId?.startsWith("form:")) return await handleFormComponent(ctx, interaction, customId);
			return await dispatch(ctx, interaction, COMPONENT_HANDLERS, interaction.data?.values ?? []);
		case 5:
			if (customId?.startsWith("form:modal:")) {
				return await handleFormModal(ctx, interaction, customId, modalValues(interaction));
			}
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
	return {
		ctx,
		interaction,
		guildId,
		dmGuildId,
		session: ctx.session(guildId),
		id: (base) => scopedId(base, dmGuildId),
	};
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
		case "policy":
			return await guarded(request, "reply", () => policyMenu(request));
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

// --- Approval and MCP-form cards ---------------------------------------------

/** Answer a permission card. `approval:<once|always|block>:<requestId>`. */
async function handleApproval(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	customId: string,
): Promise<void> {
	const guildId = interaction.guild_id;
	const channelId = interaction.channel_id;
	const [, decision, ...rest] = customId.split(":");
	const requestId = rest.join(":");
	if (
		!guildId ||
		!channelId ||
		!requestId ||
		(decision !== "once" && decision !== "always" && decision !== "block")
	) {
		return;
	}
	await ctx.rest.interactionDefer(interaction.id, interaction.token, true).catch(() => undefined);
	const userId = interaction.member?.user?.id ?? interaction.user?.id;
	const result = await ctx
		.session(guildId)
		.replyApproval({
			threadId: channelId,
			requestId,
			decision,
			...(userId ? { userId } : {}),
			manager: canManage(interaction),
		})
		.catch((error) => ({ ok: false, message: describeError(error) }));
	const message = result.ok
		? decision === "block"
			? "Blocked in this conversation."
			: "Approved."
		: result.message ?? "That request is no longer waiting.";
	await ctx.rest
		.interactionEditOriginal(ctx.applicationId, interaction.token, message, { components: [] })
		.catch(() => undefined);
}

/** Open, or acknowledge, an MCP form card. `form:<open|done>:<formId>`. */
async function handleFormComponent(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	customId: string,
): Promise<void> {
	const guildId = interaction.guild_id;
	if (!guildId) return;
	const [, action, ...rest] = customId.split(":");
	const formId = rest.join(":");
	if (!formId) return;
	const session = ctx.session(guildId);
	const userId = interaction.member?.user?.id ?? interaction.user?.id;
	const manager = canManage(interaction);

	if (action === "done" || action === "cancel") {
		await ctx.rest.interactionDefer(interaction.id, interaction.token, true).catch(() => undefined);
		const result =
			action === "done"
				? await session
						.replyForm(formId, {}, { ...(userId ? { userId } : {}), manager })
						.catch((error) => ({ ok: false, message: describeError(error) }))
				: await session
						.cancelForm(formId, { ...(userId ? { userId } : {}), manager })
						.catch((error) => ({ ok: false, message: describeError(error) }));
		await ctx.rest
			.interactionEditOriginal(
				ctx.applicationId,
				interaction.token,
				result.ok
					? action === "done"
						? "Answered."
						: "Cancelled."
					: result.message ?? "That form is no longer waiting.",
				{ components: [] },
			)
			.catch(() => undefined);
		return;
	}

	if (action !== "open") return;
	const view = await session.form(formId, { ...(userId ? { userId } : {}), manager }).catch(() => undefined);
	if (!view) {
		await rejectInteraction(ctx, interaction, "That form is no longer waiting.");
		return;
	}
	const fields = view.fields.slice(0, 5);
	const hint = (field: (typeof fields)[number]) =>
		field.type === "boolean" ? " (yes/no)" : field.type === "number" || field.type === "integer" ? " (number)" : "";
	await ctx.rest
		.interactionModal(
			interaction.id,
			interaction.token,
			textModal(
				`form:modal:${formId}`,
				view.title.slice(0, 45),
				fields.map((field, index) =>
					textInput({
						custom_id: `f${index}`,
						label: `${field.title}${hint(field)}`.slice(0, 45),
						required: field.required,
						max_length: 1_000,
						...(field.description || field.placeholder
							? { placeholder: (field.description ?? field.placeholder ?? "").slice(0, 100) }
							: {}),
					}),
				),
			),
		)
		.catch(() => undefined);
}

/** A submitted MCP form modal. `form:modal:<formId>`. */
async function handleFormModal(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	customId: string,
	values: Record<string, string>,
): Promise<void> {
	const guildId = interaction.guild_id;
	if (!guildId) return;
	const formId = customId.slice("form:modal:".length);
	const userId = interaction.member?.user?.id ?? interaction.user?.id;
	await ctx.rest.interactionDefer(interaction.id, interaction.token, true).catch(() => undefined);
	const result = await ctx
		.session(guildId)
		.replyForm(formId, values, { ...(userId ? { userId } : {}), manager: canManage(interaction) })
		.catch((error) => ({ ok: false, message: describeError(error) }));
	await ctx.rest
		.interactionEditOriginal(
			ctx.applicationId,
			interaction.token,
			result.ok ? "Answered." : result.message ?? "That form is no longer waiting.",
			{ components: [] },
		)
		.catch(() => undefined);
}
