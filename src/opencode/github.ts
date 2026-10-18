/**
 * The GitHub plugin: issue lookup, "clone", branch, commit, and pull request
 * tools backed by the shared workspace filesystem.
 *
 * It is decoupled from the workspace plugin by the {@link FileStore} it is
 * handed: `github_clone` writes real files into `/workspace`, the file and shell
 * tools edit them, and `github_commit` reads them back. The plugin only talks to
 * GitHub through the App client, so nothing here knows about Discord, OpenCode
 * internals, or credentials.
 */

import { Plugin } from "@opencode/plugin";
import type { GitHub } from "../github";
import { base64ToBytes, bytesToBase64 } from "./bytes";
import { resolvePath } from "./paths";
import type { FileStore } from "./store";
import { WORKSPACE_ROOT } from "./workspace";

const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});

const repoProperty = { type: "string", description: "Repository as owner/name (defaults to the configured repo)" };

export function githubPlugin(options: { github: GitHub; repo?: string; store: FileStore }) {
	const { github, store } = options;

	const output = (value: unknown) => ({ content: typeof value === "string" ? value : JSON.stringify(value, null, 2) });

	const resolveRepo = (input: { repo?: string }): string => {
		const repo = input.repo?.trim() || options.repo;
		if (!repo) throw new Error("No repository configured; set one in /setup or pass `repo`");
		return repo;
	};

	return Plugin.define({
		id: "eryn.github",
		async setup(ctx) {
			await ctx.tool.transform((editor) => {
				editor.namespace({ name: "github", description: "Read and change GitHub repositories" });

				editor.add({
					name: "issues",
					description: "List open issues in the repository (pull requests are excluded).",
					input: objectSchema(
						{
							repo: repoProperty,
							state: { type: "string", enum: ["open", "closed", "all"], description: "Default: open" },
							limit: { type: "number", description: "Maximum issues to return (default 20)" },
						},
						[],
					),
					options: { namespace: "github" },
					execute: async (rawInput) => {
						const input = rawInput as { repo?: string; state?: string; limit?: number };
						const issues = await github.listIssues(
							resolveRepo(input),
							input.state ?? "open",
							Math.min(input.limit ?? 20, 50),
						);
						return output(issues);
					},
				});

				editor.add({
					name: "issue",
					description: "Read one issue and its comments.",
					input: objectSchema(
						{ repo: repoProperty, number: { type: "number", description: "Issue number" } },
						["number"],
					),
					options: { namespace: "github" },
					execute: async (rawInput) => {
						const input = rawInput as { repo?: string; number: number };
						return output(await github.getIssue(resolveRepo(input), input.number));
					},
				});

				editor.add({
					name: "clone",
					description:
						"Copy a repository's files into the workspace (/workspace) so they can be read, edited, and run. Existing files are overwritten.",
					input: objectSchema(
						{ repo: repoProperty, ref: { type: "string", description: "Branch, tag, or commit (default branch if omitted)" } },
						[],
					),
					options: { namespace: "github" },
					execute: async (rawInput) => {
						const input = rawInput as { repo?: string; ref?: string };
						const repo = resolveRepo(input);
						const files = await github.tarball(repo, input.ref);
						for (const file of files) {
							const path = resolvePath(WORKSPACE_ROOT, file.path);
							await store.put(path, { b: bytesToBase64(file.data), m: Date.now() });
						}
						return output({ repo, files: files.length });
					},
				});

				editor.add({
					name: "branch",
					description: "Create a branch (no-op if it already exists).",
					input: objectSchema(
						{
							repo: repoProperty,
							branch: { type: "string", description: "New branch name" },
							from: { type: "string", description: "Base branch (default branch if omitted)" },
						},
						["branch"],
					),
					options: { namespace: "github" },
					execute: async (rawInput) => {
						const input = rawInput as { repo?: string; branch: string; from?: string };
						const repo = resolveRepo(input);
						const from = input.from ?? (await github.defaultBranch(repo));
						try {
							await github.createBranch(repo, input.branch, await github.branchHead(repo, from));
						} catch {
							// Already exists; treat as success.
						}
						return output({ repo, branch: input.branch, from });
					},
				});

				editor.add({
					name: "commit",
					description: "Commit workspace files to a branch. Requires the exact paths to include.",
					input: objectSchema(
						{
							repo: repoProperty,
							branch: { type: "string", description: "Branch to commit to (created if missing)" },
							message: { type: "string" },
							paths: {
								type: "array",
								items: { type: "string" },
								description: "Workspace-relative paths to commit",
							},
						},
						["branch", "message", "paths"],
					),
					options: { namespace: "github" },
					execute: async (rawInput) => {
						const input = rawInput as { repo?: string; branch: string; message: string; paths: string[] };
						const repo = resolveRepo(input);
						const files = [];
						for (const relative of input.paths) {
							const stored = await store.get(resolvePath(WORKSPACE_ROOT, relative));
							if (!stored) throw new Error(`Workspace file not found: ${relative}`);
							files.push({ path: relative.replace(/^\/+/, ""), data: base64ToBytes(stored.b) });
						}
						const sha = await github.commitFiles({
							repo,
							branch: input.branch,
							base: await github.defaultBranch(repo),
							message: input.message,
							files,
						});
						return output({ repo, branch: input.branch, commit: sha, files: input.paths });
					},
				});

				editor.add({
					name: "pull_request",
					description: "Open a pull request from a branch.",
					input: objectSchema(
						{
							repo: repoProperty,
							head: { type: "string", description: "Source branch" },
							base: { type: "string", description: "Target branch" },
							title: { type: "string" },
							body: { type: "string" },
							draft: { type: "boolean" },
						},
						["head", "title"],
					),
					options: { namespace: "github" },
					execute: async (rawInput) => {
						const input = rawInput as {
							repo?: string;
							head: string;
							base?: string;
							title: string;
							body?: string;
							draft?: boolean;
						};
						const repo = resolveRepo(input);
						const base = input.base ?? (await github.defaultBranch(repo));
						const pr = await github.createPullRequest({
							repo,
							head: input.head,
							base,
							title: input.title,
							body: input.body ?? "",
							draft: input.draft ?? false,
						});
						return output(pr);
					},
				});
			});
		},
	});
}
