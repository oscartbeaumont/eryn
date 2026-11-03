/**
 * The workspace plugin: a real, durable filesystem and a shell for the agent.
 *
 * The Workerd OpenCode profile has no local filesystem or process plane, so the
 * built-in `read`/`write`/`edit`/`bash` tools are unavailable. This plugin
 * replaces them with implementations backed by the shared {@link FileStore} and
 * just-bash, giving the agent a genuine (if virtual) project to work in.
 *
 * It is deliberately standalone: it knows nothing about Discord, and only needs
 * a `FileStore`.
 */

import { Plugin } from "@opencode/plugin";
import { base64ToBytes, bytesToBase64, bytesToText, textToBytes } from "./bytes";
import { resolvePath } from "./paths";
import { runShell } from "./shell";
import type { FileStore, StoredFile } from "./store";

/** Where the agent's project lives. Mirrors OpenCode's own `/workspace` convention. */
export const WORKSPACE_ROOT = "/workspace";

/** Built-in tools this plugin supersedes (the rest are untouched). */
const OVERRIDDEN = ["read", "write", "edit", "patch", "bash", "list", "glob", "grep"];

const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});

function now(): number {
	return Date.now();
}

async function readText(store: FileStore, path: string): Promise<string | undefined> {
	const file = await store.get(path);
	return file ? bytesToText(base64ToBytes(file.b)) : undefined;
}

async function writeText(store: FileStore, path: string, text: string, mtime = now()): Promise<void> {
	const file: StoredFile = { b: bytesToBase64(textToBytes(text)), m: mtime };
	await store.put(path, file);
}

export function workspacePlugin(store: FileStore) {
	return Plugin.define({
		id: "eryn.workspace",
		async setup(ctx) {
			await ctx.tool.transform((editor) => {
				for (const name of OVERRIDDEN) editor.remove(name);

				editor.add({
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
					execute: async (rawInput) => {
						const input = rawInput as { filePath: string; offset?: number; limit?: number };
						const path = resolvePath(WORKSPACE_ROOT, input.filePath);
						const text = await readText(store, path);
						if (text === undefined) return { content: `Error: ${path} does not exist` };
						const lines = text.split("\n");
						const start = Math.max(0, (input.offset ?? 1) - 1);
						const end = input.limit ? start + input.limit : lines.length;
						return {
							content: lines
								.slice(start, end)
								.map((line, index) => `${start + index + 1}: ${line}`)
								.join("\n"),
						};
					},
				});

				editor.add({
					name: "write",
					description: "Create or overwrite a file in the workspace.",
					input: objectSchema(
						{
							filePath: { type: "string", description: "Absolute path, or relative to the workspace" },
							content: { type: "string", description: "Full file contents" },
						},
						["filePath", "content"],
					),
					execute: async (rawInput) => {
						const input = rawInput as { filePath: string; content: string };
						const path = resolvePath(WORKSPACE_ROOT, input.filePath);
						await writeText(store, path, input.content);
						return { content: `Wrote ${path} (${input.content.length} bytes)` };
					},
				});

				editor.add({
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
					execute: async (rawInput) => {
						const input = rawInput as {
							filePath: string;
							oldString: string;
							newString: string;
							replaceAll?: boolean;
						};
						const path = resolvePath(WORKSPACE_ROOT, input.filePath);
						const text = await readText(store, path);
						if (text === undefined) return { content: `Error: ${path} does not exist` };
						const count = text.split(input.oldString).length - 1;
						if (count === 0) return { content: `Error: oldString not found in ${path}` };
						if (count > 1 && !input.replaceAll) {
							return { content: `Error: oldString appears ${count} times in ${path}; pass replaceAll` };
						}
						const next = input.replaceAll
							? text.replaceAll(input.oldString, input.newString)
							: text.replace(input.oldString, input.newString);
						await writeText(store, path, next);
						return { content: `Edited ${path}` };
					},
				});

				editor.add({
					name: "list",
					description: "List files in the workspace.",
					input: objectSchema(
						{ path: { type: "string", description: "Directory to list (defaults to the workspace root)" } },
						[],
					),
					execute: async (rawInput) => {
						const input = rawInput as { path?: string };
						const prefix = resolvePath(WORKSPACE_ROOT, input.path ?? ".");
						const files = (await store.list(prefix)).map((entry) => entry.path);
						return { content: files.length ? files.sort().join("\n") : `(empty: ${prefix})` };
					},
				});

				editor.add({
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
					execute: async (rawInput) => {
						const input = rawInput as { command: string; cwd?: string };
						const cwd = resolvePath(WORKSPACE_ROOT, input.cwd ?? ".");
						const result = await runShell(store, input.command, cwd, WORKSPACE_ROOT);
						const body = [result.stdout, result.stderr].filter(Boolean).join("\n").trimEnd();
						const suffix = result.exitCode === 0 ? "" : `\n[exit ${result.exitCode}]`;
						return { content: `${body || "(no output)"}${suffix}` };
					},
				});
			});
		},
	});
}
