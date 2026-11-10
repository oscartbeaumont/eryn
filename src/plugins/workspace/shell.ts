/**
 * The `bash` tool's engine: just-bash, a pure-TypeScript shell.
 *
 * just-bash runs many common Unix commands against a virtual filesystem with no
 * host access. Each call seeds an in-memory filesystem from the shared store,
 * runs the command, then writes the resulting tree back — so files created by
 * `bash` are immediately visible to the read/write tools and vice versa.
 *
 * Only the project root is seeded and harvested; just-bash's own `/bin` layout
 * and other scratch paths are ignored so they never leak into the store.
 */

import { Bash, InMemoryFs } from "just-bash/browser";
import { base64ToBytes, bytesToBase64 } from "./bytes.ts";
import type { FileStore, StoredFile } from "./store.ts";

export interface ShellResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export async function runShell(store: FileStore, command: string, cwd: string, root: string): Promise<ShellResult> {
	const entries = await store.list(root);
	const before = new Map(entries.map((entry) => [entry.path, entry.file]));
	const fs = new InMemoryFs(
		Object.fromEntries(entries.map((entry) => [entry.path, base64ToBytes(entry.file.b)])),
	);

	const bash = new Bash({ fs, cwd, env: { HOME: root, PWD: cwd, PATH: "/usr/bin:/bin" } });
	const result = await bash.exec(command);

	const after = new Map<string, StoredFile>();
	for (const path of fs.getAllPaths()) {
		if (!path.startsWith(`${root}/`)) continue;
		const stat = await fs.stat(path).catch(() => undefined);
		if (!stat?.isFile) continue;
		const bytes = await fs.readFileBuffer(path);
		after.set(path, { b: bytesToBase64(bytes), m: stat.mtime.getTime() });
	}

	for (const [path, file] of after) {
		const previous = before.get(path);
		if (!previous || previous.b !== file.b) await store.put(path, file);
	}
	for (const path of before.keys()) {
		if (!after.has(path)) await store.delete(path);
	}

	return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}
