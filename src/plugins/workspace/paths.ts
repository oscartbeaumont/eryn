/** Absolute-path resolution for the virtual workspace, independent of any host. */

import type { FileStore } from "./store.ts";

/** Collapse `.`/`..` segments and return an absolute path. */
export function resolvePath(cwd: string, input: string): string {
	const base = input.startsWith("/") ? input : `${cwd}/${input}`;
	const parts: string[] = [];
	for (const segment of base.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") parts.pop();
		else parts.push(segment);
	}
	return `/${parts.join("/")}`;
}

/**
 * Resolve a tool path, preferring a skill's directory for relative paths.
 *
 * When a relative path exists under the active skill, it wins; otherwise the
 * path resolves against the workspace as usual. Absolute paths are untouched.
 */
export async function resolveToolPath(
	store: FileStore,
	root: string,
	skillDirectory: string | undefined,
	input: string,
	kind: "file" | "dir" = "file",
): Promise<string> {
	if (!input.startsWith("/") && skillDirectory) {
		const candidate = resolvePath(skillDirectory, input);
		const exists =
			kind === "file"
				? (await store.get(candidate)) !== undefined
				: (await store.get(candidate)) === undefined && (await store.list(candidate)).length > 0;
		if (exists) return candidate;
	}
	return resolvePath(root, input);
}
