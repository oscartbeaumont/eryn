/**
 * The OpenCode plugins Eryn's embedded host loads.
 *
 * Each plugin lives in its own directory and owns everything it needs. This
 * file is the barrel the host builder imports from, so adding or removing a
 * plugin is a one-line change here rather than a hunt through the agent.
 *
 * Config, skills, commands, and instructions are read from the guild's durable
 * filesystem. Plugins are bundled TypeScript because Workers cannot load or
 * evaluate plugin code at runtime.
 */

export { commandShellPlugin } from "./commands";
export { discordPlugin } from "./discord";
export { DISCORD_METADATA_KEY, readDiscordContext } from "./discord/context";
export { mcpGuidancePlugin } from "./guidance";
export { agentInstructionsPlugin } from "./instructions";
export { guildMcpPlugin } from "./mcp";
export { workspaceSkillsPlugin } from "./skills";
export { workspacePlugin } from "./workspace";
