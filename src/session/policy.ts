/**
 * Conversation policy: what Eryn may do in one channel or thread.
 *
 * A policy is deliberately a small layer over OpenCode's permission rules.
 * Admins choose a preset, optionally override a few groups, and optionally
 * allow or block one MCP server. The result is compiled into the session's
 * own permission list, so a blocked tool is not offered to the model at all.
 */

import type { McpLink, Policy, PolicyEffect, PolicyPreset } from "./models";

/** Groups the menu offers. A preset expands into every one of these. */
export const POLICY_GROUPS = [
	"workspace",
	"edit",
	"shell",
	"discord-reply",
	"discord-thread",
	"discord-channel",
	"discord-manage",
	"cross-channel",
	"web",
	"subagent",
] as const;

export type PolicyGroup = (typeof POLICY_GROUPS)[number];

/** The tools each group covers. Names are the names OpenCode gives the action. */
export const GROUP_TOOLS: Record<PolicyGroup, readonly string[]> = {
	workspace: ["read", "list", "glob", "grep"],
	edit: ["write", "edit", "patch"],
	shell: ["bash", "shell"],
	"discord-reply": [
		"discord_send_message",
		"discord_read_messages",
		"discord_react",
		"discord_list_channels",
		"discord_list_threads",
	],
	"discord-thread": [
		"discord_create_thread",
		"discord_join_thread",
		"discord_leave_thread",
		"discord_archive_thread",
		"discord_subscribe_message",
		"discord_unsubscribe_message",
	],
	"discord-channel": ["discord_join_channel", "discord_leave_channel"],
	"discord-manage": ["discord_edit_message", "discord_delete_message", "discord_pin_message"],
	// Not a tool of its own: every Discord tool asserts this synthetic action
	// before acting outside the conversation it was prompted in.
	"cross-channel": ["discord.cross-channel"],
	web: ["webfetch", "websearch"],
	subagent: ["subagent"],
};

export const GROUP_LABELS: Record<PolicyGroup, string> = {
	workspace: "Workspace reads",
	edit: "Workspace edits",
	shell: "Shell commands",
	"discord-reply": "Discord replies",
	"discord-thread": "Discord threads",
	"discord-channel": "Channel subscriptions",
	"discord-manage": "Manage messages",
	"cross-channel": "Cross-channel Discord",
	web: "Web access",
	subagent: "Subagents",
};

export const PRESET_LABELS: Record<PolicyPreset, string> = {
	full: "Full",
	chat: "Chat",
	"read-only": "Read-only",
	locked: "Locked",
};

export const PRESET_HINTS: Record<PolicyPreset, string> = {
	full: "Everything Eryn can do.",
	chat: "Talk in Discord, but do not touch the workspace or MCP servers.",
	"read-only": "Read the workspace and reply; no edits, shell, or MCP.",
	locked: "Only reply. Every other tool is hidden.",
};

/** The preset values, written out so a later preset can reset an earlier one. */
export const PRESETS: Record<PolicyPreset, Record<PolicyGroup, PolicyEffect>> = {
	full: {
		workspace: "allow",
		edit: "allow",
		shell: "allow",
		"discord-reply": "allow",
		"discord-thread": "allow",
		"discord-channel": "allow",
		"discord-manage": "allow",
		"cross-channel": "allow",
		web: "allow",
		subagent: "allow",
	},
	chat: {
		workspace: "block",
		edit: "block",
		shell: "block",
		"discord-reply": "allow",
		"discord-thread": "allow",
		"discord-channel": "allow",
		"discord-manage": "block",
		"cross-channel": "block",
		web: "block",
		subagent: "block",
	},
	"read-only": {
		workspace: "allow",
		edit: "block",
		shell: "block",
		"discord-reply": "allow",
		"discord-thread": "block",
		"discord-channel": "block",
		"discord-manage": "block",
		"cross-channel": "block",
		web: "block",
		subagent: "block",
	},
	locked: {
		workspace: "block",
		edit: "block",
		shell: "block",
		"discord-reply": "allow",
		"discord-thread": "block",
		"discord-channel": "block",
		"discord-manage": "block",
		"cross-channel": "block",
		web: "block",
		subagent: "block",
	},
};

/** What a preset does with MCP servers as a whole. */
const PRESET_MCP: Record<PolicyPreset, PolicyEffect> = {
	full: "allow",
	chat: "block",
	"read-only": "block",
	locked: "block",
};

/** `"*"` in a policy's MCP map means every server. */
export const MCP_ALL = "*";

/**
 * Resolve server, channel, and thread patches into one policy.
 *
 * A preset resets the groups at its scope, then any explicit group override in
 * the same patch (or a later scope) is applied. The result is always complete,
 * so rendering and compilation never need to know about inheritance.
 */
export function resolvePolicy(layers: readonly (Policy | undefined)[]): Policy {
	let tools: Record<string, PolicyEffect> = { ...PRESETS.full };
	let mcp: Record<string, PolicyEffect> = { [MCP_ALL]: "allow" };
	let elicitation: Policy["elicitation"] = "discord";
	let preset: PolicyPreset | undefined;

	for (const layer of layers) {
		if (!layer) continue;
		if (layer.preset) {
			preset = layer.preset;
			tools = { ...PRESETS[layer.preset] };
			mcp = { [MCP_ALL]: PRESET_MCP[layer.preset] };
		}
		if (layer.tools) tools = { ...tools, ...layer.tools };
		if (layer.mcp) mcp = { ...mcp, ...layer.mcp };
		if (layer.elicitation) elicitation = layer.elicitation;
	}

	return { preset, tools, mcp, ...(elicitation ? { elicitation } : {}) };
}

/** Whether a policy leaves everything at the default. */
export function isDefaultPolicy(policy: Policy): boolean {
	const resolved = resolvePolicy([policy]);
	const tools = resolved.tools ?? {};
	const mcp = resolved.mcp ?? {};
	// An exact tool or per-server override is not visible in the group values,
	// but it still changes behaviour, so it is never "default".
	if (Object.keys(tools).some((key) => !(key in GROUP_TOOLS))) return false;
	if (Object.keys(mcp).some((key) => key !== MCP_ALL)) return false;
	const matchesFull = POLICY_GROUPS.every((group) => tools[group] === PRESETS.full[group]);
	return matchesFull && (mcp[MCP_ALL] ?? "allow") === "allow" && (resolved.elicitation ?? "discord") === "discord";
}

/** The name OpenCode gives an MCP tool from a server and tool name. */
export function mcpToolName(server: string, tool: string): string {
	const namespace = server.replace(/[^a-zA-Z0-9_-]/g, "_");
	return `${namespace}_${tool.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

/** The wildcard that covers every tool one MCP server exposes. */
export function mcpActionPrefix(server: string): string {
	return `${server.replace(/[^a-zA-Z0-9_-]/g, "_")}_*`;
}

/** An OpenCode permission rule. */
export interface PermissionRule {
	readonly action: string;
	readonly resource: string;
	readonly effect: "allow" | "ask" | "deny";
}

/**
 * Compile a resolved policy into the rules appended to a session.
 *
 * Eryn's base config allows everything, so only non-allow effects need a rule.
 * A `deny` on `resource: "*"` also hides the tool from the model and from Code
 * Mode; `ask` keeps the tool visible and posts a card when it is called.
 */
export function compilePermissions(policy: Policy, links: readonly McpLink[]): PermissionRule[] {
	const rules: PermissionRule[] = [];
	const effects = policy.tools ?? {};
	const groups = Object.entries(effects).filter(([key]) => key in GROUP_TOOLS);
	const exact = Object.entries(effects).filter(([key]) => !(key in GROUP_TOOLS));

	const add = (action: string, effect: PolicyEffect, explicitAllow = false) => {
		// The reply tool is how the agent explains anything at all. Never hide it.
		if (action === "discord_send_message") return;
		if (effect === "allow") {
			// An exact allow must still be written when it overrides a group deny.
			if (explicitAllow) rules.push({ action, resource: "*", effect: "allow" });
			return;
		}
		rules.push({ action, resource: "*", effect: effect === "block" ? "deny" : "ask" });
	};

	for (const [group, effect] of groups) {
		for (const tool of GROUP_TOOLS[group as PolicyGroup]) add(tool, effect);
	}

	const mcp = policy.mcp ?? {};
	const all = mcp[MCP_ALL] ?? "allow";
	for (const link of links) add(mcpActionPrefix(link.name), mcp[link.name] ?? all);
	for (const [server, effect] of Object.entries(mcp)) {
		if (server === MCP_ALL) continue;
		add(mcpActionPrefix(server), effect);
	}

	// Exact overrides come last, so an approval for one tool beats both its
	// group and its MCP server rule.
	for (const [tool, effect] of exact) add(tool, effect, true);

	return rules;
}

/** The preset a resolved policy matches, or `undefined` when it has overrides. */
export function matchPreset(policy: Policy): PolicyPreset | undefined {
	const tools = policy.tools ?? {};
	const mcp = policy.mcp ?? {};
	// An exact tool or per-server override is a custom policy even when the
	// visible group values happen to line up with a preset.
	if (Object.keys(tools).some((key) => !(key in GROUP_TOOLS))) return undefined;
	if (Object.keys(mcp).some((key) => key !== MCP_ALL)) return undefined;
	const mcpAll = mcp[MCP_ALL] ?? "allow";
	for (const preset of Object.keys(PRESETS) as PolicyPreset[]) {
		if (!POLICY_GROUPS.every((group) => tools[group] === PRESETS[preset][group])) continue;
		if (mcpAll !== PRESET_MCP[preset]) continue;
		return preset;
	}
	return undefined;
}

/** A short title for the effective policy. */
export function policyTitle(policy: Policy): string {
	const preset = matchPreset(policy);
	return preset ? PRESET_LABELS[preset] : "Custom";
}

function effectLabel(effect: PolicyEffect | undefined): string {
	return effect === "block" ? "blocked" : effect === "ask" ? "ask" : "allowed";
}

/** Plain-language lines for the policy card and the menu. */
export function summaryLines(policy: Policy, servers: readonly string[]): string[] {
	const tools = policy.tools ?? {};
	const workspace = tools.workspace ?? "allow";
	const edit = tools.edit ?? "allow";
	const shell = tools.shell ?? "allow";
	const discord = [
		tools["discord-reply"],
		tools["discord-thread"],
		tools["discord-channel"],
		tools["discord-manage"],
		tools["cross-channel"],
	];

	const workspaceLine =
		workspace === "block"
			? "hidden"
			: workspace === "ask"
				? "ask before read"
				: edit === "block"
					? "read only"
					: edit === "ask"
						? "read, ask before write"
						: "read and write";
	const discordSummary = discord.some((effect) => effect === "ask")
		? "ask before use"
		: discord.every((effect) => effect === "allow")
			? "everything"
			: discord.every((effect) => effect === "block")
				? "send only"
				: discord[0] === "allow" && discord[1] === "allow" && discord[2] === "allow"
					? "chat and threads"
					: discord[0] === "allow"
						? "replies only"
						: "limited";
	const discordLine =
		tools["cross-channel"] === "block"
			? `${discordSummary} (cross-channel blocked)`
			: discordSummary;

	const mcp = policy.mcp ?? {};
	const all = mcp[MCP_ALL] ?? "allow";
	const blocked = servers.filter((server) => (mcp[server] ?? all) === "block");
	const mcpLine =
		all === "block"
			? blocked.length === servers.length || servers.length === 0
				? "blocked"
				: `blocked except ${servers.filter((server) => (mcp[server] ?? all) === "allow").join(", ")}`
			: all === "ask"
				? "ask before use"
				: blocked.length
					? `blocked in ${blocked.join(", ")}`
					: "allowed";

	const exact = Object.entries(tools).filter(([key]) => !(key in GROUP_TOOLS));
	const lines = [
		`Workspace: **${workspaceLine}**`,
		`Shell: **${effectLabel(shell)}**`,
		`Web: **${effectLabel(tools.web)}**`,
		`Subagents: **${effectLabel(tools.subagent)}**`,
		`Discord: **${discordLine}**`,
		`MCP: **${mcpLine}**`,
	];
	if (exact.length) {
		lines.push(`Custom: ${exact.map(([key, effect]) => `${key} **${effectLabel(effect)}**`).join(", ")}`);
	}
	return lines;
}

/**
 * Where a rule lives, so an approval writes the smallest possible override.
 *
 * Even an MCP action is written as the exact tool (`github_create_issue`), not
 * the whole server, so approving a read once does not allow every destructive
 * tool the same server exposes.
 */
export function overrideFor(action: string, effect: PolicyEffect): { tools: Record<string, PolicyEffect> } {
	return { tools: { [action]: effect } };
}

/** Merge one approval decision into the patch stored at a scope. */
export function withOverride(patch: Policy | undefined, override: ReturnType<typeof overrideFor>): Policy {
	return {
		...(patch ?? {}),
		...(override.tools ? { tools: { ...(patch?.tools ?? {}), ...override.tools } } : {}),
		updatedAt: Date.now(),
	};
}
