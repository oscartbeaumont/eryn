/**
 * The OpenCode plugins Eryn's embedded host loads.
 *
 * Each plugin lives in its own directory and owns everything it needs. This
 * file is the barrel the host builder imports from, so adding or removing a
 * plugin is a one-line change here rather than a hunt through the agent.
 */

export { discordPlugin } from "./discord";
export { DISCORD_METADATA_KEY, readDiscordContext } from "./discord/context";
export { mcpGuidancePlugin } from "./guidance";
export { agentInstructionsPlugin } from "./instructions";
export { workspacePlugin } from "./workspace";
