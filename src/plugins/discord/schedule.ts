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
import { Option, Schema } from "effect";

import { log } from "../../config";
import type { DiscordRest } from "../../discord/api";
import { DiscordAuthority } from "../../discord/authority";
import { describeError } from "../../errors";
import { jsonField, stringField } from "../../json.ts";
import type { DiscordContext, ScheduleScope } from "../../session/models";
import {
	addChannelToScope,
	addScheduleToScope,
	canCreateSchedule,
	defaultScheduleScope,
	removeScheduleFromScope,
	type ScopeChannelCapabilities,
} from "../../session/schedule-scope";
import { DISCORD_METADATA_KEY, readDiscordContext, withDiscordMetadataLock } from "./context";

type ScheduleTool = "create" | "delete";

/** The effective tool name is `opencode_schedule_create` or similar. */
function scheduleTool(tool: string): ScheduleTool | undefined {
	const name = tool.slice(tool.lastIndexOf(".") + 1);

	if (name === "schedule_create" || name.endsWith("_schedule_create")) return "create";

	if (name === "schedule_delete" || name.endsWith("_schedule_delete")) return "delete";

	return undefined;
}

function scheduleId(value: Schema.Json | undefined): string | undefined {
	return stringField(value, "id") ?? stringField(jsonField(value, "output"), "id");
}

async function readContext(ctx: Plugin.Context, sessionID: string): Promise<DiscordContext | undefined> {
	const session = await ctx.session.get({ sessionID }).catch((error) => {
		log("discord-plugin", `could not read ${sessionID} for a schedule: ${describeError(error)}`);

		return undefined;
	});

	return readDiscordContext(session?.metadata);
}

/**
 * The creator's actual reach in the conversation.
 *
 * A missing channel or failed lookup returns undefined so creation fails
 * closed. The scope gets exactly these capabilities, so a schedule can never
 * do more in the conversation than the person who created it.
 */
async function conversationCapabilities(
	input: ScheduleScopeInput,
	context: DiscordContext,
	authorId: string,
): Promise<ScopeChannelCapabilities | undefined> {
	const info = await input.rest.channel(context.thread.id).catch(() => undefined);

	if (!info || info.guild_id !== input.guildId) return undefined;

	return await input.authority.scopeCapabilities(authorId, info);
}

/** Everything the schedule-scope plugin needs from the host that registers it. */
export interface ScheduleScopeInput {
	readonly ctx: Plugin.Context;
	readonly rest: DiscordRest;
	readonly guildId: string;
	readonly authority: DiscordAuthority;
	readonly onCreated?: (threadId: string) => void;
}

/** A write `writeScope` should make: `undefined` means nothing to change. */
type ScopeUpdate = { readonly scope: ScheduleScope | undefined } | undefined;

/**
 * Apply a scope change to the freshest copy of the session's context.
 *
 * The read-modify-write runs under the shared metadata lock, so two parallel
 * `schedule_create` calls cannot each write a scope that knows only about its
 * own schedule and silently drop the other's id.
 */
async function writeScope(
	ctx: Plugin.Context,
	sessionID: string,
	update: (latest: DiscordContext) => ScopeUpdate,
): Promise<void> {
	await withDiscordMetadataLock(sessionID, async () => {
		const session = await ctx.session.get({ sessionID }).catch((error) => {
			log("discord-plugin", `could not read ${sessionID} for a schedule: ${describeError(error)}`);

			return undefined;
		});

		const latest = readDiscordContext(session?.metadata);

		if (!session || !latest) return;
		const next = update(latest);

		if (!next) return;
		// SAFETY: OpenCode spells metadata JSON with mutable arrays, while a decoded
		// `DiscordContext` holds readonly ones; it is the same JSON.
		await ctx.session.update({
			sessionID,
			metadata: {
				...session.metadata,
				// Merge rather than replace: the Discord context is shared with the
				// session object, and this update must not drop its author, policy
				// inputs, or any other plugin's metadata.
				[DISCORD_METADATA_KEY]: next.scope
					? { ...latest, scheduleScope: next.scope }
					: { ...latest, scheduleScope: undefined },
			} as never,
		});
	});
}

export async function registerScheduleScope(input: ScheduleScopeInput): Promise<void> {
	const { ctx, onCreated } = input;

	await ctx.tool.hook("execute.before", async (event) => {
		if (scheduleTool(event.tool) !== "create") return;
		const context = await readContext(ctx, event.sessionID);
		const scope = context?.scheduleScope;
		const authorId = context?.authorId;

		if (!context || !authorId || !canCreateSchedule(scope, authorId)) {
			throw new Error(
				scope
					? "Only the person who created this conversation's schedules can add another."
					: "A schedule needs a person to create it in this conversation.",
			);
		}

		// A schedule may not read or send where its creator cannot. Fail before
		// the schedule exists rather than storing a scope it cannot justify.
		const capabilities = await conversationCapabilities(input, context, authorId);

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
		const context = await readContext(ctx, event.sessionID);

		if (!context) return;

		if (kind === "create") {
			const id = scheduleId(event.result.output);

			// Without the returned id there is no safe scope to grant. The
			// schedule still exists, but its turns fail closed as no-speaker
			// turns until a scope can be recorded.
			if (!id) {
				log("discord-plugin", `schedule_create for ${event.sessionID} returned no id`);

				return;
			}

			const ownerId = context.authorId;

			if (!ownerId || !canCreateSchedule(context.scheduleScope, ownerId)) return;
			const now = Date.now();
			const capabilities = await conversationCapabilities(input, context, ownerId);

			// Without at least one capability there is no justified scope. The
			// schedule exists, but its turns fail closed as no-speaker turns.
			if (!capabilities || (!capabilities.read && !capabilities.send)) return;
			await writeScope(ctx, event.sessionID, (latest) => {
				const latestOwner = latest.authorId;

				if (!latestOwner || !canCreateSchedule(latest.scheduleScope, latestOwner)) return undefined;

				const existing = latest.scheduleScope
					? addChannelToScope(latest.scheduleScope, latest.thread.id, capabilities, now)
					: defaultScheduleScope({
							ownerId: latestOwner,
							conversationId: latest.thread.id,
							scheduleId: id,
							capabilities,
							now,
						});

				return { scope: addScheduleToScope(existing, id, now) };
			}).catch((error) => log("discord-plugin", `could not record a schedule scope: ${describeError(error)}`));
			onCreated?.(context.thread.id);

			return;
		}

		if (!context.scheduleScope) return;

		const id =
			scheduleId(Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Json)(event.input))) ??
			scheduleId(event.result.output);

		if (!id) return;
		await writeScope(ctx, event.sessionID, (latest) => {
			if (!latest.scheduleScope) return undefined;
			const next = removeScheduleFromScope(latest.scheduleScope, id, Date.now());

			return { scope: next.scheduleIds.length ? next : undefined };
		}).catch((error) => log("discord-plugin", `could not update a schedule scope: ${describeError(error)}`));
	});
}
