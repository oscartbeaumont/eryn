/**
 * Where a thread's conversation lives, in Discord terms.
 *
 * The agent has no way to discover this for itself: it never sees the channel
 * list, and its tools only reach the workspace and GitHub. So the gateway
 * describes the invocation site, the session object stores that description in
 * the session's metadata, and the `eryn.discord` plugin reads it back into the
 * system prompt of every request.
 *
 * The description is stable for the life of a thread — only the author varies
 * per message, and that belongs on the user message rather than here.
 */

/** Metadata key holding a thread's Discord context on its OpenCode session. */
export const DISCORD_METADATA_KEY = "discord";

/**
 * A named Discord entity. The id is always known; the name is what the model
 * can actually use, and is absent only when Discord did not give us one.
 */
type DiscordRef = { id: string; name?: string };

export type DiscordContext = {
	/** The server the bot was invoked in. */
	guild: DiscordRef;
	/** The channel the bot was invoked in — the thread's parent, when there is one. */
	channel: DiscordRef;
	/** The thread the conversation happens in, and where replies are posted. */
	thread: DiscordRef;
};

/** Escape a value for an XML attribute, so a channel named `&` cannot break the block. */
function escape(value: string): string {
	return value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** One named entity, ignoring anything that is not a usable id. */
function readRef(value: unknown): DiscordRef | undefined {
	if (!value || typeof value !== "object") return undefined;
	const shape = value as { id?: unknown; name?: unknown };
	if (typeof shape.id !== "string" || !shape.id) return undefined;
	const name = typeof shape.name === "string" && shape.name ? shape.name : undefined;
	return name ? { id: shape.id, name } : { id: shape.id };
}

/**
 * Read a context back out of a session's metadata.
 *
 * Metadata is free-form JSON that any plugin can write, so this validates
 * rather than trusts: a malformed value is simply no context at all, and the
 * plugin then adds nothing.
 */
export function readDiscordContext(metadata: Record<string, unknown> | undefined): DiscordContext | undefined {
	const value = metadata?.[DISCORD_METADATA_KEY];
	if (!value || typeof value !== "object") return undefined;
	const shape = value as { guild?: unknown; channel?: unknown; thread?: unknown };
	const guild = readRef(shape.guild);
	const channel = readRef(shape.channel);
	const thread = readRef(shape.thread);
	if (!guild || !channel || !thread) return undefined;
	return { guild, channel, thread };
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
