/**
 * Where a thread's conversation lives, in Discord terms.
 *
 * The agent has no way to discover this for itself: it never sees the channel
 * list, and its tools only reach the workspace. So the gateway describes the
 * invocation site, the session object stores that description in the session's
 * metadata, and the `eryn.discord` plugin reads it back into the system prompt
 * of every request.
 *
 * The description is parsed with Effect `Schema` rather than trusted: metadata
 * is free-form JSON that any plugin can write.
 */

import { Option, Schema } from "effect";

/** Metadata key holding a thread's Discord context on its OpenCode session. */
export const DISCORD_METADATA_KEY = "discord";

/**
 * A named Discord entity. The id is always known; the name is what the model
 * can actually use, and is absent only when Discord did not give us one.
 */
export const DiscordRefSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.optional(Schema.String),
});

export const DiscordContextSchema = Schema.Struct({
	/** The server the bot was invoked in. */
	guild: DiscordRefSchema,
	/** The channel the bot was invoked in — the thread's parent, when there is one. */
	channel: DiscordRefSchema,
	/** The thread the conversation happens in, and where replies are posted. */
	thread: DiscordRefSchema,
});

export type DiscordContext = typeof DiscordContextSchema.Type;

/** Escape a value for an XML attribute, so a channel named `&` cannot break the block. */
function escape(value: string): string {
	return value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/**
 * Read a context back out of a session's metadata, or `undefined` when it is
 * absent or malformed.
 */
export function readDiscordContext(metadata: Record<string, unknown> | undefined): DiscordContext | undefined {
	const value = metadata?.[DISCORD_METADATA_KEY];
	if (value === undefined) return undefined;
	const parsed = Schema.decodeUnknownOption(DiscordContextSchema)(value);
	return Option.isSome(parsed) ? parsed.value : undefined;
}

/**
 * Render the context for the model, as the same self-closing element shape the
 * session plugin uses: compact, unambiguous, and impossible to mistake for a
 * user message.
 */
export function describeDiscordContext(context: DiscordContext): string {
	const attributes: [string, string][] = [
		["guild", context.guild.name ?? context.guild.id],
		["guildId", context.guild.id],
		["channel", context.channel.name ?? context.channel.id],
		["channelId", context.channel.id],
		["thread", context.thread.name ?? context.thread.id],
		["threadId", context.thread.id],
	];
	return `<discord ${attributes.map(([name, value]) => `${name}="${escape(value)}"`).join(" ")} />`;
}

/** The marker {@link describeDiscordContext} emits, for callers that must not repeat themselves. */
export const DISCORD_MARKER = "<discord ";
