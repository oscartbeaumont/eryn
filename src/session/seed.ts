/**
 * Seed the guild's filesystem with the OpenCode defaults.
 *
 * Seeding is versioned and additive: an existing file is never replaced, so a
 * member's edit survives a deploy. A new seed version only writes files that
 * are still absent. Two upgrades edit a file in place, each only once: the
 * original default voice gains progress reporting, and an `AGENTS.md` seeded
 * before attribution existed gains the footer section. A customised file is
 * otherwise left alone.
 */

import { applyEdits, modify, parse } from "jsonc-parser";

import { KEYS, log } from "../config.ts";
import { base64ToBytes, bytesToBase64, bytesToText, textToBytes } from "../plugins/workspace/bytes.ts";
import { fileStore, type FileStore } from "../plugins/workspace/store.ts";
import {
	DEFAULT_AGENTS,
	DEFAULT_AGENTS_PATH,
	DEFAULT_ATTRIBUTION,
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

/**
 * Add the attribution footer to a guild seeded before it existed.
 *
 * The section is appended only when it is absent, so a member who removed it
 * keeps it removed once the seed version advances past this upgrade.
 */
async function upgradeAttribution(store: FileStore): Promise<boolean> {
	const file = await store.get(DEFAULT_AGENTS_PATH);
	if (!file) return false;
	const current = bytesToText(base64ToBytes(file.b));
	if (current.includes("## Attribution")) return false;
	const next = `${current.trimEnd()}\n\n${DEFAULT_ATTRIBUTION}\n`;
	await store.put(DEFAULT_AGENTS_PATH, {
		b: bytesToBase64(textToBytes(next)),
		m: Date.now(),
	});
	return true;
}

/**
 * Add the default web search provider to a guild seeded before it existed.
 *
 * The choice lives per project, and every channel is its own project, so
 * without this the web search tool stops to ask the same provider question in
 * every new channel. An explicit `websearch` value is left alone, including
 * `false`; only an absent field gains the default.
 */
async function upgradeWebSearch(store: FileStore): Promise<boolean> {
	const file = await store.get(DEFAULT_CONFIG_PATH);
	if (!file) return false;
	const current = bytesToText(base64ToBytes(file.b));
	const parsed: unknown = parse(current, [], { allowTrailingComma: true });
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
	if ("websearch" in parsed) return false;
	const edits = modify(current, ["websearch"], { provider: "random" }, {
		formattingOptions: { insertSpaces: true, tabSize: 2 },
	});
	const next = applyEdits(current, edits);
	await store.put(DEFAULT_CONFIG_PATH, {
		b: bytesToBase64(textToBytes(next)),
		m: Date.now(),
	});
	return true;
}

/** Write any missing defaults, and apply the one-time seed upgrades. */
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
	const upgradedVoice = typeof seeded === "number" && seeded < 2 ? await upgradeDefaultVoice(store) : false;
	const upgradedAttribution = typeof seeded === "number" && seeded < 3 ? await upgradeAttribution(store) : false;
	const upgradedWebSearch = typeof seeded === "number" && seeded < 4 ? await upgradeWebSearch(store) : false;
	await storage.put(KEYS.workspaceSeed, SEED_VERSION);
	const upgrades = [
		...(upgradedVoice ? ["the default voice"] : []),
		...(upgradedAttribution ? ["the attribution footer"] : []),
		...(upgradedWebSearch ? ["the web search default"] : []),
	];
	if (written > 0 || upgrades.length > 0) {
		log(
			"session",
			`seeded ${written} default files${upgrades.length ? ` and upgraded ${upgrades.join(" and ")}` : ""}`,
		);
	}
}

/**
 * Delete every file in the guild's virtual filesystem and restore the defaults.
 *
 * Providers, the chosen model, MCP links, and OpenCode session history are not
 * files, so they survive. The seed marker is removed too, which makes the
 * following seed behave exactly like a fresh guild's first one.
 */
export async function resetWorkspace(storage: DurableObjectStorage): Promise<number> {
	let removed = 0;
	let startAfter: string | undefined;
	for (;;) {
		const entries = await storage.list<unknown>({
			prefix: KEYS.fs,
			limit: 1_000,
			...(startAfter ? { startAfter } : {}),
		});
		const keys = [...entries.keys()];
		if (keys.length === 0) break;
		for (let index = 0; index < keys.length; index += 128) {
			await storage.delete(keys.slice(index, index + 128));
		}
		removed += keys.length;
		if (keys.length < 1_000) break;
		startAfter = keys[keys.length - 1];
	}
	await storage.delete(KEYS.workspaceSeed);
	await seedWorkspace(storage);
	log("session", `reset the workspace and removed ${removed} files`);
	return removed;
}
