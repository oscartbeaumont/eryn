/**
 * Run command `!` shell blocks in the workspace's just-bash shell.
 *
 * OpenCode's command evaluator would run these through its process plane,
 * which is unavailable on Workerd. The command template reaches us with the
 * blocks protected (see `command-template.ts`); this plugin expands them
 * immediately before the prompt is recorded, so the model sees the output and
 * the command keeps its normal argument, agent, and model handling.
 */

import { Plugin } from "@opencode/plugin";

import { shellBlockPattern } from "../../session/command-template.ts";
import { WORKSPACE_ROOT } from "../../session/locations.ts";
import { runShell } from "../workspace/shell.ts";
import { fileStore, type FileStore } from "../workspace/store.ts";

/** Replace every protected block with its just-bash output. */
export async function expandShellBlocks(store: FileStore, text: string): Promise<string> {
	const pattern = shellBlockPattern();
	const matches = [...text.matchAll(pattern)];
	if (matches.length === 0) return text;

	const outputs: string[] = [];
	for (const match of matches) {
		const result = await runShell(store, match[1] ?? "", WORKSPACE_ROOT, WORKSPACE_ROOT);
		outputs.push([result.stdout, result.stderr].filter(Boolean).join("\n").trimEnd());
	}

	let index = 0;
	return text.replace(shellBlockPattern(), () => outputs[index++] ?? "");
}

export function commandShellPlugin(storage: DurableObjectStorage) {
	const store = fileStore(storage);

	return Plugin.define({
		id: "eryn.command-shell",
		async setup(ctx) {
			await ctx.session.hook("prompt", async (event) => {
				if (!event.prompt.text.includes("!\u200b`")) return;
				event.prompt.text = await expandShellBlocks(store, event.prompt.text);
			});
		},
	});
}
