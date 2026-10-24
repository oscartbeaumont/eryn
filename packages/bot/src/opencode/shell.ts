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
import { base64ToBytes, bytesToBase64 } from "./bytes";
import { dirname } from "./paths";
import type { FileStore, StoredFile } from "./store";

export interface ShellResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
}

export async function runShell(store: FileStore, command: string, cwd: string, root: string): Promise<ShellResult> {
	const fs = new InMemoryFs();
	const before = new Map<string, StoredFile>();

	for (const entry of await store.list(root)) {
		before.set(entry.path, entry.file);
		await fs.mkdir(dirname(entry.path), { recursive: true });
		await fs.writeFile(entry.path, base64ToBytes(entry.file.b));
	}

	const bash = new Bash({ fs, cwd, env: { HOME: root, PWD: cwd, PATH: "/usr/bin:/bin" } });
	const result = await bash.exec(command);

	const after = new Map<string, StoredFile>();
	await walk(fs, root, async (path, mtime) => {
		const bytes = await fs.readFileBuffer(path);
		after.set(path, { b: bytesToBase64(bytes), m: mtime });
	});

	for (const [path, file] of after) {
		const previous = before.get(path);
		if (!previous || previous.b !== file.b) await store.put(path, file);
	}
	for (const path of before.keys()) {
		if (!after.has(path)) await store.delete(path);
	}

	return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
}

async function walk(fs: InMemoryFs, dir: string, visit: (path: string, mtime: number) => Promise<void>): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const child = dir === "/" ? `/${name}` : `${dir}/${name}`;
		let stat;
		try {
			stat = await fs.stat(child);
		} catch {
			continue;
		}
		if (stat.isDirectory) await walk(fs, child, visit);
		else if (stat.isFile) await visit(child, stat.mtime.getTime());
	}
}
