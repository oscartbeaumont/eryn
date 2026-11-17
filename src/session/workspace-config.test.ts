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
import { fileStore, type WorkspaceStorage } from "../plugins/workspace/store.ts";
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
	type WorkspaceConfig,
} from "./workspace-config.ts";

/** A skill as the plugin hands it to the editor, which is what these tests read. */
interface AddedSkill {
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly content: string;
}

/** The config fields these tests assert on; the rest of the host config is untested. */
interface ConfigUnderTest {
	readonly default_agent?: string;
	readonly websearch?: { readonly provider: string } | boolean;
	readonly permissions?: readonly {
		readonly action: string;
		readonly resource: string;
		readonly effect: string;
	}[];
	readonly experimental?: { readonly schedules?: boolean; readonly mcp_events?: boolean };
	readonly skills?: readonly string[];
	readonly instructions?: readonly string[];
	readonly commands?: Readonly<Record<string, CommandUnderTest>>;
	readonly agents?: Readonly<Record<string, AgentUnderTest>>;
	readonly plugins?: unknown;
	readonly providers?: unknown;
	readonly mcp?: unknown;
	readonly formatter?: unknown;
	readonly snapshots?: unknown;
}

/** One Markdown command, as OpenCode receives it. */
interface CommandUnderTest {
	readonly template: string;
	readonly description?: string;
	readonly agent?: string;
	readonly model?: string;
	readonly subagent?: boolean;
}

/** One agent entry in the host config. */
interface AgentUnderTest {
	readonly description?: string;
	readonly mode?: string;
	readonly model?: string;
	readonly system?: string;
	readonly name?: string;
	readonly disabled?: boolean;
	readonly title?: { readonly disabled?: boolean };
}

class MemoryStorage implements WorkspaceStorage {
	private readonly values = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined> {
		// SAFETY: every caller decodes the entry with the schema it stored it with.
		return this.values.get(key) as T | undefined;
	}

	async put<T>(key: string, value: T): Promise<void> {
		this.values.set(key, value);
	}

	async delete(key: string): Promise<boolean>;
	async delete(keys: string[]): Promise<number>;
	async delete(key: string | string[]): Promise<boolean | number> {
		if (Array.isArray(key)) {
			let deleted = 0;

			for (const entry of key) if (this.values.delete(entry)) deleted += 1;

			return deleted;
		}

		return this.values.delete(key);
	}

	async list<T>(options: { prefix?: string; limit?: number; startAfter?: string } = {}): Promise<Map<string, T>> {
		const result = new Map<string, T>();

		const keys = [...this.values.keys()]
			.filter((key) => options.prefix === undefined || key.startsWith(options.prefix))
			.sort();

		for (const key of keys) {
			if (options.startAfter !== undefined && key <= options.startAfter) continue;

			if (options.limit !== undefined && result.size >= options.limit) break;
			// SAFETY: every entry was written by `put` with the T its reader asks for.
			result.set(key, this.values.get(key) as T);
		}

		return result;
	}
}

/** The host config as these tests assert on it. */
function configOf(workspace: WorkspaceConfig): ConfigUnderTest {
	// SAFETY: `Configuration` is OpenCode's schema type for the same JSON document;
	// these tests read only the fields the seeded files produce.
	return workspace.config as ConfigUnderTest;
}

async function write(storage: WorkspaceStorage, path: string, content: string) {
	await fileStore(storage).put(path, {
		b: bytesToBase64(textToBytes(content)),
		m: Date.now(),
	});
}

test("a fresh guild reads the seeded config, command, skills, and instructions", async () => {
	const storage = new MemoryStorage();
	await seedWorkspace(storage);
	const workspace = await readWorkspaceConfig(storage);

	assert.equal(configOf(workspace).default_agent, "build");
	assert.deepEqual(configOf(workspace).websearch, { provider: "random" });
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

	await seedWorkspace(storage);
	const workspace = await readWorkspaceConfig(storage);
	assert.match(workspace.instructions ?? "", /## Attribution/);
	assert.match(workspace.instructions ?? "", /Custom note/);

	// A member who removes the section keeps it removed on later deploys.
	await write(storage, DEFAULT_AGENTS_PATH, "# Eryn\n\nCustom note.\n");
	await seedWorkspace(storage);
	const later = await readWorkspaceConfig(storage);
	assert.doesNotMatch(later.instructions ?? "", /## Attribution/);
});

test("resetting removes every file and restores the seeded defaults", async () => {
	const storage = new MemoryStorage();
	await seedWorkspace(storage);
	await write(storage, "/workspace/project.md", "my work");
	await write(storage, DEFAULT_AGENTS_PATH, "# Custom instructions\n");

	const files = await resetWorkspace(storage);
	assert.ok(files >= 6);
	const workspace = await readWorkspaceConfig(storage);
	assert.match(workspace.instructions ?? "", /You are Eryn/);
	assert.match(workspace.instructions ?? "", /## Attribution/);
	assert.doesNotMatch(workspace.instructions ?? "", /Custom instructions/);
	assert.equal(
		await fileStore(storage).get("/workspace/project.md"),
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

	await seedWorkspace(storage);
	const workspace = await readWorkspaceConfig(storage);

	assert.match(workspace.instructions ?? "", /## Progress updates/);
	assert.match(workspace.instructions ?? "", /short tasks get no progress messages/);
	assert.match(workspace.instructions ?? "", /Custom note/);
});

test("the progress upgrade leaves a custom voice alone", async () => {
	const storage = new MemoryStorage();
	await write(storage, DEFAULT_AGENTS_PATH, "# Eryn\n\nBe verbose and use emoji.\n");
	await storage.put(KEYS.workspaceSeed, 1);

	await seedWorkspace(storage);
	const workspace = await readWorkspaceConfig(storage);

	assert.doesNotMatch(workspace.instructions ?? "", /## Progress updates/);
	assert.match(workspace.instructions ?? "", /Be verbose/);
});

test("an existing guild gains the default web search provider once", async () => {
	const storage = new MemoryStorage();
	await write(
		storage,
		DEFAULT_CONFIG_PATH,
		`{\n  "$schema": "https://opencode.ai/config.json",\n  "default_agent": "build"\n}\n`,
	);
	await storage.put(KEYS.workspaceSeed, 3);

	await seedWorkspace(storage);
	const workspace = await readWorkspaceConfig(storage);
	assert.deepEqual(configOf(workspace).websearch, { provider: "random" });

	// An explicit choice, including disabling search, is left alone.
	await write(storage, DEFAULT_CONFIG_PATH, `{"websearch": false}\n`);
	await storage.put(KEYS.workspaceSeed, 3);
	await seedWorkspace(storage);
	const later = await readWorkspaceConfig(storage);
	assert.equal(configOf(later).websearch, false);
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

	const workspace = await readWorkspaceConfig(storage);
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

	const workspace = await readWorkspaceConfig(storage);
	const agents = configOf(workspace).agents ?? {};
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

	const workspace = await readWorkspaceConfig(storage);
	const commands = configOf(workspace).commands ?? {};
	assert.match(commands.status.template, /!\u200b`cat notes\.txt`/);
	assert.doesNotMatch(commands.status.template, /!`cat notes\.txt`/);
	assert.match(commands.inline.template, /!\u200b`echo hi`/);
});

test("command shell blocks run in just-bash with arguments", async () => {
	const storage = new MemoryStorage();
	await write(storage, "/workspace/notes.txt", "hello from the workspace");
	const store = fileStore(storage);

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
	const store = fileStore(storage);

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

	const added: AddedSkill[] = [];

	const context = {
		skill: {
			transform: async (callback: (editor: { add: (skill: AddedSkill) => void }) => void) => {
				callback({ add: (skill) => added.push(skill) });
			},
		},
	};

	// SAFETY: the double implements the `skill` and `event` members `setup` uses.
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

	// SAFETY: the double implements the `skill` and `event` members `setup` uses.
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

	const workspace = await readWorkspaceConfig(storage);
	const config = configOf(workspace);
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
	const empty = await readWorkspaceConfig(storage);
	const emptyConfig = configOf(empty);
	assert.deepEqual(emptyConfig.permissions, [{ action: "*", resource: "*", effect: "allow" }]);
	assert.equal(emptyConfig.experimental?.schedules, true);
	assert.equal(emptyConfig.experimental?.mcp_events, true);
	assert.equal(emptyConfig.default_agent, "build");
	assert.equal(emptyConfig.agents?.title !== undefined, true);

	await write(storage, CONFIG_PATH, "{ not json");
	const malformed = await readWorkspaceConfig(storage);
	const malformedConfig = configOf(malformed);
	assert.deepEqual(malformedConfig.permissions, [{ action: "*", resource: "*", effect: "allow" }]);
	assert.equal(malformedConfig.experimental?.schedules, true);
	assert.equal(malformedConfig.experimental?.mcp_events, true);

	await write(
		storage,
		CONFIG_PATH,
		JSON.stringify({
			default_agent: "plan",
			agents: { title: { model: "anthropic/claude-sonnet-5-5" } },
		}),
	);
	const valid = await readWorkspaceConfig(storage);
	const validConfig = configOf(valid);
	assert.equal(validConfig.default_agent, "plan");
	assert.deepEqual(validConfig.permissions, [{ action: "*", resource: "*", effect: "allow" }]);
	assert.equal(validConfig.experimental?.schedules, true);
	assert.equal(validConfig.experimental?.mcp_events, true);
	assert.equal(
		validConfig.agents?.title?.disabled,
		true,
	);
});

test("the workspace signature changes when a config file changes", async () => {
	const storage = new MemoryStorage();
	await seedWorkspace(storage);
	const before = await workspaceSignature(storage);

	await write(storage, DEFAULT_AGENTS_PATH, "Updated instructions.");
	assert.notEqual(await workspaceSignature(storage), before);

	const after = await workspaceSignature(storage);
	assert.ok(after.includes(DEFAULT_AGENTS_PATH));
	assert.ok((await fileStore(storage).get(DEFAULT_CONFIG_PATH)));
	assert.ok((await fileStore(storage).get(DEFAULT_EXPLAIN_COMMAND_PATH)));

	// A skill's supporting file changes what the agent can read, not the host.
	await write(storage, "/eryn/.opencode/skills/release/references/policy.md", "Policy");
	assert.equal(await workspaceSignature(storage), after);
	await write(storage, "/eryn/.opencode/skills/release/SKILL.md", "Release");
	assert.notEqual(await workspaceSignature(storage), after);

	// A Markdown agent changes the host too.
	const withAgent = await workspaceSignature(storage);
	await write(storage, "/eryn/.opencode/agents/reviewer.md", "---\ndescription: Review\n---\nReview.");
	assert.notEqual(await workspaceSignature(storage), withAgent);
});
