/**
 * The OpenCode plugins Eryn's embedded host loads.
 *
 * Each plugin lives in its own directory. The host builder imports the ones it
 * needs directly; this barrel is the short list of everything available.
 */

export { commandShellPlugin } from "./commands/index.ts";

export { dynamicPluginsPlugin, loadPlugin } from "./dynamic/index.ts";

export { agentInstructionsPlugin } from "./instructions/index.ts";

export { workspaceSkillsPlugin } from "./skills/index.ts";

export { workspacePlugin } from "./workspace/index.ts";
