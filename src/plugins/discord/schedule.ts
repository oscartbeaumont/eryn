/**
 * Keeps a conversation's schedule scope in step with its schedules.
 *
 * The built-in `opencode.schedule_create` tools run as normal agent tools, so
 * this plugin observes them: a create adds its id to the conversation's scope
 * (starting one if it is the first), and a delete removes it, clearing the
 * scope when the last schedule goes. A schedule turn has no author and is
 * rejected here, so a schedule cannot create another schedule.
 */

import type { Plugin } from "@opencode/plugin";

import { log } from "../../config";
import type { DiscordRest } from "../../discord/api";
import { DiscordAuthority } from "../../discord/authority";
import { describeError } from "../../errors";
import type { DiscordContext, ScheduleScope } from "../../session/models";
import {
	addChannelToScope,
	addScheduleToScope,
	canCreateSchedule,
	defaultScheduleScope,
	removeScheduleFromScope,
	type ScopeChannelCapabilities,
} from "../../session/schedule-scope";
import { DISCORD_METADATA_KEY, readDiscordContext } from "./context";

type ScheduleTool = "create" | "delete";

/** The JSON metadata boundary: stored scope arrays are readonly for readers. */
type SessionMetadata = NonNullable<Parameters<Plugin.Context["session"]["update"]>[0]["metadata"]>;

/** The effective tool name is `opencode_schedule_create` or similar. */
function scheduleTool(tool: string): ScheduleTool | undefined {
	const name = tool.slice(tool.lastIndexOf(".") + 1);
	if (name === "schedule_create" || name.endsWith("_schedule_create")) return "create";
	if (name === "schedule_delete" || name.endsWith("_schedule_delete")) return "delete";
	return undefined;
}

function scheduleId(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	if (typeof (value as { id?: unknown }).id === "string") return (value as { id: string }).id;
	const output = (value as { output?: unknown }).output;
	if (output && typeof output === "object" && typeof (output as { id?: unknown }).id === "string") {
		return (output as { id: string }).id;
	}
	return undefined;
}

async function readContext(
	ctx: Plugin.Context,
	sessionID: string,
): Promise<{ metadata?: Record<string, unknown>; context: DiscordContext } | undefined> {
	const session = await ctx.session.get({ sessionID }).catch((error) => {
		log("discord-plugin", `could not read ${sessionID} for a schedule: ${describeError(error)}`);
		return undefined;
	});
	const context = readDiscordContext(session?.metadata);
	return session && context ? { metadata: session.metadata, context } : undefined;
}

/**
 * The creator's actual reach in the conversation.
 *
 * A missing channel or failed lookup returns undefined so creation fails
 * closed. The scope gets exactly these capabilities, so a schedule can never
 * do more in the conversation than the person who created it.
 */
async function conversationCapabilities(
	rest: DiscordRest,
	guildId: string,
	authority: DiscordAuthority,
	context: DiscordContext,
	authorId: string,
): Promise<ScopeChannelCapabilities | undefined> {
	const info = await rest.channel(context.thread.id).catch(() => undefined);
	if (!info || info.guild_id !== guildId) return undefined;
	return await authority.scopeCapabilities(authorId, info);
}

async function writeScope(
	ctx: Plugin.Context,
	sessionID: string,
	metadata: Record<string, unknown> | undefined,
	context: DiscordContext,
	scope: ScheduleScope | undefined,
): Promise<void> {
	await ctx.session.update({
		sessionID,
		metadata: {
			...metadata,
			// Merge rather than replace: the Discord context is shared with the
			// session object, and this update must not drop its author, policy
			// inputs, or any other plugin's metadata.
			[DISCORD_METADATA_KEY]: scope ? { ...context, scheduleScope: scope } : { ...context, scheduleScope: undefined },
		} as unknown as SessionMetadata,
	});
}

export async function registerScheduleScope(
	ctx: Plugin.Context,
	rest: DiscordRest,
	guildId: string,
	authority: DiscordAuthority,
	onCreated?: (threadId: string) => void,
): Promise<void> {
	await ctx.tool.hook("execute.before", async (event) => {
		if (scheduleTool(event.tool) !== "create") return;
		const found = await readContext(ctx, event.sessionID);
		const scope = found?.context.scheduleScope;
		const authorId = found?.context.authorId;
		if (!found || !authorId || !canCreateSchedule(scope, authorId)) {
			throw new Error(
				scope
					? "Only the person who created this conversation's schedules can add another."
					: "A schedule needs a person to create it in this conversation.",
			);
		}
		// A schedule may not read or send where its creator cannot. Fail before
		// the schedule exists rather than storing a scope it cannot justify.
		const capabilities = await conversationCapabilities(rest, guildId, authority, found.context, authorId);
		if (!capabilities) {
			throw new Error("Eryn could not verify your Discord access to this conversation.");
		}
		if (!capabilities.read && !capabilities.send) {
			throw new Error("Your Discord permissions do not allow a schedule to read or send in this conversation.");
		}
	});

	await ctx.tool.hook("execute.after", async (event) => {
		if (event.status !== "completed") return;
		const kind = scheduleTool(event.tool);
		if (!kind) return;
		const found = await readContext(ctx, event.sessionID);
		if (!found) return;

		if (kind === "create") {
			const id = scheduleId(event.result);
			// Without the returned id there is no safe scope to grant. The
			// schedule still exists, but its turns fail closed as no-speaker
			// turns until a scope can be recorded.
			if (!id) {
				log("discord-plugin", `schedule_create for ${event.sessionID} returned no id`);
				return;
			}
			const { metadata, context } = found;
			if (!canCreateSchedule(context.scheduleScope, context.authorId)) return;
			const now = Date.now();
			const ownerId = context.authorId;
			if (!ownerId) return;
			const capabilities = await conversationCapabilities(rest, guildId, authority, context, ownerId);
			// Without at least one capability there is no justified scope. The
			// schedule exists, but its turns fail closed as no-speaker turns.
			if (!capabilities || (!capabilities.read && !capabilities.send)) return;
			const existing = context.scheduleScope
				? addChannelToScope(context.scheduleScope, context.thread.id, capabilities, now)
				: defaultScheduleScope({
						ownerId,
						conversationId: context.thread.id,
						scheduleId: id,
						capabilities,
						now,
					});
			const scope = addScheduleToScope(existing, id, now);
			await writeScope(ctx, event.sessionID, metadata, context, scope).catch((error) =>
				log("discord-plugin", `could not record a schedule scope: ${describeError(error)}`),
			);
			onCreated?.(context.thread.id);
			return;
		}

		const { metadata, context } = found;
		const scope = context.scheduleScope;
		if (!scope) return;
		const id = scheduleId(event.input) ?? scheduleId(event.result);
		if (!id) return;
		const next = removeScheduleFromScope(scope, id, Date.now());
		await writeScope(ctx, event.sessionID, metadata, context, next.scheduleIds.length ? next : undefined).catch(
			(error) => log("discord-plugin", `could not update a schedule scope: ${describeError(error)}`),
		);
	});
}
