/**
 * A tiny byte-oriented virtual filesystem persisted in Durable Object storage.
 *
 * Files are stored one key per path (`fs:<absolute path>`) as base64 so binary
 * content round-trips exactly. This is the shared substrate behind the file
 * tools and the just-bash shell — they read and write the same store, which
 * keeps the workspace consistent no matter which tool the model picks.
 */

import { KEYS } from "../../config.ts";

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

/**
 * The slice of Durable Object storage the guild workspace reads and writes.
 *
 * Narrower than `DurableObjectStorage` so the workspace can be exercised
 * against an in-memory double without pretending to implement alarms, SQL, or
 * transactions it never touches.
 */
export interface WorkspaceStorage {
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
	delete(key: string): Promise<boolean>;
	delete(keys: string[]): Promise<number>;
	list<T>(options?: {
		readonly prefix?: string;
		readonly limit?: number;
		readonly startAfter?: string;
	}): Promise<Map<string, T>>;
}

const KEY_PREFIX = KEYS.fs;

const key = (path: string) => `${KEY_PREFIX}${path}`;

/** Build a filesystem over a Durable Object's storage. */
export function fileStore(storage: WorkspaceStorage): FileStore {
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
			const root = prefix === "/" ? "/" : prefix.replace(/\/+$/, "");
			const entries = await storage.list<StoredFile>({ prefix: key(prefix) });

			return [...entries].flatMap(([stored, file]) => {
				const path = stored.slice(KEY_PREFIX.length);

				if (root !== "/" && path !== root && !path.startsWith(`${root}/`)) return [];

				if (root === "/" && !path.startsWith("/")) return [];

				return [{ path, file }];
			});
		},
	};
}
