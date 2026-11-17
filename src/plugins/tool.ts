/**
 * Shared tool plumbing for the plugins that add tools.
 *
 * Both tool plugins describe their tools as a {@link ToolSpec} table. The only
 * difference is what a thrown refusal means: {@link toolRun} lets it fail the
 * call, {@link toolExecute} reports it to the model as a result.
 */

import type { Plugin } from "@opencode/plugin";
import type { Schema } from "effect";

import { describeError } from "../errors.ts";
import { toJsonObject } from "../json.ts";

/** The JSON-schema shape OpenCode's tool editor expects. */
export function objectSchema(properties: Schema.JsonObject, required: string[] = []) {
	return { type: "object", properties, required, additionalProperties: false };
}

export type ObjectSchema = ReturnType<typeof objectSchema>;

/**
 * Read a tool call's input as the shape its `objectSchema` declares.
 *
 * The editor validates every call against that schema before it reaches
 * `execute`, so the object already carries these fields; this is the one place
 * that says so, rather than an assertion at each tool.
 */
export function declaredInput<T>(input: Schema.JsonObject): T {
	// SAFETY: the tool's `objectSchema` was validated by the editor before the call.
	return input as T;
}

/** What a tool can know about the call it is part of. */
export interface ToolCall {
	readonly sessionID: string;
}

/** A file a tool result carries to the model, alongside its text. */
export interface ToolFile {
	readonly uri: string;
	readonly mime: string;
	readonly name?: string;
}

/**
 * A tool result that is more than text.
 *
 * A URL in text is something the model can only ask about; a file is something
 * it can read. Screenshots read through `discord_read_messages` use this so the
 * pixels reach the model rather than an attachment link it cannot open.
 */
export class ToolOutput {
	readonly text: string;
	readonly files: readonly ToolFile[];

	constructor(text: string, files: readonly ToolFile[] = []) {
		this.text = text;
		this.files = files;
	}
}

/**
 * What a tool can return: text, a result that carries files, or any JSON value.
 *
 * The tool editor JSON-encodes everything except a string and a
 * {@link ToolOutput}, so this is the contract a spec's `run` has to meet.
 */
export type ToolResult =
	| string
	| number
	| boolean
	| null
	| ToolOutput
	| readonly ToolResult[]
	| { readonly [key: string]: ToolResult };

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
	guard?(input: Schema.JsonObject, call: ToolCall): Promise<void>;
	/**
	 * A string is sent as-is, a {@link ToolOutput} becomes text plus readable
	 * files, and any other value is JSON-encoded.
	 */
	run(input: Schema.JsonObject, call: ToolCall): Promise<ToolResult>;
}

/** Whether a tool result is plain text, which the editor sends as-is. */
function isText(result: ToolResult): result is string {
	return typeof result === "string";
}

function content(result: ToolResult) {
	if (result instanceof ToolOutput) {
		if (result.files.length === 0) return { content: result.text };

		return {
			content: [
				{ type: "text" as const, text: result.text },
				...result.files.map((file) => ({
					type: "file" as const,
					uri: file.uri,
					mime: file.mime,
					...(file.name ? { name: file.name } : {}),
				})),
			],
		};
	}

	return { content: isText(result) ? result : JSON.stringify(result, null, 2) };
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
	rawInput: Schema.Json | undefined,
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
	return async (rawInput: Schema.Json | undefined, call: ToolCall) => {
		const input = toJsonObject(rawInput) ?? {};
		await assertAllowed(ctx, spec, rawInput, call);
		await spec.guard?.(input, call);

		return content(await spec.run(input, call));
	};
}

/** Adapt a spec to the editor's `execute`, reporting a thrown error to the model. */
export function toolExecute(spec: ToolSpec, ctx?: Plugin.Context) {
	return async (rawInput: Schema.Json | undefined, call: ToolCall) => {
		const input = toJsonObject(rawInput) ?? {};
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
