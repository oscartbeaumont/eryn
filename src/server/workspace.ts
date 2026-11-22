/**
 * Read a server and channel's OpenCode files into one host configuration.
 *
 * The server tree is the base. A channel overrides it, so an instruction or
 * skill can be shared with every channel and one channel can still diverge.
 * OpenCode's own discovery sits on a real filesystem, which a Worker does not
 * have, so these files are read from the durable store instead.
 */

import { ConfigMarkdown } from "@opencode/core/config/markdown";
import type { Configuration } from "@opencode/sdk/workerd";
import type { Schema } from "effect";
import { parse } from "jsonc-parser";

import { log } from "../config.ts";
import type { Mutable } from "../mutable.ts";
import { base64ToBytes, bytesToText } from "../plugins/workspace/bytes.ts";
import { fileStore } from "../plugins/workspace/store.ts";
import type { FileStore, WorkspaceStorage } from "../plugins/workspace/store.ts";
import {
	AGENTS_ROOT,
	COMMANDS_ROOT,
	SERVER_AGENTS_PATH,
	SERVER_CONFIG_PATH,
	SERVER_ROOT,
	SKILLS_ROOT,
	channelAgentsPath,
} from "../core/paths.ts";
import { protectShellBlocks } from "./command-template.ts";

const BASE_CONFIG = {
	default_agent: "build",
	permissions: [{ action: "*", resource: "*", effect: "allow" }],
	websearch: { provider: "random" },
	agents: { title: { disabled: true } },
	experimental: {
		schedules: true,
		mcp_events: true,
		full_codemode: true,
		all_flags: true,
	},
} as const;

export interface WorkspaceSkill {
	id: string;
	name: string;
	description?: string;
	autoinvoke?: boolean;
	path: string;
	content: string;
}

export interface WorkspaceConfig {
	config: Configuration;
	skills: WorkspaceSkill[];
	instructions?: string;
}

interface ConfigObject {
	[field: string]: Schema.Json | undefined;
}

interface CommandConfig {
	template: string;
	description?: string;
	agent?: string;
	model?: string;
	subagent?: boolean;
	subtask?: boolean;
}

function isJsonObject(value: Schema.Json | undefined): value is Schema.JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: Schema.Json | undefined): Schema.JsonObject | undefined {
	return isJsonObject(value) ? value : undefined;
}

function string(value: Schema.Json | undefined): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function text(store: FileStore, path: string): Promise<string | undefined> {
	const file = await store.get(path);

	return file ? bytesToText(base64ToBytes(file.b)) : undefined;
}

function parseConfig(source: string, body: string | undefined): ConfigObject {
	if (!body) return {};
	const parsed = parse(body, [], { allowTrailingComma: true }) as Schema.Json | undefined;
	const object = record(parsed);

	if (!object) {
		log("server", "ignored " + source + ": config must be an object");

		return {};
	}

	return object;
}

async function skillsAt(store: FileStore, root: string): Promise<WorkspaceSkill[]> {
	const entries = await store.list(root);
	const found = await Promise.all(
		entries.flatMap((entry) => {
			if (!entry.path.endsWith(".md")) return [];
			const relative = entry.path.slice(root.length + 1);
			const parts = relative.split("/");

			if (parts.some((part) => part.startsWith("."))) return [];
			const filename = parts.at(-1) ?? "";
			const id =
				filename === "SKILL.md"
					? parts.at(-2)
					: parts.length === 1
						? filename.replace(/\.md$/, "")
						: undefined;

			if (!id || id === "SKILL.md") return [];

			return [skillEntry(store, entry.path, id)];
		}),
	);

	return found.filter((skill): skill is WorkspaceSkill => skill !== undefined);
}

async function skillEntry(store: FileStore, path: string, id: string): Promise<WorkspaceSkill | undefined> {
	const source = await text(store, path);

	if (!source) return undefined;
	const markdown = ConfigMarkdown.parseOption(source);

	if (!markdown) return undefined;
	const data = record(markdown.data) ?? {};
	const metadata = record(data.metadata);
	const description = string(data.description);
	const autoinvoke =
		metadata?.["opencode/autoinvoke"] === true
			? true
			: metadata?.["opencode/autoinvoke"] === false
				? false
				: undefined;

	const skill: WorkspaceSkill = {
		id,
		name: string(data.name) ?? id,
		path,
		content: markdown.content.trim(),
	};

	if (description) skill.description = description;
	if (autoinvoke !== undefined) skill.autoinvoke = autoinvoke;

	return skill;
}

async function commandsAt(store: FileStore, root: string): Promise<Record<string, CommandConfig>> {
	const entries = await store.list(root);
	const pairs = await Promise.all(
		entries.flatMap((entry) => {
			if (!entry.path.endsWith(".md")) return [];
			const name = entry.path.slice(root.length + 1).replace(/\.md$/, "");

			if (name.split("/").some((part) => part.startsWith("."))) return [];

			return [commandEntry(store, entry.path, name)];
		}),
	);

	return Object.fromEntries(pairs.filter((pair): pair is [string, CommandConfig] => pair !== undefined));
}

async function commandEntry(
	store: FileStore,
	path: string,
	name: string,
): Promise<[string, CommandConfig] | undefined> {
	const source = await text(store, path);

	if (!source) return undefined;
	const markdown = ConfigMarkdown.parseOption(source);

	if (!markdown) return undefined;
	const template = protectShellBlocks(markdown.content.trim());

	if (!template) return undefined;
	const data = record(markdown.data) ?? {};
	const description = string(data.description);
	const agent = string(data.agent);
	const model = string(data.model);

	const command: CommandConfig = { template };

	if (description) command.description = description;
	if (agent) command.agent = agent;
	if (model) command.model = model;
	if (data.subagent === true) command.subagent = true;
	if (data.subtask === true) command.subtask = true;

	return [name, command];
}

/** Strip fields OpenCode would resolve through a filesystem Eryn does not have. */
function assembleConfig(
	user: ConfigObject,
	commands: Record<string, CommandConfig>,
): Configuration {
	const {
		plugins: _plugins,
		mcp: _mcp,
		provider: _provider,
		providers: _providers,
		formatter: _formatter,
		lsp: _lsp,
		snapshot: _snapshot,
		snapshots: _snapshots,
		worktree: _worktree,
		pty: _pty,
		references: _references,
		policies: _policies,
		skills: _skills,
		instructions: _instructions,
		commands: userCommands,
		permissions: userPermissions,
		agents: userAgents,
		experimental: userExperimental,
		...rest
	} = user;
	const extraPermissions = Array.isArray(userPermissions) ? (userPermissions as Schema.Json[]) : [];
	const inlineCommands = record(userCommands) ?? {};

	const config = {
		...BASE_CONFIG,
		...(rest as Configuration),
		permissions: [...BASE_CONFIG.permissions, ...extraPermissions] as never,
		agents: {
			...BASE_CONFIG.agents,
			...record(userAgents),
		} as never,
		experimental: {
			...BASE_CONFIG.experimental,
			...record(userExperimental),
			schedules: true,
			mcp_events: true,
			full_codemode: true,
			all_flags: true,
		} as never,
		autoupdate: false,
	} as Mutable<Configuration>;

	if (Object.keys(commands).length || Object.keys(inlineCommands).length) {
		config.commands = { ...inlineCommands, ...commands } as never;
	}

	return config;
}

/** Read every server-level file that shapes the host. */
export async function readWorkspaceConfig(storage: WorkspaceStorage): Promise<WorkspaceConfig> {
	const store = fileStore(storage);
	const user = parseConfig(SERVER_CONFIG_PATH, await text(store, SERVER_CONFIG_PATH));
	const commands = await commandsAt(store, COMMANDS_ROOT);
	const skillList = await skillsAt(store, SKILLS_ROOT);
	const instructions = await text(store, SERVER_AGENTS_PATH);

	const workspace: WorkspaceConfig = {
		config: assembleConfig(user, commands),
		skills: skillList,
	};

	if (instructions) workspace.instructions = instructions;

	return workspace;
}

/** The per-channel context an agent gets without rebuilding the host. */
export async function channelInstructions(
	storage: WorkspaceStorage,
	channelId: string,
): Promise<string | undefined> {
	return await text(fileStore(storage), channelAgentsPath(channelId));
}

/** A signature over the files that affect a host build. */
export async function workspaceSignature(storage: WorkspaceStorage): Promise<string> {
	const store = fileStore(storage);
	const entries = await store.list(SERVER_ROOT);

	return entries
		.filter((entry) => affectsHost(entry.path))
		.map((entry) => entry.path + ":" + entry.file.m + ":" + entry.file.b.length)
		.sort()
		.join("|");
}

function affectsHost(path: string): boolean {
	if (path === SERVER_CONFIG_PATH || path === SERVER_AGENTS_PATH) return true;

	return (
		(path.startsWith(SKILLS_ROOT + "/") ||
			path.startsWith(AGENTS_ROOT + "/") ||
			path.startsWith(COMMANDS_ROOT + "/")) &&
		path.endsWith(".md")
	);
}
