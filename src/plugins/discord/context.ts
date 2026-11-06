/**
 * Where a conversation lives, in Discord terms.
 *
 * The agent cannot discover this for itself: it never sees the channel list,
 * and its tools only reach the workspace. So the gateway describes the
 * invocation site, the session object stores that description in the session's
 * metadata, and this plugin reads it back into the system prompt of every
 * request.
 *
 * The description is parsed with Effect `Schema` rather than trusted: metadata
 * is free-form JSON that any plugin can write.
 */

import { Option, Schema } from "effect";

import { selfClosing } from "../../discord/xml";
import { DiscordContextSchema, type DiscordContext } from "../../session/models";

/** Metadata key holding a conversation's Discord context on its OpenCode session. */
export const DISCORD_METADATA_KEY = "discord";

/**
 * Read a context back out of a session's metadata, or `undefined` when it is
 * absent or malformed.
 */
export function readDiscordContext(metadata: Record<string, unknown> | undefined): DiscordContext | undefined {
	const parsed = Schema.decodeUnknownOption(DiscordContextSchema)(metadata?.[DISCORD_METADATA_KEY]);
	return Option.isSome(parsed) ? parsed.value : undefined;
}

/** Render the context as a self-closing reference the model cannot mistake for a message. */
export function describeDiscordContext(context: DiscordContext): string {
	const kind = context.kind ?? "thread";
	const entries: [string, string][] = [
		["guild", context.guild.name ?? context.guild.id],
		["guildId", context.guild.id],
		["kind", kind],
		["channel", context.channel.name ?? context.channel.id],
		["channelId", context.channel.id],
	];
	// In a subscribed channel the channel is the conversation; naming a
	// separate thread there would point the model at a thread that does not
	// exist.
	if (kind === "thread") {
		entries.push(["thread", context.thread.name ?? context.thread.id]);
		entries.push(["threadId", context.thread.id]);
	}
	return selfClosing("discord", entries);
}

/** The marker {@link describeDiscordContext} emits, for callers that must not repeat themselves. */
export const DISCORD_MARKER = "<discord ";
