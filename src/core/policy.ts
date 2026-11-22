/**
 * Who may use an Eryn server, and what they may do.
 *
 * Discord roles map to a profile, with optional per-role overrides. The guild
 * owner bypasses the map; iMessage numbers are trusted by the provider. The
 * default is deny: a newly bound guild gets no permissions until the owner
 * maps a role.
 *
 * Nothing here touches storage or the network. Hub computes a principal's
 * effective permissions when a message arrives, and the Server's tool hook
 * reads that result for each tool call.
 */

import { Schema } from "effect";

export const PolicyEffectSchema = Schema.Literals(["allow", "ask", "block"]);

export type PolicyEffect = typeof PolicyEffectSchema.Type;

/** `*` means every conversation; a list names the external channel ids. */
export const PolicyChannelsSchema = Schema.Union([Schema.Literal("*"), Schema.Array(Schema.String)]);

export type PolicyChannels = typeof PolicyChannelsSchema.Type;

/** The grant a profile or a principal carries. */
export const PermissionSetSchema = Schema.Struct({
	invoke: Schema.Boolean,
	channels: PolicyChannelsSchema,
	tools: Schema.Record(Schema.String, PolicyEffectSchema),
	mcp: Schema.Record(Schema.String, PolicyEffectSchema),
	crossChannel: PolicyEffectSchema,
	admin: Schema.Boolean,
});

export type PermissionSet = typeof PermissionSetSchema.Type;

/** A sparse change applied on top of a role's profile. */
export const PermissionOverridesSchema = Schema.Struct({
	invoke: Schema.optional(Schema.Boolean),
	channels: Schema.optional(PolicyChannelsSchema),
	tools: Schema.optional(Schema.Record(Schema.String, PolicyEffectSchema)),
	mcp: Schema.optional(Schema.Record(Schema.String, PolicyEffectSchema)),
	crossChannel: Schema.optional(PolicyEffectSchema),
	admin: Schema.optional(Schema.Boolean),
});

export type PermissionOverrides = typeof PermissionOverridesSchema.Type;

export const RoleProfileSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	permissions: PermissionSetSchema,
	builtin: Schema.optional(Schema.Boolean),
});

export type RoleProfile = typeof RoleProfileSchema.Type;

export const RoleMappingSchema = Schema.Struct({
	roleId: Schema.String,
	roleName: Schema.String,
	profileId: Schema.String,
	overrides: Schema.optional(PermissionOverridesSchema),
});

export type RoleMapping = typeof RoleMappingSchema.Type;

export const ServerPolicySchema = Schema.Struct({
	/** The Discord guild owner, who always has every permission. */
	ownerDiscordId: Schema.optional(Schema.String),
	defaultProfileId: Schema.String,
	profiles: Schema.Array(RoleProfileSchema),
	roles: Schema.Array(RoleMappingSchema),
	/** Sparse overrides for one conversation, applied after the role merge. */
	channelOverrides: Schema.optional(Schema.Record(Schema.String, PermissionOverridesSchema)),
	updatedAt: Schema.Finite,
});

export type ServerPolicy = typeof ServerPolicySchema.Type;

/** The speaker and resolved permissions for a conversation, as Hub stores them. */
export const PrincipalRecordSchema = Schema.Struct({
	channel: Schema.String,
	authorId: Schema.String,
	name: Schema.String,
	roles: Schema.Array(Schema.String),
	permissions: PermissionSetSchema,
	updatedAt: Schema.Finite,
});

export type PrincipalRecord = typeof PrincipalRecordSchema.Type;

/** A Discord member as the policy sees them. */
export interface PolicyPrincipal {
	readonly id: string;
	readonly name?: string;
	readonly roles?: readonly string[];
}

/**
 * The built-in profiles.
 *
 * `member` is a useful starting point for a shared guild: conversation and
 * workspace work are allowed, the shell and outside tools ask. `guest` can
 * talk but not reach anything else. `blocked` is the `@everyone` default.
 */
const OWNER_PROFILE: RoleProfile = {
	id: "owner",
	name: "Owner",
	builtin: true,
	permissions: {
		invoke: true,
		channels: "*",
		tools: { "*": "allow" },
		mcp: { "*": "allow" },
		crossChannel: "allow",
		admin: true,
	},
};

const MEMBER_PROFILE: RoleProfile = {
	id: "member",
	name: "Member",
	builtin: true,
	permissions: {
		invoke: true,
		channels: "*",
		tools: { "*": "allow", bash: "ask" },
		mcp: { "*": "ask" },
		crossChannel: "ask",
		admin: false,
	},
};

const GUEST_PROFILE: RoleProfile = {
	id: "guest",
	name: "Guest",
	builtin: true,
	permissions: {
		invoke: true,
		channels: "*",
		tools: {
			"*": "block",
			send_message: "allow",
			read_history: "allow",
			list_channels: "allow",
			current_channel: "allow",
		},
		mcp: { "*": "block" },
		crossChannel: "block",
		admin: false,
	},
};

const BLOCKED_PROFILE: RoleProfile = {
	id: "blocked",
	name: "Blocked",
	builtin: true,
	permissions: {
		invoke: false,
		channels: [],
		tools: { "*": "block" },
		mcp: { "*": "block" },
		crossChannel: "block",
		admin: false,
	},
};

export function builtinProfiles(): RoleProfile[] {
	return [OWNER_PROFILE, MEMBER_PROFILE, GUEST_PROFILE, BLOCKED_PROFILE];
}

/** A server's first policy: owner full, everyone else blocked. */
export function defaultPolicy(ownerDiscordId?: string): ServerPolicy {
	const policy: ServerPolicy = {
		defaultProfileId: "blocked",
		profiles: builtinProfiles(),
		roles: [],
		updatedAt: Date.now(),
	};

	return ownerDiscordId ? { ...policy, ownerDiscordId } : policy;
}

/** The permissions a guild owner has, independent of the stored profiles. */
export function ownerPermissions(): PermissionSet {
	return {
		invoke: true,
		channels: "*",
		tools: { "*": "allow" },
		mcp: { "*": "allow" },
		crossChannel: "allow",
		admin: true,
	};
}

/** A profile by id, falling back to the blocked profile. */
export function profileFor(policy: ServerPolicy, id: string): RoleProfile {
	return (
		policy.profiles.find((profile) => profile.id === id) ??
		policy.profiles.find((profile) => profile.id === "blocked") ??
		BLOCKED_PROFILE
	);
}

/** Apply a sparse override to a permission set. */
export function applyOverrides(base: PermissionSet, overrides: PermissionOverrides | undefined): PermissionSet {
	if (!overrides) return base;

	return {
		invoke: overrides.invoke ?? base.invoke,
		channels: overrides.channels ?? base.channels,
		tools: overrides.tools ?? base.tools,
		mcp: overrides.mcp ?? base.mcp,
		crossChannel: overrides.crossChannel ?? base.crossChannel,
		admin: overrides.admin ?? base.admin,
	};
}

/** The stricter of two effects. Deny beats ask beats allow. */
export function stricter(a: PolicyEffect, b: PolicyEffect): PolicyEffect {
	if (a === "block" || b === "block") return "block";
	if (a === "ask" || b === "ask") return "ask";

	return "allow";
}

function mergeMaps(
	left: Readonly<Record<string, PolicyEffect>>,
	right: Readonly<Record<string, PolicyEffect>>,
) {
	const merged = { ...left };

	for (const [key, effect] of Object.entries(right)) {
		const previous = merged[key];

		merged[key] = previous === undefined ? effect : stricter(previous, effect);
	}

	return merged;
}

/**
 * Combine the permissions of every role a member has.
 *
 * Grants are additive, but a block anywhere wins. A member with no mapped role
 * gets the server's default profile, which starts as blocked.
 */
export function permissionsFor(
	policy: ServerPolicy,
	principal: PolicyPrincipal,
	channel?: string,
): PermissionSet {
	if (policy.ownerDiscordId && principal.id === policy.ownerDiscordId) return ownerPermissions();
	const roles = principal.roles ?? [];
	const mappings = policy.roles.filter((mapping) => roles.includes(mapping.roleId));
	const channelOverride = channel ? policy.channelOverrides?.[channel] : undefined;

	if (mappings.length === 0) {
		return applyOverrides(profileFor(policy, policy.defaultProfileId).permissions, channelOverride);
	}
	const sets = mappings.map((mapping) =>
		applyOverrides(profileFor(policy, mapping.profileId).permissions, mapping.overrides),
	);

	const first = sets[0];

	if (!first) return profileFor(policy, "blocked").permissions;

	const combined = sets.slice(1).reduce<PermissionSet>(
		(acc, set) => ({
			invoke: acc.invoke || set.invoke,
			channels: mergeChannels(acc.channels, set.channels),
			tools: mergeMaps(acc.tools, set.tools),
			mcp: mergeMaps(acc.mcp, set.mcp),
			crossChannel: stricter(acc.crossChannel, set.crossChannel),
			admin: acc.admin || set.admin,
		}),
		first,
	);

	return applyOverrides(combined, channelOverride);
}

function mergeChannels(left: PolicyChannels, right: PolicyChannels): PolicyChannels {
	if (left === "*" || right === "*") return "*";

	return [...new Set([...left, ...right])];
}

/** Whether a principal may invoke the agent in this conversation. */
export function canInvoke(policy: ServerPolicy, principal: PolicyPrincipal, channel: string): boolean {
	const permissions = permissionsFor(policy, principal, channel);

	return permissions.invoke && canUseChannel(permissions, channel);
}

export function canUseChannel(permissions: PermissionSet, channel: string): boolean {
	return permissions.channels === "*" || permissions.channels.includes(channel);
}

/**
 * The decision for one tool call.
 *
 * `mcpServers` is the server names linked to this Eryn server, so an MCP tool
 * `github_create_issue` can match the `github` and `github_create_issue` keys
 * without guessing from the underscore alone.
 */
export function toolDecision(
	permissions: PermissionSet,
	tool: string,
	options: {
		readonly mcpServers?: readonly string[];
		readonly currentChannel?: string;
		readonly requestedChannel?: string;
	} = {},
): PolicyEffect {
	if (
		options.currentChannel &&
		options.requestedChannel &&
		options.requestedChannel !== options.currentChannel
	) {
		return permissions.crossChannel;
	}

	const server = (options.mcpServers ?? []).find(
		(name) => tool === name || tool.startsWith(name + "_"),
	);

	if (server) {
		const exact = permissions.mcp[tool];

		if (exact) return exact;
		const serverWide = permissions.mcp[server];

		if (serverWide) return serverWide;

		return permissions.mcp["*"] ?? "block";
	}

	return permissions.tools[tool] ?? permissions.tools["*"] ?? "block";
}

/** A session-scoped grant written by `always` on an approval. */
export interface SessionGrants {
	readonly tools: Record<string, PolicyEffect>;
	readonly mcp: Record<string, PolicyEffect>;
}

export const SessionGrantsSchema = Schema.Struct({
	tools: Schema.Record(Schema.String, PolicyEffectSchema),
	mcp: Schema.Record(Schema.String, PolicyEffectSchema),
});

/** Apply a session grant after the principal's own permissions. */
export function withSessionGrant(
	permissions: PermissionSet,
	grant: SessionGrants | undefined,
	tool: string,
): PermissionSet {
	if (!grant) return permissions;
	const tools = { ...permissions.tools, ...grant.tools };
	const mcp = { ...permissions.mcp, ...grant.mcp };

	return { ...permissions, tools, mcp };
}
