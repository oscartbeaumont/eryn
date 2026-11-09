/**
 * Shared tool plumbing for the plugins that add tools.
 *
 * Both tool plugins describe their tools as a {@link ToolSpec} table. The only
 * difference is what a thrown refusal means: {@link toolRun} lets it fail the
 * call, {@link toolExecute} reports it to the model as a result.
 */

import type { Plugin } from "@opencode/plugin";

import { describeError } from "../errors";

/** The JSON-schema shape OpenCode's tool editor expects. */
export function objectSchema(properties: Record<string, unknown>, required: string[] = []) {
	return { type: "object", properties, required, additionalProperties: false };
}

export type ObjectSchema = ReturnType<typeof objectSchema>;

/** What a tool can know about the call it is part of. */
export interface ToolCall {
	readonly sessionID: string;
}

/** One tool, before it is registered with the editor. */
export interface ToolSpec {
	readonly name: string;
	readonly description: string;
	readonly input: ObjectSchema;
	/**
	 * Extra policy checks that must fail the call rather than become tool
	 * output. Both adapters run this outside their own error handling, so an
	 * `ask` or `deny` ends the step instead of being reported to the model.
	 */
	guard?(input: Record<string, unknown>, call: ToolCall): Promise<void>;
	/** A string is sent as-is; any other value is JSON-encoded. */
	run(input: Record<string, unknown>, call: ToolCall): Promise<unknown>;
}

function content(result: unknown) {
	return { content: typeof result === "string" ? result : JSON.stringify(result, null, 2) };
}

/**
 * Check the session's policy before a plugin tool runs.
 *
 * Built-in OpenCode tools call `permission.assert` themselves. Plugin tools do
 * not, so without this an `ask` rule would be ignored and the tool would run
 * straight through. A denial must escape the tool, not become tool output, or
 * the model would treat it as a result and carry on.
 */
async function assertAllowed(
	ctx: Plugin.Context | undefined,
	spec: ToolSpec,
	rawInput: unknown,
	call: ToolCall,
): Promise<void> {
	if (!ctx) return;
	await ctx.permission.assert({
		action: spec.name,
		resources: ["*"],
		save: ["*"],
		sessionID: call.sessionID,
		metadata: { input: rawInput ?? {} },
	});
}

/** Adapt a spec to the editor's `execute`, letting a thrown error fail the call. */
export function toolRun(spec: ToolSpec, ctx?: Plugin.Context) {
	return async (rawInput: unknown, call: ToolCall) => {
		const input = (rawInput ?? {}) as Record<string, unknown>;
		await assertAllowed(ctx, spec, rawInput, call);
		await spec.guard?.(input, call);
		return content(await spec.run(input, call));
	};
}

/** Adapt a spec to the editor's `execute`, reporting a thrown error to the model. */
export function toolExecute(spec: ToolSpec, ctx?: Plugin.Context) {
	return async (rawInput: unknown, call: ToolCall) => {
		const input = (rawInput ?? {}) as Record<string, unknown>;
		// Outside the try: a permission denial is not an error the model should
		// retry or report as a result. The guard runs here for the same reason.
		await assertAllowed(ctx, spec, rawInput, call);
		await spec.guard?.(input, call);
		try {
			return content(await spec.run(input, call));
		} catch (error) {
			return { content: `Error: ${describeError(error)}` };
		}
	};
}
