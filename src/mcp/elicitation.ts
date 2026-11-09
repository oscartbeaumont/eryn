/**
 * The bridge between Eryn's three approval surfaces and MCP's URL parameter.
 *
 * An MCP server that needs an approval can be told where to put the question.
 * Executor names the modes `native`, `browser`, and `model`; Eryn calls the same
 * choices `discord`, `browser`, and `agent`. This file is the only place the two
 * vocabularies meet.
 */

import type { ElicitationMode } from "../session/models";

/** The query parameter Executor and other MCP servers understand. */
export const ELICITATION_PARAM = "elicitation_mode";

/** Eryn's mode as the MCP server's own value. `off` has no server equivalent. */
export function elicitationParam(mode: ElicitationMode | undefined): string | undefined {
	switch (mode) {
		case "discord":
			return "native";
		case "browser":
			return "browser";
		case "agent":
			return "model";
		default:
			return undefined;
	}
}

/** Read a mode out of a URL parameter or a modal field. */
export function parseElicitation(value: string | null | undefined): ElicitationMode | undefined {
	switch (value?.trim().toLowerCase()) {
		case "discord":
		case "native":
			return "discord";
		case "browser":
			return "browser";
		case "agent":
		case "model":
			return "agent";
		case "off":
		case "none":
			return "off";
		default:
			return undefined;
	}
}

/**
 * Whether a URL is known to understand the parameter.
 *
 * Executor is the server that documents it. A URL that already carries the
 * parameter is obviously speaking the same language. Anything else is left
 * alone by default, so a server with a strict OAuth resource URI is not handed
 * a surprise query parameter.
 */
export function supportsElicitationParam(url: string): boolean {
	try {
		const parsed = new URL(url);
		if (parsed.searchParams.has(ELICITATION_PARAM)) return true;
		return parsed.hostname === "executor.sh" || parsed.hostname.endsWith(".executor.sh");
	} catch {
		return false;
	}
}

/** Apply the server-facing mode to a URL; `off` removes an existing one. */
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

/** The mode an existing URL asks for, when it names one. */
export function elicitationOf(url: string): ElicitationMode | undefined {
	try {
		return parseElicitation(new URL(url).searchParams.get(ELICITATION_PARAM));
	} catch {
		return undefined;
	}
}
