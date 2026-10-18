/** Absolute-path resolution for the virtual workspace, independent of any host. */

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

/** The parent directory of an absolute path. */
export function dirname(path: string): string {
	const index = path.lastIndexOf("/");
	return index <= 0 ? "/" : path.slice(0, index);
}
