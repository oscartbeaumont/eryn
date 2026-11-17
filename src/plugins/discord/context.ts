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

import { selfClosing } from "../../discord/xml.ts";
import { DiscordContextSchema, type DiscordContext } from "../../session/models.ts";

/** Metadata key holding a conversation's Discord context on its OpenCode session. */
export const DISCORD_METADATA_KEY = "discord";

/**
 * Read a context back out of a session's metadata, or `undefined` when it is
 * absent or malformed.
 */
export function readDiscordContext(metadata: Schema.JsonObject | undefined): DiscordContext | undefined {
	const parsed = Schema.decodeUnknownOption(DiscordContextSchema)(metadata?.[DISCORD_METADATA_KEY]);

	return Option.isSome(parsed) ? parsed.value : undefined;
}

/** Render the context as a self-closing reference the model cannot mistake for a message. */
export function describeDiscordContext(context: DiscordContext): string {
	const kind = context.kind ?? "thread";

	// `authorId`, `scheduleTurn`, and `scheduleScope` are deliberately not
	// rendered: they are authorization inputs the tools read, not things the
	// model needs in its prompt.
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

	return `${DISCORD_MARKER}\n${selfClosing("discord", entries)}`;
}

/**
 * A per-session queue for read-modify-write cycles on the Discord metadata.
 *
 * The context lives in one metadata key, and the schedule hooks and the Discord
 * tools both update it. Two parallel `schedule_create` calls would otherwise
 * read the same context and the second write would drop the first schedule's
 * id, leaving a scope that no longer covers an active schedule.
 */
const metadataQueues = new Map<string, Promise<void>>();

export function withDiscordMetadataLock<T>(sessionID: string, task: () => Promise<T>): Promise<T> {
	const previous = metadataQueues.get(sessionID) ?? Promise.resolve();
	const next = previous.then(task, task);

	const tail = next.then(
		() => undefined,
		() => undefined,
	);

	metadataQueues.set(sessionID, tail);
	void tail.finally(() => {
		if (metadataQueues.get(sessionID) === tail) metadataQueues.delete(sessionID);
	});

	return next;
}

/**
 * The marker {@link describeDiscordContext} emits, for callers that must not
 * repeat themselves.
 *
 * It has to be unique to this block: the instructions and skills Eryn ships
 * mention `<discord ... />` in prose, and a bare tag prefix would make the
 * prompt hook think the real context was already added and skip it.
 */
export const DISCORD_MARKER = "<!-- eryn:discord -->";
