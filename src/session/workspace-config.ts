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
import { parse, type ParseError } from "jsonc-parser";

import { log } from "../config.ts";
import { base64ToBytes, bytesToText } from "../plugins/workspace/bytes.ts";
import { fileStore, type FileStore } from "../plugins/workspace/store.ts";

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

function record(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

function parseConfig(source: string, body: string): Configuration {
	const errors: ParseError[] = [];
	const parsed: unknown = parse(body, errors, { allowTrailingComma: true });
	if (errors.length) {
		log("session", `ignored ${source}: invalid JSONC`);
		return {};
	}
	const object = record(parsed);
	if (!object) {
		log("session", `ignored ${source}: config must be an object`);
		return {};
	}
	return object as Configuration;
}

/** Only HTTP(S) entries survive: local paths would resolve against `node:fs`. */
function urls(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const found = value.filter((entry): entry is string => {
		if (typeof entry !== "string") return false;
		try {
			const protocol = new URL(entry).protocol;
			return protocol === "http:" || protocol === "https:";
		} catch {
			return false;
		}
	});
	return found.length ? found : undefined;
}

function safe(value: unknown, field: string, source: string): string | undefined {
	if (value === undefined) return undefined;
	const parsed = string(value);
	if (!parsed) log("session", `ignored ${field} in ${source}: expected a string`);
	return parsed;
}

async function commands(store: FileStore): Promise<Record<string, Record<string, unknown>>> {
	const result: Record<string, Record<string, unknown>> = {};
	for (const entry of await store.list(COMMANDS_ROOT)) {
		if (!entry.path.endsWith(".md")) continue;
		const name = entry.path.slice(COMMANDS_ROOT.length + 1).replace(/\.md$/, "");
		if (name.split("/").some((part) => part.startsWith("."))) continue;
		const source = await text(store, entry.path);
		if (!source) continue;
		const markdown = ConfigMarkdown.parseOption(source);
		if (!markdown) {
			log("session", `ignored command ${name}: invalid Markdown`);
			continue;
		}
		const data = record(markdown.data) ?? {};
		const template = protectShellBlocks(markdown.content.trim());
		if (!template) {
			log("session", `ignored command ${name}: empty template`);
			continue;
		}
		const model = string(data.model);
		const description = safe(data.description, "description", `command ${name}`);
		const agent = safe(data.agent, "agent", `command ${name}`);
		const subagent = boolean(data.subagent);
		const subtask = boolean(data.subtask);
		const info: Record<string, unknown> = {
			template,
			...(description ? { description } : {}),
			...(agent ? { agent } : {}),
			...(model ? { model } : {}),
			...(subagent === undefined ? {} : { subagent }),
			...(subtask === undefined ? {} : { subtask }),
		};
		result[name] = info;
	}
	return result;
}

async function skills(store: FileStore): Promise<WorkspaceSkill[]> {
	const found: WorkspaceSkill[] = [];
	for (const entry of await store.list(SKILLS_ROOT)) {
		if (!entry.path.endsWith(".md")) continue;
		const relative = entry.path.slice(SKILLS_ROOT.length + 1);
		const parts = relative.split("/");
		if (parts.some((part) => part.startsWith("."))) continue;
		const filename = parts.at(-1) ?? "";
		const id =
			filename === "SKILL.md"
				? parts.at(-2)
				: parts.length === 1
					? filename.replace(/\.md$/, "")
					: undefined;
		if (!id || id === "SKILL.md") continue;
		const source = await text(store, entry.path);
		if (!source) continue;
		const markdown = ConfigMarkdown.parseOption(source);
		if (!markdown) {
			log("session", `ignored skill ${id}: invalid Markdown`);
			continue;
		}
		const data = record(markdown.data) ?? {};
		const metadata = record(data.metadata);
		const autoinvoke =
			boolean(metadata?.["opencode/autoinvoke"]) ??
			(boolean(data["disable-model-invocation"]) === true ? false : undefined);
		found.push({
			id,
			name: string(data.name) ?? id,
			...(string(data.description) ? { description: string(data.description) } : {}),
			...(autoinvoke === undefined ? {} : { autoinvoke }),
			path: entry.path,
			content: markdown.content.trim(),
		});
	}
	return found;
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
async function markdownAgents(store: FileStore): Promise<Record<string, Record<string, unknown>>> {
	const found: Record<string, Record<string, unknown>> = {};
	for (const root of [AGENTS_ROOT, LEGACY_AGENTS_ROOT]) {
		for (const entry of await store.list(root)) {
			if (!entry.path.endsWith(".md")) continue;
			const relative = entry.path.slice(root.length + 1).replace(/\.md$/, "");
			if (!relative || relative.split("/").some((part) => part.startsWith("."))) continue;
			const source = await text(store, entry.path);
			if (!source) continue;
			const markdown = ConfigMarkdown.parseOption(source);
			if (!markdown) {
				log("session", `ignored agent ${relative}: invalid Markdown`);
				continue;
			}
			const data = Object.fromEntries(
				Object.entries(record(markdown.data) ?? {}).filter(([key]) => AGENT_FIELDS.has(key)),
			);
			if (
				typeof data.model === "string" &&
				!data.model.includes("#") &&
				typeof data.variant === "string" &&
				/^[^#]+$/.test(data.variant)
			) {
				data.model = `${data.model}#${data.variant}`;
			}
			delete data.variant;
			const system = markdown.content.trim();
			found[relative] = {
				...data,
				...(system ? { system } : {}),
			};
		}
	}
	return found;
}

/** Protect command shell blocks in inline config before OpenCode sees them. */
function protectInlineCommands(value: unknown): Record<string, unknown> | undefined {
	const entries = record(value);
	if (!entries) return undefined;
	const result: Record<string, unknown> = {};
	for (const [name, item] of Object.entries(entries)) {
		const command = record(item);
		result[name] =
			command && typeof command.template === "string"
				? { ...command, template: protectShellBlocks(command.template) }
				: item;
	}
	return result;
}

/** Read every file that shapes a guild's host. */
export async function readWorkspaceConfig(storage: DurableObjectStorage): Promise<WorkspaceConfig> {
	const store = fileStore(storage);
	const source = (await text(store, CONFIG_PATH)) ?? (await text(store, LEGACY_CONFIG_PATH));
	const parsed = source ? parseConfig(CONFIG_PATH, source) : {};
	const user = parsed as Record<string, unknown>;

	// Fields OpenCode would resolve through `node:fs`, plus integrations Eryn
	// owns, are removed before the config reaches the host.
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

	const localCommands = await commands(store);
	const localAgents = await markdownAgents(store);
	const inlineCommands = protectInlineCommands(userCommands);
	const skillUrls = urls(userSkills);
	const instructionUrls = urls(userInstructions);
	const userAgentConfig = record(userAgents);
	const config: Configuration = {
		...BASE_CONFIG,
		...(rest as Configuration),
		// A guild can add rules, but cannot remove the allow-all base Eryn's
		// policy layer is written against.
		permissions: [
			...BASE_CONFIG.permissions,
			...(Array.isArray(userPermissions) ? userPermissions : []),
		] as never,
		agents: {
			...BASE_CONFIG.agents,
			...userAgentConfig,
			...localAgents,
			title: {
				...BASE_CONFIG.agents.title,
				...record(userAgentConfig?.title),
			},
		} as never,
		// Eryn relies on schedules and MCP event watches, so keep both enabled
		// even when a hand-edited config omits or disables either flag.
		experimental: {
			...record(userExperimental),
			schedules: true,
			mcp_events: true,
		} as never,
		...(skillUrls ? { skills: skillUrls } : {}),
		...(instructionUrls ? { instructions: instructionUrls } : {}),
		...(Object.keys(inlineCommands ?? {}).length || Object.keys(localCommands).length
			? {
					commands: {
						...(inlineCommands ?? {}),
						...localCommands,
					} as never,
				}
			: {}),
	};

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
export async function workspaceSignature(storage: DurableObjectStorage): Promise<string> {
	const store = fileStore(storage);
	const entries = await store.list(CONFIG_ROOT);
	return entries
		.filter((entry) => shapesHost(entry.path))
		.map((entry) => `${entry.path}:${entry.file.m}:${entry.file.b.length}`)
		.sort()
		.join("|");
}

/** Whether a file affects a host build; supporting scripts only affect the agent. */
function shapesHost(path: string): boolean {
	if (path === CONFIG_PATH || path === LEGACY_CONFIG_PATH || path === INSTRUCTIONS_PATH) return true;
	if (path.startsWith(`${COMMANDS_ROOT}/`) && path.endsWith(".md")) return true;
	if (path.startsWith(`${AGENTS_ROOT}/`) && path.endsWith(".md")) return true;
	if (path.startsWith(`${LEGACY_AGENTS_ROOT}/`) && path.endsWith(".md")) return true;
	if (!path.startsWith(`${SKILLS_ROOT}/`) || !path.endsWith(".md")) return false;
	const relative = path.slice(SKILLS_ROOT.length + 1);
	return relative.endsWith("/SKILL.md") || !relative.includes("/");
}
