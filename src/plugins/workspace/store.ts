/**
 * A tiny byte-oriented virtual filesystem persisted in Durable Object storage.
 *
 * Files are stored one key per path (`fs:<absolute path>`) as base64 so binary
 * content round-trips exactly. This is the shared substrate behind the file
 * tools and the just-bash shell — they read and write the same store, which
 * keeps the workspace consistent no matter which tool the model picks.
 */

import { KEYS } from "../../config";

export interface StoredFile {
	/** Base64-encoded file bytes. */
	readonly b: string;
	/** Modification time, milliseconds since the epoch. */
	readonly m: number;
}

export interface StoredEntry {
	readonly path: string;
	readonly file: StoredFile;
}

export interface FileStore {
	get(path: string): Promise<StoredFile | undefined>;
	put(path: string, file: StoredFile): Promise<void>;
	delete(path: string): Promise<void>;
	/** Every file at or below `prefix` (an absolute path). */
	list(prefix: string): Promise<StoredEntry[]>;
}

const KEY_PREFIX = KEYS.fs;

/** Build a filesystem over a Durable Object's storage. */
export function fileStore(storage: DurableObjectStorage): FileStore {
	const key = (path: string) => `${KEY_PREFIX}${path}`;
	return {
		async get(path) {
			return await storage.get<StoredFile>(key(path));
		},
		async put(path, file) {
			await storage.put(key(path), file);
		},
		async delete(path) {
			await storage.delete(key(path));
		},
		async list(prefix) {
			const entries = await storage.list<StoredFile>({ prefix: key(prefix) });
			return [...entries].map(([stored, file]) => ({ path: stored.slice(KEY_PREFIX.length), file }));
		},
	};
}
