/**
 * Deployment-wide constants and small helpers.
 *
 * Nothing here touches the network or storage: it is the handful of values
 * every object and every provider agrees on.
 */

import { DEFAULT_PUBLIC_ORIGIN } from "./public.ts";

/** The default model when a server does not choose one. */
export const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";

export { DEFAULT_PUBLIC_ORIGIN };

/** Prefix on every log line this package emits. */
export const LOG_PREFIX = "eryn";

/** Where Discord posts interactions. */
export const INTERACTIONS_PATH = "/interactions";

/**
 * A value a deployment can set that the hosted build does not bind.
 *
 * The hosted deployment declares only what it always sets; everything else is
 * read without a declared binding so a fork can supply it, or omit it, freely.
 */
export function optional(env: Env, name: string): string | undefined {
	const value = Object.entries(env).find(([key]) => key === name)?.[1];

	return isText(value) && value.trim() !== "" ? value.trim() : undefined;
}

/** Whether a binding holds text rather than a service binding. */
function isText<Binding>(value: Binding): value is Binding & string {
	return typeof value === "string";
}

/** The public origin this deployment sets, normalised without a trailing slash. */
export function configuredOrigin(env: Env): string | undefined {
	return optional(env, "PUBLIC_ORIGIN")?.replace(/\/$/, "");
}

/**
 * The key that signs browser sessions and internal MCP tokens.
 *
 * A deployment may set `SESSION_SECRET`. Without one the key is derived from
 * `ENCRYPTION_KEY`, which every deployment has anyway; the purpose suffix keeps
 * the two uses from sharing key material.
 */
export function sessionSecret(env: Env): string | undefined {
	const configured = optional(env, "SESSION_SECRET");

	if (configured) return configured;
	const encryption = optional(env, "ENCRYPTION_KEY");

	return encryption ? `${encryption}:session` : undefined;
}

/** The key that seals stored credentials. */
export function encryptionKey(env: Env): string | undefined {
	return optional(env, "ENCRYPTION_KEY");
}

/** Storage key prefixes. A shipped prefix is stable; new shapes get a new one. */
export const KEYS = {
	/** A server's own settings, no secrets. */
	server: "server:settings",
	/** One connected inference credential, sealed. */
	provider: "provider:",
	/** One linked MCP server, sealed (it carries a bearer or a refresh token). */
	link: "link:",
	/** A sign-in with an external MCP server, sealed. */
	mcpAuth: "mcp:auth:",
	/** An OpenCode session id for one channel project. */
	session: "session:",
	/** A channel's project configuration and activity bookkeeping. */
	channel: "channel:",
	/** One messaging provider connection, sealed. */
	messaging: "messaging:",
	/** Which channel an OpenCode session belongs to, so a tool can default. */
	channelSession: "hub:session:",
	/** One custom plugin, sealed (code plus metadata). */
	plugin: "plugin:",
	/** The server's Discord role policy, plain. */
	policy: "config:policy",
	/** The latest speaker and permissions for a conversation. */
	principal: "hub:principal:",
	/** The virtual filesystem, one key per absolute path. */
	fs: "fs:",
	/** The default files already written into the virtual filesystem. */
	workspaceSeed: "config:workspace-seed:",
	/** A sign-in that has started but not finished. */
	pendingOAuth: "config:oauth",
	/** One user account, keyed by a hash of the email. */
	user: "user:",
	/** The same account, keyed by its id, so a session resolves without a scan. */
	userId: "userid:",
	/** One browser session. */
	authSession: "auth:session:",
	/** One in-flight email login code. */
	loginCode: "auth:code:",
	/** One Eryn server in the control plane. */
	serverRef: "control:server:",
	/** A server owner's index entry. */
	ownerIndex: "control:owner:",
	/** A guild bound to an Eryn server in the gateway. */
	guildIndex: "gateway:guild:",
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

/** A namespaced log line: `[eryn:hub] …`. */
export function log(scope: string, message: string): void {
	// oxlint-disable-next-line eslint/no-console -- This function is the logger.
	console.log(`[${LOG_PREFIX}:${scope}] ${message}`);
}
