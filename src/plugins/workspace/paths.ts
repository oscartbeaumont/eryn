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

/** Whether `path` is `base` itself or sits beneath it. */
function within(path: string, base: string): boolean {
	const root = base.replace(/\/+$/, "");

	return path === root || path.startsWith(root + "/");
}

export type PathAccess = "read" | "write";

export interface ConfinePathInput {
	/** The server-wide root every path must stay inside. */
	readonly serverRoot: string;
	/** The conversation's own root, as `rootForSession` returns it. */
	readonly root: string;
	/** An absolute path that has already been through `resolvePath`. */
	readonly path: string;
	readonly access: PathAccess;
}

/** Directories whose contents the server owns, not the agent. */
const CONFIG_DIRECTORIES = new Set([".eryn", ".opencode"]);

function touchesConfig(path: string, serverRoot: string): boolean {
	const segments = path.slice(serverRoot.length).split("/");

	return segments.some((segment) => CONFIG_DIRECTORIES.has(segment));
}

/**
 * Why a resolved path is refused, or `undefined` when a tool may use it.
 *
 * Reads may roam the shared server tree (instructions, skills and other shared
 * docs) but never another conversation's directory, and never the server's own
 * configuration. Writes stay inside the conversation's root and never touch
 * the server instructions or any `.eryn`/`.opencode` directory, which seed
 * prompts and host configuration and so are injection vectors.
 */
export function pathDenial({ serverRoot, root, path, access }: ConfinePathInput): string | undefined {
	if (!within(path, serverRoot)) return path + " is outside the workspace";

	const channels = serverRoot + "/channels";
	const own = within(root, channels) && root !== channels ? root : undefined;

	if (within(path, channels) && (own === undefined || !within(path, own))) {
		return path + " belongs to another conversation";
	}

	if (access === "write") {
		if (!within(path, root)) return path + " is outside this conversation's root";

		if (path === serverRoot + "/AGENTS.md") {
			return path + " holds server-wide instructions and cannot be changed here";
		}

		if (touchesConfig(path, serverRoot)) {
			return path + " is configuration and cannot be changed here";
		}

		return undefined;
	}

	if (within(path, serverRoot + "/.eryn")) {
		return path + " is server configuration and cannot be read here";
	}

	return undefined;
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
