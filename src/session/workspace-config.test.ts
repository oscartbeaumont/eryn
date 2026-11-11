/**
 * The guild's OpenCode files are the source of truth for a host. These tests
 * cover the translation: config filtering, Markdown commands, skills,
 * instructions, and the signature that triggers a rebuild.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { KEYS } from "../config.ts";
import { expandShellBlocks } from "../plugins/commands/index.ts";
import { workspaceSkillsPlugin } from "../plugins/skills/index.ts";
import { bytesToBase64, textToBytes } from "../plugins/workspace/bytes.ts";
import { resolveToolPath } from "../plugins/workspace/paths.ts";
import { fileStore } from "../plugins/workspace/store.ts";
import { protectShellBlocks } from "./command-template.ts";
import {
	DEFAULT_AGENTS_PATH,
	DEFAULT_CONFIG_PATH,
	DEFAULT_EXPLAIN_COMMAND_PATH,
} from "./defaults.ts";
import { resetWorkspace, seedWorkspace } from "./seed.ts";
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

	async delete(key: string | string[]): Promise<boolean> {
		if (Array.isArray(key)) {
			let deleted = false;
			for (const entry of key) deleted = this.values.delete(entry) || deleted;
			return deleted;
		}
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
	assert.match(workspace.instructions ?? "", /## Progress updates/);
	assert.match(workspace.instructions ?? "", /short tasks get no progress messages/);
	assert.match(workspace.instructions ?? "", /## Attribution/);
	assert.match(workspace.instructions ?? "", /Generated on/);
});

test("an existing guild gains the attribution footer once", async () => {
	const storage = new MemoryStorage();
	await write(storage, DEFAULT_AGENTS_PATH, "# Eryn\n\nCustom note.\n");
	await storage.put(KEYS.workspaceSeed, 2);

	await seedWorkspace(storage as unknown as DurableObjectStorage);
	const workspace = await readWorkspaceConfig(storage as unknown as DurableObjectStorage);
	assert.match(workspace.instructions ?? "", /## Attribution/);
	assert.match(workspace.instructions ?? "", /Custom note/);

	// A member who removes the section keeps it removed on later deploys.
	await write(storage, DEFAULT_AGENTS_PATH, "# Eryn\n\nCustom note.\n");
	await seedWorkspace(storage as unknown as DurableObjectStorage);
	const later = await readWorkspaceConfig(storage as unknown as DurableObjectStorage);
	assert.doesNotMatch(later.instructions ?? "", /## Attribution/);
});

test("resetting removes every file and restores the seeded defaults", async () => {
	const storage = new MemoryStorage();
	await seedWorkspace(storage as unknown as DurableObjectStorage);
	await write(storage, "/workspace/project.md", "my work");
	await write(storage, DEFAULT_AGENTS_PATH, "# Custom instructions\n");

	const files = await resetWorkspace(storage as unknown as DurableObjectStorage);
	assert.ok(files >= 6);
	const workspace = await readWorkspaceConfig(storage as unknown as DurableObjectStorage);
	assert.match(workspace.instructions ?? "", /You are Eryn/);
	assert.match(workspace.instructions ?? "", /## Attribution/);
	assert.doesNotMatch(workspace.instructions ?? "", /Custom instructions/);
	assert.equal(
		await fileStore(storage as unknown as DurableObjectStorage).get("/workspace/project.md"),
		undefined,
	);
});

test("an existing guild gets the progress rules without losing its edits", async () => {
	const storage = new MemoryStorage();
	await write(
		storage,
		DEFAULT_AGENTS_PATH,
		"# Eryn\n\nKeep replies focused. Use tools when they help, and do not narrate every tool\ncall.\n\nCustom note.\n",
	);
	await storage.put(KEYS.workspaceSeed, 1);

	await seedWorkspace(storage as unknown as DurableObjectStorage);
	const workspace = await readWorkspaceConfig(storage as unknown as DurableObjectStorage);

	assert.match(workspace.instructions ?? "", /## Progress updates/);
	assert.match(workspace.instructions ?? "", /short tasks get no progress messages/);
	assert.match(workspace.instructions ?? "", /Custom note/);
});

test("the progress upgrade leaves a custom voice alone", async () => {
	const storage = new MemoryStorage();
	await write(storage, DEFAULT_AGENTS_PATH, "# Eryn\n\nBe verbose and use emoji.\n");
	await storage.put(KEYS.workspaceSeed, 1);

	await seedWorkspace(storage as unknown as DurableObjectStorage);
	const workspace = await readWorkspaceConfig(storage as unknown as DurableObjectStorage);

	assert.doesNotMatch(workspace.instructions ?? "", /## Progress updates/);
	assert.match(workspace.instructions ?? "", /Be verbose/);
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

test("Markdown agents under .opencode/agents become config agents", async () => {
	const storage = new MemoryStorage();
	await write(
		storage,
		"/eryn/.opencode/agents/reviewer.md",
		`---
description: Review a change
mode: subagent
model: anthropic/claude-sonnet-5-5
variant: high
name: Reviewer
---

Review carefully.
`,
	);
	await write(
		storage,
		"/eryn/.opencode/agent/planner.md",
		`---
description: Plan a change
---

Plan carefully.
`,
	);

	const workspace = await readWorkspaceConfig(storage as unknown as DurableObjectStorage);
	const agents = workspace.config.agents as Record<string, Record<string, unknown>>;
	assert.equal(agents.reviewer.description, "Review a change");
	assert.equal(agents.reviewer.mode, "subagent");
	assert.equal(agents.reviewer.model, "anthropic/claude-sonnet-5-5#high");
	assert.equal(agents.reviewer.system, "Review carefully.");
	assert.equal(agents.reviewer.name, undefined);
	assert.equal(agents.planner.description, "Plan a change");
	assert.equal(agents.planner.mode, undefined);
	assert.equal(agents.planner.system, "Plan carefully.");
});

test("command shell blocks are protected from OpenCode's process evaluator", async () => {
	const storage = new MemoryStorage();
	await write(
		storage,
		"/eryn/.opencode/commands/status.md",
		"---\ndescription: Show status\n---\n\nStatus: !`cat notes.txt`\n",
	);
	await write(
		storage,
		CONFIG_PATH,
		JSON.stringify({ commands: { inline: { template: "Inline: !`echo hi`" } } }),
	);

	const workspace = await readWorkspaceConfig(storage as unknown as DurableObjectStorage);
	const commands = workspace.config.commands as Record<string, { template: string }>;
	assert.match(commands.status.template, /!\u200b`cat notes\.txt`/);
	assert.doesNotMatch(commands.status.template, /!`cat notes\.txt`/);
	assert.match(commands.inline.template, /!\u200b`echo hi`/);
});

test("command shell blocks run in just-bash with arguments", async () => {
	const storage = new MemoryStorage();
	await write(storage, "/workspace/notes.txt", "hello from the workspace");
	const store = fileStore(storage as unknown as DurableObjectStorage);

	const protectedBlock = protectShellBlocks("Notes: !`cat notes.txt`");
	assert.match(protectedBlock, /!\u200b`cat notes\.txt`/);
	assert.equal(await expandShellBlocks(store, protectedBlock), "Notes: hello from the workspace");

	const withArguments = protectShellBlocks("Echo: !`echo $ARGUMENTS`").replaceAll("$ARGUMENTS", "hello");
	assert.equal(await expandShellBlocks(store, withArguments), "Echo: hello");
});

test("a skill's relative paths resolve before the workspace", async () => {
	const storage = new MemoryStorage();
	await write(storage, "/eryn/.opencode/skills/release/references/policy.md", "skill policy");
	await write(storage, "/workspace/references/policy.md", "workspace policy");
	const store = fileStore(storage as unknown as DurableObjectStorage);

	assert.equal(
		await resolveToolPath(store, "/workspace", "/eryn/.opencode/skills/release", "references/policy.md", "file"),
		"/eryn/.opencode/skills/release/references/policy.md",
	);
	assert.equal(
		await resolveToolPath(store, "/workspace", "/eryn/.opencode/skills/release", "missing.md", "file"),
		"/workspace/missing.md",
	);
	assert.equal(
		await resolveToolPath(store, "/workspace", "/eryn/.opencode/skills/release", "references/policy.md", "dir"),
		"/workspace/references/policy.md",
	);
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
		"Prepare the release.\n\nSupporting files, if any, live under `/eryn/.opencode/skills/release`. The `read` tool resolves relative paths in this skill against that directory.",
	);
});

test("an activated skill records its directory for relative reads", async () => {
	const active = new Map<string, string>();
	const plugin = workspaceSkillsPlugin(
		[
			{
				id: "release",
				name: "Release",
				path: "/eryn/.opencode/skills/release/SKILL.md",
				content: "Prepare the release.",
			},
		],
		active,
	);
	assert.ok(plugin);

	const context = {
		skill: {
			transform: async (callback: (editor: { add: (skill: never) => void }) => void) => {
				callback({ add: () => undefined });
			},
		},
		event: {
			subscribe: async function* () {
				yield { data: { sessionID: "ses_1", id: "release" } };
			},
		},
	};
	await plugin!.setup(context as never);
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(active.get("ses_1"), "/eryn/.opencode/skills/release");
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

	// A skill's supporting file changes what the agent can read, not the host.
	await write(storage, "/eryn/.opencode/skills/release/references/policy.md", "Policy");
	assert.equal(await workspaceSignature(storage as unknown as DurableObjectStorage), after);
	await write(storage, "/eryn/.opencode/skills/release/SKILL.md", "Release");
	assert.notEqual(await workspaceSignature(storage as unknown as DurableObjectStorage), after);

	// A Markdown agent changes the host too.
	const withAgent = await workspaceSignature(storage as unknown as DurableObjectStorage);
	await write(storage, "/eryn/.opencode/agents/reviewer.md", "---\ndescription: Review\n---\nReview.");
	assert.notEqual(await workspaceSignature(storage as unknown as DurableObjectStorage), withAgent);
});
