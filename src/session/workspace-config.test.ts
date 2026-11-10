/**
 * The guild's OpenCode files are the source of truth for a host. These tests
 * cover the translation: config filtering, Markdown commands, skills,
 * instructions, and the signature that triggers a rebuild.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { workspaceSkillsPlugin } from "../plugins/skills/index.ts";
import { bytesToBase64, textToBytes } from "../plugins/workspace/bytes.ts";
import { fileStore } from "../plugins/workspace/store.ts";
import {
	DEFAULT_AGENTS_PATH,
	DEFAULT_CONFIG_PATH,
	DEFAULT_EXPLAIN_COMMAND_PATH,
} from "./defaults.ts";
import { seedWorkspace } from "./seed.ts";
import {
	CONFIG_PATH,
	readWorkspaceConfig,
	workspaceSignature,
} from "./workspace-config.ts";

class MemoryStorage {
	private readonly values = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined> {
		return this.values.get(key) as T | undefined;
	}

	async put(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}

	async delete(key: string): Promise<boolean> {
		return this.values.delete(key);
	}

	async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
		const result = new Map<string, T>();
		for (const [key, value] of this.values) {
			if (options.prefix && !key.startsWith(options.prefix)) continue;
			result.set(key, value as T);
		}
		return result;
	}
}

async function write(storage: MemoryStorage, path: string, content: string) {
	await fileStore(storage as unknown as DurableObjectStorage).put(path, {
		b: bytesToBase64(textToBytes(content)),
		m: Date.now(),
	});
}

test("a fresh guild reads the seeded config, command, skills, and instructions", async () => {
	const storage = new MemoryStorage();
	await seedWorkspace(storage as unknown as DurableObjectStorage);
	const workspace = await readWorkspaceConfig(storage as unknown as DurableObjectStorage);

	assert.equal((workspace.config as Record<string, unknown>).default_agent, "build");
	assert.ok(workspace.config.commands?.explain);
	assert.deepEqual(
		workspace.skills.map((skill) => skill.id).sort(),
		["config", "discord"],
	);
	assert.match(workspace.instructions ?? "", /You are Eryn/);
});

test("Markdown commands and skills become config entries", async () => {
	const storage = new MemoryStorage();
	await write(
		storage,
		"/eryn/.opencode/commands/team/review.md",
		`---
description: Review a change
agent: plan
model: anthropic/claude-sonnet-5-5#high
subagent: true
---

Review $ARGUMENTS.
`,
	);
	await write(
		storage,
		"/eryn/.opencode/skills/release/SKILL.md",
		`---
name: Release
description: Prepare a release
metadata:
  opencode/autoinvoke: false
---

Prepare the release.
`,
	);

	const workspace = await readWorkspaceConfig(storage as unknown as DurableObjectStorage);
	assert.deepEqual(workspace.config.commands?.["team/review"], {
		template: "Review $ARGUMENTS.",
		description: "Review a change",
		agent: "plan",
		model: "anthropic/claude-sonnet-5-5#high",
		subagent: true,
	});
	assert.deepEqual(workspace.skills, [
		{
			id: "release",
			name: "Release",
			description: "Prepare a release",
			autoinvoke: false,
			path: "/eryn/.opencode/skills/release/SKILL.md",
			content: "Prepare the release.",
		},
	]);
});

test("workspace skills register with their real guild paths", async () => {
	const plugin = workspaceSkillsPlugin([
		{
			id: "release",
			name: "Release",
			description: "Prepare a release",
			path: "/eryn/.opencode/skills/release/SKILL.md",
			content: "Prepare the release.",
		},
	]);
	assert.ok(plugin);

	const added: Array<Record<string, unknown>> = [];
	const context = {
		skill: {
			transform: async (callback: (editor: { add: (skill: never) => void }) => void) => {
				callback({ add: (skill) => added.push(skill as unknown as Record<string, unknown>) });
			},
		},
	};
	await plugin!.setup(context as never);

	assert.equal(added.length, 1);
	assert.equal(added[0]?.id, "release");
	assert.equal(added[0]?.name, "Release");
	assert.equal(added[0]?.path, "/eryn/.opencode/skills/release/SKILL.md");
	assert.equal(
		added[0]?.content,
		"Prepare the release.\n\nSupporting files, if any, live under `/eryn/.opencode/skills/release`. Read them by absolute path.",
	);
});

test("files OpenCode would resolve through node:fs are filtered out", async () => {
	const storage = new MemoryStorage();
	await write(
		storage,
		CONFIG_PATH,
		JSON.stringify({
			default_agent: "build",
			plugins: ["./.opencode/plugins/bad.ts"],
			providers: { x: {} },
			mcp: { servers: {} },
			formatter: true,
			snapshots: false,
			skills: ["./local", "https://example.com/skills/"],
			instructions: ["/eryn/AGENTS.md", "https://example.com/AGENTS.md"],
			commands: { inline: { template: "Hello" } },
		}),
	);

	const workspace = await readWorkspaceConfig(storage as unknown as DurableObjectStorage);
	const config = workspace.config as Record<string, unknown>;
	assert.equal(config.default_agent, "build");
	assert.equal(config.plugins, undefined);
	assert.equal(config.providers, undefined);
	assert.equal(config.mcp, undefined);
	assert.equal(config.formatter, undefined);
	assert.equal(config.snapshots, undefined);
	assert.deepEqual(config.skills, ["https://example.com/skills/"]);
	assert.deepEqual(config.instructions, ["https://example.com/AGENTS.md"]);
	assert.deepEqual(config.commands, { inline: { template: "Hello" } });
});

test("a missing or malformed config still gets Eryn's required base", async () => {
	const storage = new MemoryStorage();
	const empty = await readWorkspaceConfig(storage as unknown as DurableObjectStorage);
	const emptyConfig = empty.config as Record<string, unknown>;
	assert.deepEqual(emptyConfig.permissions, [{ action: "*", resource: "*", effect: "allow" }]);
	assert.equal((emptyConfig.experimental as Record<string, unknown>).schedules, true);
	assert.equal(emptyConfig.default_agent, "build");
	assert.equal((emptyConfig.agents as Record<string, unknown>).title instanceof Object, true);

	await write(storage, CONFIG_PATH, "{ not json");
	const malformed = await readWorkspaceConfig(storage as unknown as DurableObjectStorage);
	const malformedConfig = malformed.config as Record<string, unknown>;
	assert.deepEqual(malformedConfig.permissions, [{ action: "*", resource: "*", effect: "allow" }]);
	assert.equal((malformedConfig.experimental as Record<string, unknown>).schedules, true);

	await write(
		storage,
		CONFIG_PATH,
		JSON.stringify({
			default_agent: "plan",
			agents: { title: { model: "anthropic/claude-sonnet-5-5" } },
		}),
	);
	const valid = await readWorkspaceConfig(storage as unknown as DurableObjectStorage);
	const validConfig = valid.config as Record<string, unknown>;
	assert.equal(validConfig.default_agent, "plan");
	assert.deepEqual(validConfig.permissions, [{ action: "*", resource: "*", effect: "allow" }]);
	assert.equal((validConfig.experimental as Record<string, unknown>).schedules, true);
	assert.equal(
		((validConfig.agents as Record<string, unknown>).title as Record<string, unknown>).disabled,
		true,
	);
});

test("the workspace signature changes when a config file changes", async () => {
	const storage = new MemoryStorage();
	await seedWorkspace(storage as unknown as DurableObjectStorage);
	const before = await workspaceSignature(storage as unknown as DurableObjectStorage);

	await write(storage, DEFAULT_AGENTS_PATH, "Updated instructions.");
	assert.notEqual(await workspaceSignature(storage as unknown as DurableObjectStorage), before);

	const after = await workspaceSignature(storage as unknown as DurableObjectStorage);
	assert.ok(after.includes(DEFAULT_AGENTS_PATH));
	assert.ok((await fileStore(storage as unknown as DurableObjectStorage).get(DEFAULT_CONFIG_PATH)));
	assert.ok((await fileStore(storage as unknown as DurableObjectStorage).get(DEFAULT_EXPLAIN_COMMAND_PATH)));
});
