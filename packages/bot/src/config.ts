/**
 * Bot-wide constants and small helpers.
 *
 * Nothing here touches the network or storage: it is the handful of values the
 * gateway object and every guild session agree on.
 */

/** The default model when a guild does not choose one. */
export const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";

/** Eryn's public Discord application id (equal to the bot user id). */
export const CLIENT_ID = "1561290858668494959";

/** Public origin used in links and OAuth flows when a binding is absent. */
export const DEFAULT_PUBLIC_ORIGIN = "https://eryn.otbeaumont.me";

/** Prefix on every log line this package emits. */
export const LOG_PREFIX = "eryn:bot";

/** Storage key prefixes, versioned as the contract requires. */
export const KEYS = {
	/** The guild's model and bookkeeping, no secrets. */
	guild: "config:guild",
	/** One connected provider credential, sealed. */
	provider: "provider:",
	/** One linked MCP server, sealed (it carries a bearer token). */
	link: "link:",
	/** A thread's OpenCode session id. */
	session: "session:",
	/** The guild's virtual filesystem, one key per absolute path. */
	fs: "fs:",
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

/** Read an integer from a text binding, clamped to a sane range. */
export function intFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
	const value = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

/** The public origin to build links with, normalised without a trailing slash. */
export function publicOrigin(env: Env): string {
	return env.PUBLIC_ORIGIN?.trim().replace(/\/$/, "") || DEFAULT_PUBLIC_ORIGIN;
}

/** A namespaced log line: `[eryn:bot:gateway] …`. */
export function log(scope: string, message: string): void {
	console.log(`[${LOG_PREFIX}:${scope}] ${message}`);
}
