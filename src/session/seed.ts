/**
 * Seed the guild's filesystem with the OpenCode defaults.
 *
 * Seeding is versioned and additive: existing files are never overwritten, so a
 * member's edit survives a deploy. A new seed version only writes files that
 * are still absent.
 */

import { KEYS, log } from "../config.ts";
import { bytesToBase64, textToBytes } from "../plugins/workspace/bytes.ts";
import { fileStore } from "../plugins/workspace/store.ts";
import {
	DEFAULT_AGENTS,
	DEFAULT_AGENTS_PATH,
	DEFAULT_CONFIG,
	DEFAULT_CONFIG_PATH,
	DEFAULT_CONFIG_SKILL,
	DEFAULT_CONFIG_SKILL_PATH,
	DEFAULT_DISCORD_SKILL,
	DEFAULT_DISCORD_SKILL_PATH,
	DEFAULT_EXPLAIN_COMMAND,
	DEFAULT_EXPLAIN_COMMAND_PATH,
	SEED_VERSION,
} from "./defaults.ts";

const DEFAULTS: ReadonlyArray<{ path: string; content: string }> = [
	{ path: DEFAULT_CONFIG_PATH, content: DEFAULT_CONFIG },
	{ path: DEFAULT_AGENTS_PATH, content: DEFAULT_AGENTS },
	{ path: DEFAULT_DISCORD_SKILL_PATH, content: DEFAULT_DISCORD_SKILL },
	{ path: DEFAULT_CONFIG_SKILL_PATH, content: DEFAULT_CONFIG_SKILL },
	{ path: DEFAULT_EXPLAIN_COMMAND_PATH, content: DEFAULT_EXPLAIN_COMMAND },
];

/** Write any missing defaults. Safe to call on every host build. */
export async function seedWorkspace(storage: DurableObjectStorage): Promise<void> {
	const seeded = await storage.get<unknown>(KEYS.workspaceSeed);
	if (typeof seeded === "number" && seeded >= SEED_VERSION) return;

	const store = fileStore(storage);
	let written = 0;
	for (const item of DEFAULTS) {
		if (await store.get(item.path)) continue;
		await store.put(item.path, {
			b: bytesToBase64(textToBytes(item.content)),
			m: Date.now(),
		});
		written += 1;
	}
	await storage.put(KEYS.workspaceSeed, SEED_VERSION);
	if (written > 0) log("session", `seeded ${written} default files`);
}
