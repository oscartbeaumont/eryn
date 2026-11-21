/**
 * Read the guild's OpenCode files into a host configuration.
 *
 * OpenCode's own discovery sits on `node:fs`, which in a Worker is an ephemeral
 * virtual filesystem separate from the guild store. Instead, Eryn reads the
 * durable files itself and turns them into the same config, commands, and
 * skills OpenCode would have discovered. The host is rebuilt when the files
 * change, so edits apply on the next turn.
 */

import { ConfigMarkdown } from "@opencode/core/config/markdown";
import type { Configuration } from "@opencode/sdk/workerd";
import type { Schema } from "effect";
import { parse } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';

import { log } from "../config.ts";
import type { Mutable } from '../mutable.ts';
import { base64ToBytes, bytesToText } from "../plugins/workspace/bytes.ts";
import { fileStore } from '../plugins/workspace/store.ts';
import type { FileStore, StoredEntry, WorkspaceStorage } from '../plugins/workspace/store.ts';

import {
	AGENTS_ROOT,
	COMMANDS_ROOT,
	CONFIG_PATH,
	CONFIG_ROOT,
	INSTRUCTIONS_PATH,
	LEGACY_AGENTS_ROOT,
	LEGACY_CONFIG_PATH,
	SKILLS_ROOT,
} from "./locations.ts";
import { protectShellBlocks } from "./command-template.ts";

export {
	AGENTS_ROOT,
	COMMANDS_ROOT,
	CONFIG_PATH,
	CONFIG_ROOT,
	INSTRUCTIONS_PATH,
	LEGACY_AGENTS_ROOT,
	LEGACY_CONFIG_PATH,
	SKILLS_ROOT,
};

/** The base every guild host starts from, independent of an editable file. */
const BASE_CONFIG = {
	default_agent: "build",
	permissions: [{ action: "*", resource: "*", effect: "allow" }],
	// Every channel is its own project, so without a stored provider choice the
	// web search tool asks once per channel. Random uses whichever search
	// integration is available and keeps the question out of the conversation.
	websearch: { provider: "random" },
	agents: { title: { disabled: true } },
	experimental: { schedules: true, mcp_events: true },
} as const;

export interface WorkspaceSkill {
	readonly id: string;
	readonly name: string;
	readonly description?: string;
	readonly autoinvoke?: boolean;
	/** The absolute guild-store path, so relative reads point at real files. */
	readonly path: string;
	readonly content: string;
}

export interface WorkspaceConfig {
	readonly config: Configuration;
	readonly skills: readonly WorkspaceSkill[];
	readonly instructions?: string;
}

function text(store: FileStore, path: string): Promise<string | undefined> {
	return store.get(path).then((file) => (file ? bytesToText(base64ToBytes(file.b)) : undefined));
}

/**
 * A JSON object whose optional members may be absent.
 *
 * This is the shape of a parsed config document: every leaf is decoded by the
 * field readers below before it reaches the host, and anything left over is
 * passed through for OpenCode to validate.
 */
interface ConfigObject {
	[field: string]: Schema.Json | undefined;
}

/** One Markdown command, in the form OpenCode's config accepts. */
interface CommandConfig {
	readonly template: string;
	readonly description?: string;
	readonly agent?: string;
	readonly model?: string;
	readonly subagent?: boolean;
	readonly subtask?: boolean;
}

/** A JSON object, when the value is one. */
function isJsonObject(value: Schema.Json | undefined): value is Schema.JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A JSON object, or `undefined` for every other JSON value. */
function record(value: Schema.Json | undefined): Schema.JsonObject | undefined {
	return isJsonObject(value) ? value : undefined;
}

/** A string value; anything else is not a string. */
function isString(value: Schema.Json | undefined): value is string {
	return typeof value === "string";
}

/** A non-empty, trimmed string value, or `undefined`. */
function string(value: Schema.Json | undefined): string | undefined {
	if (!isString(value)) return undefined;

	return value.trim() ? value.trim() : undefined;
}

function boolean(value: Schema.Json | undefined): boolean | undefined {
	return value === true || value === false ? value : undefined;
}

function parseConfig(source: string, body: string): ConfigObject {
	const errors: ParseError[] = [];
	const parsed = parse(body, errors, { allowTrailingComma: true }) as Schema.Json | undefined;

	if (errors.length) {
		log("session", `ignored ${source}: invalid JSONC`);

		return {};
	}

	const object = record(parsed);

	if (!object) {
		log("session", `ignored ${source}: config must be an object`);

		return {};
	}

	return object;
}

/** Only HTTP(S) entries survive: local paths would resolve against `node:fs`. */
function urls(value: Schema.Json | undefined): string[] | undefined {
	if (!Array.isArray(value)) return undefined;

	const found = value.filter((entry: Schema.Json): entry is string => {
		if (!isString(entry)) return false;

		try {
			const protocol = new URL(entry).protocol;

			return protocol === "http:" || protocol === "https:";
		} catch {
			return false;
		}
	});

	return found.length ? found : undefined;
}

function safe(value: Schema.Json | undefined, field: string, source: string): string | undefined {
	if (value === undefined) return undefined;
	const parsed = string(value);

	if (!parsed) log("session", `ignored ${field} in ${source}: expected a string`);

	return parsed;
}

async function commands(store: FileStore): Promise<Record<string, CommandConfig>> {
	const entries = await store.list(COMMANDS_ROOT);
	const pairs = await Promise.all(entries.map((entry) => commandEntry(store, entry)));

	return Object.fromEntries(pairs.filter((pair): pair is [string, CommandConfig] => pair !== undefined));
}

/** One command file, or undefined when it cannot be used. */
async function commandEntry(store: FileStore, entry: StoredEntry): Promise<[string, CommandConfig] | undefined> {
	if (!entry.path.endsWith(".md")) return undefined;

	const name = entry.path.slice(COMMANDS_ROOT.length + 1).replace(/\.md$/, "");

	if (name.split("/").some((part) => part.startsWith("."))) return undefined;

	const source = await text(store, entry.path);

	if (!source) return undefined;

	const markdown = ConfigMarkdown.parseOption(source);

	if (!markdown) {
		log("session", `ignored command ${name}: invalid Markdown`);

		return undefined;
	}

	const data = record(markdown.data) ?? {};
	const template = protectShellBlocks(markdown.content.trim());

	if (!template) {
		log("session", `ignored command ${name}: empty template`);

		return undefined;
	}

	const info: CommandConfig = { template, ...commandFields(data, name) };

	return [name, info];
}

/** The optional fields a command's frontmatter sets, in config form. */
function commandFields(data: ConfigObject, name: string): Omit<CommandConfig, "template"> {
	const model = string(data.model);
	const description = safe(data.description, "description", `command ${name}`);
	const agent = safe(data.agent, "agent", `command ${name}`);
	const subagent = boolean(data.subagent);
	const subtask = boolean(data.subtask);
	const fields: Mutable<Omit<CommandConfig, "template">> = {};

	if (description) fields.description = description;

	if (agent) fields.agent = agent;

	if (model) fields.model = model;

	if (subagent !== undefined) fields.subagent = subagent;

	if (subtask !== undefined) fields.subtask = subtask;

	return fields;
}

async function skills(store: FileStore): Promise<WorkspaceSkill[]> {
	const entries = await store.list(SKILLS_ROOT);
	const found = await Promise.all(entries.map((entry) => skillEntry(store, entry)));

	return found.filter((skill): skill is WorkspaceSkill => skill !== undefined);
}

/** One skill file, or undefined when it cannot be used. */
async function skillEntry(store: FileStore, entry: StoredEntry): Promise<WorkspaceSkill | undefined> {
	if (!entry.path.endsWith(".md")) return undefined;

	const relative = entry.path.slice(SKILLS_ROOT.length + 1);
	const parts = relative.split("/");

	if (parts.some((part) => part.startsWith("."))) return undefined;

	const filename = parts.at(-1) ?? "";

	const id =
		filename === "SKILL.md"
			? parts.at(-2)
			: parts.length === 1
				? filename.replace(/\.md$/, "")
				: undefined;

	if (!id || id === "SKILL.md") return undefined;

	const source = await text(store, entry.path);

	if (!source) return undefined;

	const markdown = ConfigMarkdown.parseOption(source);

	if (!markdown) {
		log("session", `ignored skill ${id}: invalid Markdown`);

		return undefined;
	}

	const data = record(markdown.data) ?? {};
	const metadata = record(data.metadata);

	const autoinvoke =
		boolean(metadata?.["opencode/autoinvoke"]) ??
		(boolean(data["disable-model-invocation"]) === true ? false : undefined);

	const description = string(data.description);

	const skill: Mutable<WorkspaceSkill> = {
		id,
		name: string(data.name) ?? id,
		path: entry.path,
		content: markdown.content.trim(),
	};

	if (description) skill.description = description;

	if (autoinvoke !== undefined) skill.autoinvoke = autoinvoke;

	return skill;
}

/** The fields a Markdown agent may set; matches OpenCode's agent frontmatter. */
const AGENT_FIELDS = new Set([
	"model",
	"variant",
	"request",
	"system",
	"description",
	"mode",
	"hidden",
	"color",
	"steps",
	"disabled",
	"permissions",
]);

/**
 * Markdown agents under `.opencode/agents`.
 *
 * The relative filename is the agent id, the frontmatter is the agent config,
 * and the body is its system prompt. `.opencode/agent` is accepted as an older
 * alias. Unsupported frontmatter is ignored so one bad key cannot fail the
 * whole host config.
 */
async function markdownAgents(store: FileStore): Promise<Record<string, ConfigObject>> {
	const roots = [AGENTS_ROOT, LEGACY_AGENTS_ROOT];

	const perRoot = await Promise.all(
		roots.map(async (root) => {
			const entries = await store.list(root);

			return await Promise.all(entries.map((entry) => agentEntry(store, root, entry)));
		}),
	);

	const found = perRoot.flat().filter((pair): pair is [string, ConfigObject] => pair !== undefined);

	return Object.fromEntries(found);
}

/** One Markdown agent, or undefined when it cannot be used. */
async function agentEntry(
	store: FileStore,
	root: string,
	entry: StoredEntry,
): Promise<[string, ConfigObject] | undefined> {
	if (!entry.path.endsWith(".md")) return undefined;

	const relative = entry.path.slice(root.length + 1).replace(/\.md$/, "");

	if (!relative || relative.split("/").some((part) => part.startsWith("."))) return undefined;

	const source = await text(store, entry.path);

	if (!source) return undefined;

	const markdown = ConfigMarkdown.parseOption(source);

	if (!markdown) {
		log("session", `ignored agent ${relative}: invalid Markdown`);

		return undefined;
	}

	const data = Object.fromEntries(
		Object.entries(record(markdown.data) ?? {}).filter(([key]) => AGENT_FIELDS.has(key)),
	);

	const model = string(data.model);
	const variant = string(data.variant);

	if (model && variant && !model.includes("#") && /^[^#]+$/.test(variant)) {
		data.model = `${model}#${variant}`;
	}

	delete data.variant;
	const system = markdown.content.trim();
	const agent: ConfigObject = { ...data };

	if (system) agent.system = system;

	return [relative, agent];
}

/** Protect command shell blocks in inline config before OpenCode sees them. */
function protectInlineCommands(value: Schema.Json | undefined): ConfigObject | undefined {
	if (!isJsonObject(value)) return undefined;

	const entries = Object.entries(value).map(([name, item]): [string, Schema.Json | undefined] => {
		const command = isJsonObject(item) ? item : undefined;
		const template = command !== undefined && isString(command.template) ? command.template : undefined;

		return [
			name,
			command !== undefined && template !== undefined
				? { ...command, template: protectShellBlocks(template) }
				: item,
		];
	});

	return Object.fromEntries(entries);
}

/**
 * Merge the document, the Markdown files, and the base every host starts from.
 *
 * Fields OpenCode would resolve through `node:fs`, plus integrations Eryn owns,
 * are removed before the config reaches the host.
 */
function assembleConfig(
	user: ConfigObject,
	localCommands: Record<string, CommandConfig>,
	localAgents: Record<string, ConfigObject>,
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
		skills: userSkills,
		instructions: userInstructions,
		commands: userCommands,
		permissions: userPermissions,
		agents: userAgents,
		experimental: userExperimental,
		...rest
	} = user;

	const inlineCommands = protectInlineCommands(userCommands);
	const skillUrls = urls(userSkills);
	const instructionUrls = urls(userInstructions);
	const userAgentConfig = record(userAgents);
	const extraPermissions: readonly Schema.Json[] = Array.isArray(userPermissions) ? userPermissions : [];

	const config: Mutable<Configuration> = {
		...BASE_CONFIG,
		// SAFETY: OpenCode validates the leftover keys; this module only strips its own.
		...(rest as Configuration),
		// A guild can add rules, but cannot remove the allow-all base Eryn's
		// policy layer is written against.
		// SAFETY: the entries are JSON from the document; OpenCode's policy schema
		// validates the action, resource, and effect strings.
		permissions: [
			...BASE_CONFIG.permissions,
			...extraPermissions,
		] as never,
		// SAFETY: OpenCode validates the agent table; this merge picks the winners.
		agents: {
			...BASE_CONFIG.agents,
			...userAgentConfig,
			...localAgents,
			title: {
				...BASE_CONFIG.agents.title,
				...record(userAgentConfig?.title),
			},
		},
		// Eryn relies on schedules and MCP event watches, so keep both enabled
		// even when a hand-edited config omits or disables either flag.
		// SAFETY: both flags are booleans; OpenCode validates the rest.
		experimental: {
			...record(userExperimental),
			schedules: true,
			mcp_events: true,
		},
	};

	if (skillUrls) config.skills = skillUrls;

	if (instructionUrls) config.instructions = instructionUrls;

	if (Object.keys(inlineCommands ?? {}).length || Object.keys(localCommands).length) {
		// SAFETY: both halves hold commands with string templates.
		config.commands = {
			...inlineCommands,
			...localCommands,
		} as never;
	}

	return config;
}

/** Read every file that shapes a guild's host. */
export async function readWorkspaceConfig(storage: WorkspaceStorage): Promise<WorkspaceConfig> {
	const store = fileStore(storage);
	const source = (await text(store, CONFIG_PATH)) ?? (await text(store, LEGACY_CONFIG_PATH));
	const user = source ? parseConfig(CONFIG_PATH, source) : {};
	const config = assembleConfig(user, await commands(store), await markdownAgents(store));

	return {
		config,
		skills: await skills(store),
		instructions: await text(store, INSTRUCTIONS_PATH),
	};
}

/**
 * A signature over the config files, so a host rebuilds when one changes.
 *
 * Only `/eryn` matters; editing project files under `/workspace` must not
 * rebuild the OpenCode host.
 */
export async function workspaceSignature(storage: WorkspaceStorage): Promise<string> {
	const store = fileStore(storage);
	const entries = await store.list(CONFIG_ROOT);

	return entries
		.filter((entry) => affectsHost(entry.path))
		.map((entry) => `${entry.path}:${entry.file.m}:${entry.file.b.length}`)
		.sort()
		.join("|");
}

/** Whether a file affects a host build; supporting scripts only affect the agent. */
function affectsHost(path: string): boolean {
	if (path === CONFIG_PATH || path === LEGACY_CONFIG_PATH || path === INSTRUCTIONS_PATH) return true;

	if (path.startsWith(`${COMMANDS_ROOT}/`) && path.endsWith(".md")) return true;

	if (path.startsWith(`${AGENTS_ROOT}/`) && path.endsWith(".md")) return true;

	if (path.startsWith(`${LEGACY_AGENTS_ROOT}/`) && path.endsWith(".md")) return true;

	if (!path.startsWith(`${SKILLS_ROOT}/`) || !path.endsWith(".md")) return false;
	const relative = path.slice(SKILLS_ROOT.length + 1);

	return relative.endsWith("/SKILL.md") || !relative.includes("/");
}
