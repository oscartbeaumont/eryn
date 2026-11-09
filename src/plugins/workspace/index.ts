/**
 * The workspace plugin: a real, durable filesystem and a shell for the agent.
 *
 * The Workerd OpenCode profile has no local filesystem or process plane, so the
 * built-in `read`/`write`/`edit`/`bash` tools are unavailable. This plugin
 * replaces them with implementations backed by the shared {@link FileStore} and
 * just-bash, giving the agent a genuine (if virtual) project to work in.
 *
 * It is deliberately standalone: it knows nothing about Discord, and needs
 * only the guild's Durable Object storage.
 */

import { Plugin } from "@opencode/plugin";

import { objectSchema, toolRun, type ToolSpec } from "../tool";
import { base64ToBytes, bytesToBase64, bytesToText, textToBytes } from "./bytes";
import { resolvePath } from "./paths";
import { runShell } from "./shell";
import { fileStore, type FileStore, type StoredFile } from "./store";

/** Where the agent's project lives. Mirrors OpenCode's own `/workspace` convention. */
export const WORKSPACE_ROOT = "/workspace";

/** Built-in tools this plugin supersedes (the rest are untouched). */
const OVERRIDDEN = ["read", "write", "edit", "patch", "bash", "list", "glob", "grep"];

async function readText(store: FileStore, path: string): Promise<string | undefined> {
	const file = await store.get(path);
	return file ? bytesToText(base64ToBytes(file.b)) : undefined;
}

async function writeText(store: FileStore, path: string, text: string, mtime = Date.now()): Promise<void> {
	const file: StoredFile = { b: bytesToBase64(textToBytes(text)), m: mtime };
	await store.put(path, file);
}

/** The arguments a tool takes, matching its schema. */
type FileInput = { filePath: string };
type ReadInput = FileInput & { offset?: number; limit?: number };
type EditInput = FileInput & { oldString: string; newString: string; replaceAll?: boolean };

export function workspacePlugin(storage: DurableObjectStorage) {
	const store = fileStore(storage);

	/** Resolve a tool's path argument (`filePath` for files, `path` for a listing). */
	const resolve = (input: { filePath?: string; path?: string }): string =>
		resolvePath(WORKSPACE_ROOT, input.filePath ?? input.path ?? ".");

	const tools: ToolSpec[] = [
		{
			name: "read",
			description: "Read a file from the workspace, with line numbers.",
			input: objectSchema(
				{
					filePath: { type: "string", description: "Absolute path, or relative to the workspace" },
					offset: { type: "number", description: "First line to read (1-based)" },
					limit: { type: "number", description: "Maximum number of lines" },
				},
				["filePath"],
			),
			async run(rawInput) {
				const { filePath, offset, limit } = rawInput as ReadInput;
				const path = resolve({ filePath });
				const text = await readText(store, path);
				if (text === undefined) return `Error: ${path} does not exist`;
				const lines = text.split("\n");
				const start = Math.max(0, (offset ?? 1) - 1);
				const end = limit ? start + limit : lines.length;
				return lines
					.slice(start, end)
					.map((line, index) => `${start + index + 1}: ${line}`)
					.join("\n");
			},
		},

		{
			name: "write",
			description: "Create or overwrite a file in the workspace.",
			input: objectSchema(
				{
					filePath: { type: "string", description: "Absolute path, or relative to the workspace" },
					content: { type: "string", description: "Full file contents" },
				},
				["filePath", "content"],
			),
			async run(rawInput) {
				const { filePath, content } = rawInput as FileInput & { content: string };
				const path = resolve({ filePath });
				await writeText(store, path, content);
				return `Wrote ${path} (${content.length} bytes)`;
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
			async run(rawInput) {
				const { filePath, oldString, newString, replaceAll } = rawInput as EditInput;
				const path = resolve({ filePath });
				const text = await readText(store, path);
				if (text === undefined) return `Error: ${path} does not exist`;
				const count = text.split(oldString).length - 1;
				if (count === 0) return `Error: oldString not found in ${path}`;
				if (count > 1 && !replaceAll) {
					return `Error: oldString appears ${count} times in ${path}; pass replaceAll`;
				}
				const next = replaceAll ? text.replaceAll(oldString, newString) : text.replace(oldString, newString);
				await writeText(store, path, next);
				return `Edited ${path}`;
			},
		},

		{
			name: "list",
			description: "List files in the workspace.",
			input: objectSchema({
				path: { type: "string", description: "Directory to list (defaults to the workspace root)" },
			}),
			async run(rawInput) {
				const { path: directory } = rawInput as { path?: string };
				const prefix = resolve({ path: directory });
				const files = (await store.list(prefix)).map((entry) => entry.path);
				return files.length ? files.sort().join("\n") : `(empty: ${prefix})`;
			},
		},

		{
			name: "bash",
			description:
				"Run a shell command in the workspace (a sandboxed bash: ls, cat, grep, sed, find, mkdir, mv, rm, …).",
			input: objectSchema(
				{
					command: { type: "string", description: "The command line to run" },
					cwd: { type: "string", description: "Working directory (defaults to the workspace root)" },
				},
				["command"],
			),
			async run(rawInput) {
				const { command, cwd } = rawInput as { command: string; cwd?: string };
				const workingDirectory = resolve({ path: cwd });
				const result = await runShell(store, command, workingDirectory, WORKSPACE_ROOT);
				const body = [result.stdout, result.stderr].filter(Boolean).join("\n").trimEnd();
				const suffix = result.exitCode === 0 ? "" : `\n[exit ${result.exitCode}]`;
				return `${body || "(no output)"}${suffix}`;
			},
		},
	];

	return Plugin.define({
		id: "eryn.workspace",
		async setup(ctx) {
			await ctx.tool.transform((editor) => {
				for (const name of OVERRIDDEN) editor.remove(name);
				for (const spec of tools) {
					editor.add({
						name: spec.name,
						description: spec.description,
						input: spec.input,
						execute: toolRun(spec, ctx),
					});
				}
			});
		},
	});
}
