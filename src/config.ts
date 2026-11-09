/**
 * Bot-wide constants and small helpers.
 *
 * Nothing here touches the network or storage: it is the handful of values the
 * gateway object and every guild session agree on.
 */

import { CLIENT_ID, DEFAULT_PUBLIC_ORIGIN } from "./public";

/** The default model when a guild does not choose one. */
export const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";

export { CLIENT_ID, DEFAULT_PUBLIC_ORIGIN };

/**
 * The application's Ed25519 public key, which signs every interaction Discord
 * posts to the HTTP endpoint.
 *
 * It is public, not a secret. It only changes if the key is reset in the
 * developer portal, in which case this constant has to change with it.
 */
export const APPLICATION_PUBLIC_KEY = "6655aa1a8380d798d623e3a12216e604b51e3be94f2a21fca6fcba23f87ba980";

/**
 * A value a deployment can set that the hosted build does not bind.
 *
 * A self-hosted Eryn runs its own Discord application, so it supplies its id
 * and public key; the hosted Worker has no such variables and uses the
 * constants above.
 */
function optional(env: Env, name: string): string | undefined {
	const value = (env as unknown as Record<string, unknown>)[name];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The Discord application id, which is also the bot's user id. */
export function clientId(env: Env): string {
	return optional(env, "DISCORD_CLIENT_ID") ?? CLIENT_ID;
}

/** The key Discord signs this application's interactions with. */
export function applicationPublicKey(env: Env): string {
	return optional(env, "DISCORD_PUBLIC_KEY") ?? APPLICATION_PUBLIC_KEY;
}

/** Where Discord posts interactions once the application's endpoint is set. */
export const INTERACTIONS_PATH = "/interactions";

/** Prefix on every log line this package emits. */
export const LOG_PREFIX = "eryn:bot";

/** Storage key prefixes. A shipped prefix is stable; new shapes get a new one. */
export const KEYS = {
	/** The guild's model and bookkeeping, no secrets. */
	guild: "config:guild",
	/** One connected provider credential, sealed. */
	provider: "provider:",
	/** One linked MCP server, sealed (it carries a bearer or a refresh token). */
	link: "link:",
	/** A sign-in with an external MCP server, sealed (it carries a PKCE verifier). */
	mcpAuth: "mcp:auth:",
	/** A thread's OpenCode session id. */
	session: "session:",
	/** A sign-in that has started but not finished, so a code can complete it. */
	pendingOAuth: "config:oauth",
	/** The guild's virtual filesystem, one key per absolute path. */
	fs: "fs:",
	/** The server-wide policy patch. */
	policyGuild: "policy:guild",
	/** One channel's policy patch. */
	policyChannel: "policy:channel:",
	/** One thread's policy patch. */
	policyThread: "policy:thread:",
	/** The message that announces a scope's non-default policy. */
	policyCard: "policy:card:",
} as const;

/**
 * A model reference is `provider/model`, where the model itself may contain
 * slashes (models.dev has ids like `siliconflow/deepseek-v3-0324`), and may
 * carry a `#variant` suffix. The provider never contains a slash, which is what
 * makes the first one the separator.
 */
const MODEL_PATTERN = /^[A-Za-z0-9._-]+\/\S+$/;

/** Whether a value is a usable `provider/model` reference. */
export function isValidModel(value: string): boolean {
	return MODEL_PATTERN.test(value);
}

/** The public origin to build links with, normalised without a trailing slash. */
export function publicOrigin(env: Env): string {
	return env.PUBLIC_ORIGIN?.trim().replace(/\/$/, "") || DEFAULT_PUBLIC_ORIGIN;
}

/** A namespaced log line: `[eryn:bot:gateway] …`. */
export function log(scope: string, message: string): void {
	console.log(`[${LOG_PREFIX}:${scope}] ${message}`);
}
