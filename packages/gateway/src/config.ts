/**
 * Gateway-wide constants.
 *
 * The origin is the one an OAuth client is sent back to and the one linked from
 * anywhere a user is told where to go. It is a binding, but this is the fallback
 * when the binding is unset.
 */

/** The path the MCP endpoints live under; each hosted server appends its name. */
export const MCP_PATH = "/mcp";

/** The console route a client is sent to for consent (a client-side page). */
export const AUTHORIZE_PATH = "/console/authorize";

/** Where an account's OAuth flow sends the browser back. */
export const GITHUB_CALLBACK_PATH = "/github/callback";
export const GOOGLE_CALLBACK_PATH = "/google/callback";

/** Where the console's Discord sign-in sends the browser back. */
export const DISCORD_CALLBACK_PATH = "/auth/callback";

export const DEFAULT_ORIGIN = "https://eryn.otbeaumont.me";

/** The single OAuth scope the MCP endpoint exposes. */
export const MCP_SCOPE = "mcp";

/** How long the console's signed-in session lasts. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

/** How long a one-shot OAuth `state` is valid. */
export const STATE_TTL_MS = 10 * 60 * 1_000;

/** The groups a tool can belong to, in the order the console shows them. */
export const TOOL_GROUPS = ["builtin", "discord", "github", "google_calendar"] as const;
export type ToolGroup = (typeof TOOL_GROUPS)[number];

export const TOOL_GROUP_NAMES: Record<ToolGroup, string> = {
	builtin: "Built in",
	discord: "Discord",
	github: "GitHub",
	google_calendar: "Google Calendar",
};
