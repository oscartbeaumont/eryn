/**
 * Where a server's files live in the virtual filesystem.
 *
 * One tree per server, so a channel project is a directory inside it rather
 * than a separate mount. That is what lets an agent start in its channel while
 * still reading files the server shares with every channel.
 */

/** The server-wide root the agent sees. */
export const SERVER_ROOT = "/workspace";

/** Where Eryn keeps configuration the agent may read but the shell may not. */
export const SERVER_CONFIG = `${SERVER_ROOT}/.eryn`;

/** The channel project root: the agent's working directory. */
export function channelRoot(channelId: string): string {
	return `${SERVER_ROOT}/channels/${safeSegment(channelId)}`;
}

/** A channel's own config directory. */
export function channelConfig(channelId: string): string {
	return `${channelRoot(channelId)}/.eryn`;
}

/** The seeded server instructions. */
export const SERVER_AGENTS_PATH = `${SERVER_ROOT}/AGENTS.md`;

/** The seeded per-channel instructions. */
export function channelAgentsPath(channelId: string): string {
	return `${channelRoot(channelId)}/AGENTS.md`;
}

/** The server OpenCode config. */
export const SERVER_CONFIG_PATH = `${SERVER_CONFIG}/opencode.jsonc`;

/** A channel OpenCode config, merged over the server's. */
export function channelConfigPath(channelId: string): string {
	return `${channelConfig(channelId)}/opencode.jsonc`;
}

/** Skills, commands, and agents, server-wide. */
export const SKILLS_ROOT = `${SERVER_ROOT}/.opencode/skills`;

export const COMMANDS_ROOT = `${SERVER_ROOT}/.opencode/commands`;

export const AGENTS_ROOT = `${SERVER_ROOT}/.opencode/agents`;

/** A path segment that cannot escape the server tree. */
function safeSegment(value: string): string {
	const segment = value.replaceAll(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "");

	return segment === "" ? "unknown" : segment.slice(0, 96);
}
