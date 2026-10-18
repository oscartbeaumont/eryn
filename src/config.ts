/**
 * Small helpers shared by the Worker and the Durable Objects: environment
 * parsing plus the values that define what an inference request looks like.
 */

/** The default model when a guild does not choose one. */
export const DEFAULT_MODEL = "opencode-go/deepseek-v4.1-flash";

export { CLIENT_ID } from "./discord-ids";

/** Models must stay on the OpenCode Go provider, which is what the key is for. */
const MODEL_PATTERN = /^opencode-go\/[A-Za-z0-9._-]+$/;

/** Whether a value is a usable `opencode-go/<model>` reference. */
export function isValidModel(value: string): boolean {
	return MODEL_PATTERN.test(value);
}

/** Read an integer from a text binding, clamped to a sane range. */
export function intFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
	const value = Number.parseInt(raw ?? "", 10);
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}
