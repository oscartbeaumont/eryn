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
 * The hosted deployment declares only what it always sets; everything else is
 * read without a declared binding so a fork can supply it, or omit it, freely.
 */
function optional(env: Env, name: string): string | undefined {
	const value = (env as unknown as Record<string, unknown>)[name];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** The public origin this deployment sets, normalised without a trailing slash. */
export function configuredOrigin(env: Env): string | undefined {
	return optional(env, "PUBLIC_ORIGIN")?.replace(/\/$/, "");
}

/**
 * The key that signs MCP sign-in state and callback links.
 *
 * A deployment may set `SESSION_SECRET`. Without one the key is derived from
 * `ENCRYPTION_KEY`, which every deployment has anyway; the purpose suffix keeps
 * the two uses from sharing key material.
 */
export function sessionSecret(env: Env): string | undefined {
	const configured = optional(env, "SESSION_SECRET");
	if (configured) return configured;
	const encryption = optional(env, "ENCRYPTION_KEY");
	return encryption ? `${encryption}:mcp-state` : undefined;
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

/** A namespaced log line: `[eryn:bot:gateway] …`. */
export function log(scope: string, message: string): void {
	console.log(`[${LOG_PREFIX}:${scope}] ${message}`);
}
