/**
 * Naming rules for files Eryn uploads to Discord.
 *
 * A message's attachment is identified to people by its filename, so it comes
 * from the file's own name rather than its full workspace path. Two files with
 * the same name in different directories would otherwise upload as two parts
 * called the same thing, which reads as a duplicate to Discord and to whoever
 * downloads them, so later ones get a numeric suffix.
 */

/** The last segment of a path, which becomes the attachment's filename. */
export function uploadName(path: string): string {
	const name = path.slice(path.lastIndexOf("/") + 1).trim();
	return name || "file";
}

/** The filename for each upload, with duplicates made unique. */
export function uploadNames(paths: readonly string[]): string[] {
	const used = new Set<string>();
	return paths.map((path) => {
		const base = uploadName(path);
		const dot = base.lastIndexOf(".");
		const stem = dot > 0 ? base.slice(0, dot) : base;
		const extension = dot > 0 ? base.slice(dot) : "";
		let name = base;
		for (let suffix = 2; used.has(name); suffix += 1) name = `${stem}-${suffix}${extension}`;
		used.add(name);
		return name;
	});
}
