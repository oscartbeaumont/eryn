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

/** Where the agent's project lives. Mirrors OpenCode's own `/workspace` convention. */
export const WORKSPACE_ROOT = "/workspace";

/** The guild's editable OpenCode files, outside the agent's project. */
export const CONFIG_ROOT = LOCATION;
export const CONFIG_PATH = `${CONFIG_ROOT}/opencode.jsonc`;
export const LEGACY_CONFIG_PATH = `${CONFIG_ROOT}/opencode.json`;
export const COMMANDS_ROOT = `${CONFIG_ROOT}/.opencode/commands`;
export const SKILLS_ROOT = `${CONFIG_ROOT}/.opencode/skills`;
export const AGENTS_ROOT = `${CONFIG_ROOT}/.opencode/agents`;
export const LEGACY_AGENTS_ROOT = `${CONFIG_ROOT}/.opencode/agent`;
export const INSTRUCTIONS_PATH = `${CONFIG_ROOT}/AGENTS.md`;

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
