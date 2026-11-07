/**
 * How one interaction is answered, and what the setup handlers read from.
 *
 * A responder acknowledges and edits the interaction's own message. A request
 * bundles the responder's inputs with the guild session a flow configures, so a
 * handler takes one argument instead of the same four everywhere.
 */

import { describeError } from "../../errors";
import { actionButton, buttonRow } from "../../discord/components";
import type { DiscordRest } from "../../discord/api";
import type {
	DiscordComponent,
	DiscordModal,
	DiscordTextInput,
} from "../../discord/components";
import type { DiscordInteraction } from "../../discord/socket";
import { SETUP_CLOSE_ID, scopedId } from "../ids";
import type { SessionClient } from "../client";

/** Discord caps a string select at 25 options. */
export const MAX_SELECT_OPTIONS = 25;

/** Discord's MANAGE_GUILD bit; configuration is an admin action. */
const MANAGE_GUILD = 1n << 5n;

/** The world the command handlers read from. */
export interface CommandContext {
	readonly env: Env;
	readonly log: (message: string) => void;
	readonly applicationId: string;
	readonly session: (guildId: string) => SessionClient;
	readonly ownsConversation: (channelId: string) => Promise<boolean>;
	/** Remove the guild's public install greeting, whose job the setup flow has finished. */
	readonly dismissGreeting: (guildId: string) => Promise<void>;
	readonly rest: DiscordRest;
}

/** One interaction, the guild session it configures, and where its ids scope to. */
export interface InteractionRequest {
	readonly ctx: CommandContext;
	readonly interaction: DiscordInteraction;
	/** The guild the interaction configures, which for the install DM is the guild it was raised for. */
	readonly guildId: string;
	/** Set when the flow was opened from the install DM, which has no guild context of its own. */
	readonly dmGuildId?: string;
	readonly session: SessionClient;
}

/**
 * Interactions that have already been acknowledged.
 *
 * A responder can be created more than once for one interaction (a helper hands
 * off to another), so the "already acknowledged" state has to live outside any
 * single responder: a second acknowledgement is an error, while an edit is not.
 */
const acknowledged = new WeakSet<DiscordInteraction>();

export function responder(request: InteractionRequest) {
	const { ctx, interaction } = request;
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
		/**
		 * Acknowledge with a new ephemeral message instead of editing the one the
		 * component came from. A public message (the install greeting) must never
		 * be edited into the setup menu, or the whole channel would see it.
		 */
		deferNew: async () => {
			if (acknowledged.has(interaction)) return;
			acknowledged.add(interaction);
			await ctx.rest.interactionDefer(interaction.id, interaction.token, true);
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
		/**
		 * Dismiss the menu.
		 *
		 * The interaction still has to be acknowledged: a component defers its
		 * update, so the message does not flash, and then it is deleted. Every
		 * menu is ephemeral, so nothing is left behind for anyone else.
		 */
		close: async () => {
			if (!acknowledged.has(interaction)) {
				acknowledged.add(interaction);
				if (interaction.type === 3) await ctx.rest.interactionDeferUpdate(interaction.id, interaction.token);
				else await ctx.rest.interactionDefer(interaction.id, interaction.token, true);
			}
			await ctx.rest.interactionDeleteOriginal(ctx.applicationId, interaction.token);
		},
		modal: (modal: DiscordModal) => ctx.rest.interactionModal(interaction.id, interaction.token, modal),
	};
}

/** Run a handler, and always answer the interaction even when it throws. */
export async function guarded(
	request: InteractionRequest,
	kind: "reply" | "update",
	run: () => Promise<void>,
): Promise<void> {
	try {
		await run();
	} catch (error) {
		request.ctx.log(`interaction failed: ${describeError(error)}`);
		const message = `That did not work: ${describeError(error)}`;
		const answer = responder(request);
		// Leave an escape hatch: an unexpected failure must not strand the admin on
		// a message with no controls.
		const components = [
			buttonRow([actionButton("Close", scopedId(SETUP_CLOSE_ID, request.dmGuildId), 2)]),
		];
		await (kind === "update" ? answer.update(message, components) : answer.reply(message, components)).catch(
			() => undefined,
		);
	}
}

/** Answer an interaction that cannot be served, before any guild session exists. */
export async function rejectInteraction(
	ctx: CommandContext,
	interaction: DiscordInteraction,
	message: string,
): Promise<void> {
	await ctx.rest.interactionReply(interaction.id, interaction.token, message, { ephemeral: true }).catch(() => undefined);
}

/** Ask an interaction's author to let someone with Manage Server change the setup. */
export async function denyConfiguration(ctx: CommandContext, interaction: DiscordInteraction): Promise<void> {
	await rejectInteraction(ctx, interaction, "Only someone with Manage Server can change Eryn's setup.");
}

export function canManage(interaction: DiscordInteraction): boolean {
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

/** A single-line text input, the only kind these modals use. */
export function textInput(input: Omit<DiscordTextInput, "type" | "style">): DiscordTextInput {
	return { type: 4, style: 1, ...input };
}

/** One input per row, which is how Discord lays a simple form out. */
export function textModal(customId: string, title: string, inputs: readonly DiscordTextInput[]): DiscordModal {
	return {
		custom_id: customId,
		title,
		components: inputs.map((input) => ({ type: 1, components: [input] })),
	};
}
