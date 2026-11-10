/**
 * Seed the guild's filesystem with the OpenCode defaults.
 *
 * Seeding is versioned and additive: an existing file is never replaced, so a
 * member's edit survives a deploy. A new seed version only writes files that
 * are still absent. The one exception is the original default voice paragraph:
 * it is upgraded in place to include progress reporting, and only when it is
 * still exactly the old default. A customised voice is left alone.
 */

import { KEYS, log } from "../config.ts";
import { base64ToBytes, bytesToBase64, bytesToText, textToBytes } from "../plugins/workspace/bytes.ts";
import { fileStore, type FileStore } from "../plugins/workspace/store.ts";
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
	DEFAULT_PROGRESS,
	SEED_VERSION,
} from "./defaults.ts";

const DEFAULTS: ReadonlyArray<{ path: string; content: string }> = [
	{ path: DEFAULT_CONFIG_PATH, content: DEFAULT_CONFIG },
	{ path: DEFAULT_AGENTS_PATH, content: DEFAULT_AGENTS },
	{ path: DEFAULT_DISCORD_SKILL_PATH, content: DEFAULT_DISCORD_SKILL },
	{ path: DEFAULT_CONFIG_SKILL_PATH, content: DEFAULT_CONFIG_SKILL },
	{ path: DEFAULT_EXPLAIN_COMMAND_PATH, content: DEFAULT_EXPLAIN_COMMAND },
];

/** The voice paragraph in the original seed, before progress reporting existed. */
const OLD_VOICE = /Keep replies focused\. Use tools when they help, and do not narrate every tool\s+call\./;

/**
 * Add the progress rules to a guild seeded before they existed.
 *
 * Only the exact old default sentence is replaced, so a member's other edits
 * survive. A file that no longer contains that sentence is left alone.
 */
async function upgradeDefaultVoice(store: FileStore): Promise<boolean> {
	const file = await store.get(DEFAULT_AGENTS_PATH);
	if (!file) return false;
	const current = bytesToText(base64ToBytes(file.b));
	if (current.includes("## Progress updates") || !OLD_VOICE.test(current)) return false;
	const next = current.replace(OLD_VOICE, `Keep replies focused. Use tools when they help.\n\n${DEFAULT_PROGRESS}`);
	await store.put(DEFAULT_AGENTS_PATH, {
		b: bytesToBase64(textToBytes(next)),
		m: Date.now(),
	});
	return true;
}

/** Write any missing defaults, and upgrade the default voice once. */
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
	const upgraded = typeof seeded === "number" && seeded < 2 ? await upgradeDefaultVoice(store) : false;
	await storage.put(KEYS.workspaceSeed, SEED_VERSION);
	if (written > 0 || upgraded) log("session", `seeded ${written} default files${upgraded ? " and upgraded the default voice" : ""}`);
}
