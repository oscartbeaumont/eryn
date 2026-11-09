/**
 * Where a conversation's OpenCode project lives.
 *
 * Every guild object has its own host, so `/eryn` is already scoped to one
 * server. Sessions are grouped one level deeper, by Discord channel, so the
 * project list reads as channels rather than one flat list of threads. Threads
 * share their parent channel's project.
 *
 * This is only the project's location. The agent's files live in the separate
 * virtual workspace (`/workspace`), so grouping a project here does not stop it
 * reading files outside that project.
 */

/** The embedded host's deployment namespace. */
export const LOCATION = "/eryn";

/**
 * The project directory for a Discord channel.
 *
 * Discord ids are numeric snowflakes. Anything else is refused rather than
 * used as a path segment, so a malformed internal request cannot walk out of
 * the namespace. With no usable id, the conversation stays at the shared root.
 */
export function channelProjectDirectory(channelId: string | undefined): string {
	if (!channelId || !/^\d{1,32}$/.test(channelId)) return LOCATION;
	return `${LOCATION}/channels/${channelId}`;
}
