/**
 * Shared MCP constants: the public route paths and the lifetime of a sign-in.
 *
 * These live apart from the link and OAuth modules so the Worker entrypoint can
 * route the public start and callback URLs without pulling the whole MCP
 * implementation into its import graph.
 */

/** Where an authorization server sends the browser back to. */
export const MCP_CALLBACK_PATH = "/api/bot/mcp/callback";
/** Short browser hop that forwards to a long authorization URL. */
export const MCP_START_PATH = "/api/bot/mcp/start";

/** A started sign-in is valid for this long, which is how long a browser tab has. */
export const AUTH_TTL_MS = 15 * 60_000;
