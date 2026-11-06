/**
 * Shared tool plumbing for the plugins that add tools.
 *
 * Both tool plugins describe their tools as a {@link ToolSpec} table. The only
 * difference is what a thrown refusal means: {@link toolRun} lets it fail the
 * call, {@link toolExecute} reports it to the model as a result.
 */

import { describeError } from "../errors";

/** The JSON-schema shape OpenCode's tool editor expects. */
export function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
	return { type: "object", properties, required, additionalProperties: false };
}

export type ObjectSchema = ReturnType<typeof objectSchema>;

/** One tool, before it is registered with the editor. */
export interface ToolSpec {
	readonly name: string;
	readonly description: string;
	readonly input: ObjectSchema;
	/** A string is sent as-is; any other value is JSON-encoded. */
	run(input: Record<string, unknown>): Promise<unknown>;
}

/** Adapt a spec to the editor's `execute`, letting a thrown error fail the call. */
export function toolRun(spec: ToolSpec) {
	return async (rawInput: unknown) => {
		const result = await spec.run((rawInput ?? {}) as Record<string, unknown>);
		return { content: typeof result === "string" ? result : JSON.stringify(result, null, 2) };
	};
}

/** Adapt a spec to the editor's `execute`, reporting a thrown error to the model. */
export function toolExecute(spec: ToolSpec) {
	const run = toolRun(spec);
	return async (rawInput: unknown) => {
		try {
			return await run(rawInput);
		} catch (error) {
			return { content: `Error: ${describeError(error)}` };
		}
	};
}
