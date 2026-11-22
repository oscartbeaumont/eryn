/**
 * How an MCP server should ask its approval questions.
 *
 * A server that understands the parameter is told `native` (the chat surface),
 * `browser`, or `model`. An unknown server is left alone, because a strict
 * OAuth resource URI must not gain a surprise query parameter.
 */

export type ElicitationMode = "off" | "chat" | "browser" | "agent";

export const ELICITATION_PARAM = "elicitation_mode";

export function elicitationParam(mode: ElicitationMode | undefined): string | undefined {
	switch (mode) {
		case "chat":
			return "native";
		case "browser":
			return "browser";
		case "agent":
			return "model";
		default:
			return undefined;
	}
}

export function supportsElicitationParam(url: string): boolean {
	try {
		const parsed = new URL(url);

		if (parsed.searchParams.has(ELICITATION_PARAM)) return true;

		return parsed.hostname === "executor.sh" || parsed.hostname.endsWith(".executor.sh");
	} catch {
		return false;
	}
}

export function withElicitation(url: string, mode: ElicitationMode | undefined): string {
	try {
		const parsed = new URL(url);

		if (mode === "off") {
			parsed.searchParams.delete(ELICITATION_PARAM);

			return parsed.toString();
		}

		const value = elicitationParam(mode);

		if (!value) return url;
		parsed.searchParams.set(ELICITATION_PARAM, value);

		return parsed.toString();
	} catch {
		return url;
	}
}

export function applyElicitation(url: string, mode: ElicitationMode | undefined): string {
	return mode && supportsElicitationParam(url) ? withElicitation(url, mode) : url;
}
