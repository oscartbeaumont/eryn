/**
 * The method shape a provider pick needs before Discord's response deadline.
 *
 * The setup list already knows every provider's connection methods. Carrying a
 * one-letter hint in the button or select value lets a provider with a single
 * API-key method open its modal as the interaction's first response, without a
 * round trip to the guild host that can take seconds when the host is cold.
 * Everything else acknowledges first and then reads the fresh list.
 */

import type { IntegrationMethodOption } from "../session/models.ts";

/** What a pick needs to know. */
export type ProviderChoice = "key" | "oauth" | "many" | "none";

const CODES = new Map<string, ProviderChoice>([
	["k", "key"],
	["o", "oauth"],
	["m", "many"],
	["n", "none"],
]);
const CODE_FOR: Record<ProviderChoice, string> = { key: "k", oauth: "o", many: "m", none: "n" };

/** The shape of a provider's supported methods. */
export function providerChoice(methods: readonly IntegrationMethodOption[]): ProviderChoice {
	const supported = methods.filter((method) => method.supported);
	if (supported.length === 0) return "none";
	if (supported.length > 1) return "many";
	return supported[0]?.type === "key" ? "key" : "oauth";
}

/** The value for a picker control: `providerId|k`, `providerId|o`, and so on. */
export function encodeProviderChoice(providerId: string, methods: readonly IntegrationMethodOption[]): string {
	return `${providerId}|${CODE_FOR[providerChoice(methods)]}`;
}

/**
 * Split a picker value back into its provider and, when present, its hint.
 *
 * A value without a recognised hint is a screen rendered by an older build, so
 * the caller takes the slow but always-correct path.
 */
export function decodeProviderChoice(value: string): { providerId: string; choice?: ProviderChoice } {
	const separator = value.lastIndexOf("|");
	if (separator <= 0) return { providerId: value };
	const choice = CODES.get(value.slice(separator + 1));
	if (!choice) return { providerId: value };
	return { providerId: value.slice(0, separator), choice };
}
