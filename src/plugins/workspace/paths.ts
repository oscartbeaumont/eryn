/** Absolute-path resolution for the virtual workspace, independent of any host. */

import type { FileStore } from "./store.ts";

/** Collapse `.`/`..` segments and return an absolute path. */
export function resolvePath(cwd: string, input: string): string {
	const base = input.startsWith("/") ? input : `${cwd}/${input}`;

	const parts = base.split("/").reduce<string[]>((kept, segment) => {
		if (segment === "" || segment === ".") return kept;

		if (segment === "..") kept.pop();
		else kept.push(segment);

		return kept;
	}, []);

	return `/${parts.join("/")}`;
}

/**
 * Resolve a tool path, preferring a skill's directory for relative paths.
 *
 * When a relative path exists under the active skill, it wins; otherwise the
 * path resolves against the workspace as usual. Absolute paths are untouched.
 */
export interface ResolveToolPathInput {
	readonly store: FileStore;
	readonly root: string;
	readonly skillDirectory?: string;
	readonly input: string;
	readonly kind?: "file" | "dir";
}

export async function resolveToolPath(request: ResolveToolPathInput): Promise<string> {
	const { store, root, skillDirectory, input, kind = "file" } = request;

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
