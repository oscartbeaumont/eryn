/**
 * The workspace plugin: a durable, layered filesystem and a shell for the agent.
 *
 * The server tree is the shared root. A channel is a directory inside it, and
 * the agent starts there, so it can read server-wide files while its own edits
 * stay in the channel project. The shell is sandboxed to the channel root: it
 * cannot walk into another channel or into Eryn's configuration.
 */

import { Plugin } from "@opencode/plugin";
import type { Schema } from "effect";

import { declaredInput, objectSchema, toolRun } from "../tool.ts";
import type { ToolCall, ToolSpec } from "../tool.ts";
import { base64ToBytes, bytesToBase64, bytesToText, textToBytes } from "./bytes.ts";
import { resolvePath, resolveToolPath } from "./paths.ts";
import { runShell } from "./shell.ts";
import { fileStore } from "./store.ts";
import type { FileStore, StoredFile } from "./store.ts";

const OVERRIDDEN = ["read", "write", "edit", "patch", "bash", "list", "glob", "grep"];

export interface WorkspaceOptions {
	readonly storage: DurableObjectStorage;
	/** The server-wide root. */
	readonly serverRoot: string;
	/** The channel project root for one session. */
	readonly rootForSession: (sessionID: string) => string;
	readonly activeSkills?: ReadonlyMap<string, string>;
}

async function readText(store: FileStore, path: string): Promise<string | undefined> {
	const file = await store.get(path);

	return file ? bytesToText(base64ToBytes(file.b)) : undefined;
}

async function writeText(store: FileStore, path: string, text: string, mtime = Date.now()): Promise<void> {
	const file: StoredFile = { b: bytesToBase64(textToBytes(text)), m: mtime };
	await store.put(path, file);
}

type FileInput = { filePath: string };
type ReadInput = FileInput & { offset?: number; limit?: number };
type EditInput = FileInput & { oldString: string; newString: string; replaceAll?: boolean };

function toolPath(store: FileStore, options: WorkspaceOptions) {
	return (
		input: { filePath?: string; path?: string },
		call: ToolCall | undefined,
		kind: "file" | "dir" = "file",
	): Promise<string> =>
		resolveToolPath({
			store,
			root: options.rootForSession(call?.sessionID ?? ""),
			skillDirectory: call && options.activeSkills ? options.activeSkills.get(call.sessionID) : undefined,
			input: input.filePath ?? input.path ?? ".",
			kind,
		});
}

export function workspacePlugin(options: WorkspaceOptions) {
	const store = fileStore(options.storage);
	const resolve = toolPath(store, options);

	const tools: ToolSpec[] = [
		{
			name: "read",
			description: "Read a file. A relative path resolves from the channel project.",
			input: objectSchema(
				{
					filePath: { type: "string", description: "Absolute path, or relative to the channel" },
					offset: { type: "number", description: "First line to read (1-based)" },
					limit: { type: "number", description: "Maximum number of lines" },
				},
				["filePath"],
			),
			async run(rawInput, call) {
				const { filePath, offset, limit } = declaredInput<ReadInput>(rawInput);
				const path = await resolve({ filePath }, call, "file");
				const content = await readText(store, path);

				if (content === undefined) return "Error: " + path + " does not exist";
				const lines = content.split("\n");
				const start = Math.max(0, (offset ?? 1) - 1);
				const end = limit === undefined ? lines.length : start + Math.max(0, limit);

				return lines
					.slice(start, end)
					.map((line, index) => start + index + 1 + ": " + line)
					.join("\n");
			},
		},
		{
			name: "write",
			description: "Create or overwrite a file. A relative path resolves from the channel project.",
			input: objectSchema(
				{
					filePath: { type: "string", description: "Absolute path, or relative to the channel" },
					content: { type: "string", description: "Full file contents" },
				},
				["filePath", "content"],
			),
			async run(rawInput, call) {
				const { filePath, content } = declaredInput<FileInput & { content: string }>(rawInput);
				const path = await resolve({ filePath }, call, "file");

				await writeText(store, path, content);

				return "Wrote " + path + " (" + textToBytes(content).byteLength + " bytes)";
			},
		},
		{
			name: "edit",
			description: "Replace text in an existing file. Fails if oldString is absent or ambiguous.",
			input: objectSchema(
				{
					filePath: { type: "string" },
					oldString: { type: "string" },
					newString: { type: "string" },
					replaceAll: { type: "boolean", description: "Replace every occurrence" },
				},
				["filePath", "oldString", "newString"],
			),
			async run(rawInput, call) {
				const { filePath, oldString, newString, replaceAll } = declaredInput<EditInput>(rawInput);
				const path = await resolve({ filePath }, call, "file");
				const content = await readText(store, path);

				if (content === undefined) return "Error: " + path + " does not exist";
				const count = content.split(oldString).length - 1;

				if (count === 0) return "Error: oldString not found in " + path;

				if (count > 1 && !replaceAll) {
					return "Error: oldString appears " + count + " times in " + path + "; pass replaceAll";
				}

				const next = replaceAll ? content.replaceAll(oldString, newString) : content.replace(oldString, newString);

				await writeText(store, path, next);

				return "Edited " + path;
			},
		},
		{
			name: "list",
			description: "List files under a directory.",
			input: objectSchema({
				path: { type: "string", description: "Directory to list (defaults to the channel root)" },
			}),
			async run(rawInput, call) {
				const { path: directory } = declaredInput<{ path?: string }>(rawInput);
				const prefix = await resolve({ path: directory }, call, "dir");
				const files = (await store.list(prefix)).map((entry) => entry.path);

				return files.length ? files.sort().join("\n") : "(empty: " + prefix + ")";
			},
		},
		{
			name: "bash",
			description:
				"Run a shell command in the channel project (a sandboxed bash: ls, cat, grep, sed, find, mkdir, mv, rm, …).",
			input: objectSchema(
				{
					command: { type: "string", description: "The command line to run" },
					cwd: { type: "string", description: "Working directory (defaults to the channel root)" },
				},
				["command"],
			),
			async run(rawInput, call) {
				const { command, cwd } = declaredInput<{ command: string; cwd?: string }>(rawInput);
				const root = options.rootForSession(call.sessionID);
				const workingDirectory = resolvePath(root, cwd ?? ".");
				const result = await runShell(store, command, workingDirectory, root);
				const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trimEnd();
				const suffix = result.exitCode === 0 ? "" : "\n[exit " + result.exitCode + "]";

				return (output || "(no output)") + suffix;
			},
		},
	];

	return Plugin.define({
		id: "eryn.workspace",
		async setup(ctx) {
			await ctx.tool.transform((editor) => {
				OVERRIDDEN.forEach((name) => editor.remove(name));

				tools.forEach((spec) => {
					editor.add({
						name: spec.name,
						description: spec.description,
						input: spec.input,
						execute: (input, context) => toolRun(spec, ctx)(input as Schema.JsonObject, context),
					});
				});
			});
		},
	});
}

export { fileStore };
