/**
 * The bot's interaction surface.
 *
 * The setup flows live in `./commands/`; this module is the stable entry point
 * the gateway imports, so where a flow lives can change without the gateway
 * caring.
 */

export { erynCommand, handleInteraction, sameCommands } from "./commands/index";
export type { CommandContext } from "./commands/interaction";
