/**
 * Discord's permission algorithm, as a pure function.
 *
 * The bot's REST client is an ambient authority: every tool call can reach
 * anything the bot can. This module answers a different question — what may the
 * *person who prompted the turn* do in a given channel? — so the tools can hold
 * the speaker to their own Discord permissions instead of the bot's.
 *
 * Nothing here performs I/O or depends on Effect. A malformed or missing value
 * resolves to "no permission": an authorization decision that cannot be made is
 * a denial, never a grant.
 */

/** The Discord permission bits this bot uses, as BigInt masks. */
export const Permission = {
	ManageChannels: 1n << 4n,
	ManageGuild: 1n << 5n,
	AddReactions: 1n << 6n,
	Administrator: 1n << 3n,
	ViewChannel: 1n << 10n,
	SendMessages: 1n << 11n,
	ManageMessages: 1n << 13n,
	ReadMessageHistory: 1n << 16n,
	ManageThreads: 1n << 34n,
	CreatePublicThreads: 1n << 35n,
	SendMessagesInThreads: 1n << 38n,
} as const;

/** Every permission, including bits Discord has not defined yet. */
export const ALL_PERMISSIONS = (1n << 64n) - 1n;

/** One channel permission overwrite, in Discord's wire shape. */
export interface PermissionOverwriteLike {
	readonly id: string;
	readonly type: number;
	readonly allow: string;
	readonly deny: string;
}

/** The role fields the resolver reads. */
export interface PermissionRole {
	readonly id: string;
	readonly permissions?: string;
	readonly position?: number;
}

/** The channel fields the resolver reads. */
export interface PermissionChannel {
	readonly id: string;
	readonly type: number;
	readonly parent_id?: string;
	readonly permission_overwrites?: readonly PermissionOverwriteLike[];
}

export interface GuildPermissionInput {
	/** The guild id, which is also the `@everyone` role id. */
	readonly guildId: string;
	readonly ownerId?: string;
	readonly userId: string;
	readonly roles: readonly PermissionRole[];
	readonly memberRoleIds: readonly string[];
}

export interface EffectivePermissionInput extends GuildPermissionInput {
	readonly channel: PermissionChannel;
	/** The parent channel, for a thread. */
	readonly parent?: PermissionChannel;
	/** Whether the user is a member of the thread. Ignored outside threads. */
	readonly isThreadMember?: boolean;
}

/** Thread channel types. Kept local so this module has no Discord imports. */
const THREAD_TYPES = new Set([10, 11, 12]);
const PRIVATE_THREAD = 12;

/** Parse a Discord permission bitmask, treating anything unreadable as zero. */
export function parsePermissions(value: string | undefined): bigint {
	if (!value) return 0n;
	try {
		return BigInt(value) & ALL_PERMISSIONS;
	} catch {
		return 0n;
	}
}

/** Whether a resolved mask contains every bit in `required`. */
export function hasPermission(permissions: bigint, required: bigint): boolean {
	return (permissions & required) === required;
}

/**
 * The permissions a member has from their roles alone (no channel overwrites).
 *
 * The owner and anyone with Administrator get everything; otherwise it is the
 * union of `@everyone` and the member's roles. A role whose permissions did not
 * arrive contributes zero.
 */
export function guildPermissions(input: GuildPermissionInput): bigint {
	if (input.ownerId !== undefined && input.ownerId === input.userId) return ALL_PERMISSIONS;

	const everyone = input.roles.find((role) => role.id === input.guildId);
	let permissions = parsePermissions(everyone?.permissions);
	for (const roleId of input.memberRoleIds) {
		// `@everyone` is always present and already counted.
		if (roleId === input.guildId) continue;
		const role = input.roles.find((candidate) => candidate.id === roleId);
		permissions |= parsePermissions(role?.permissions);
	}
	return hasPermission(permissions, Permission.Administrator) ? ALL_PERMISSIONS : permissions;
}

/** Apply one overwrite: a deny wins over an allow for the same bit. */
export function applyOverwrite(permissions: bigint, overwrite: PermissionOverwriteLike): bigint {
	return (permissions & ~parsePermissions(overwrite.deny)) | parsePermissions(overwrite.allow);
}

/** The overwrites that apply to a channel, preferring a thread's own list. */
export function overwritesFor(
	channel: PermissionChannel,
	parent: PermissionChannel | undefined,
): readonly PermissionOverwriteLike[] {
	if (THREAD_TYPES.has(channel.type)) {
		// An empty list is not a grant: a thread inherits its parent's
		// overwrites, so only a non-empty thread list replaces them.
		const own = channel.permission_overwrites;
		if (own !== undefined && own.length > 0) return own;
		return parent?.permission_overwrites ?? [];
	}
	return channel.permission_overwrites ?? [];
}

/** The effective permissions of one member in one channel or thread. */
export function effectivePermissions(input: EffectivePermissionInput): bigint {
	let permissions = guildPermissions(input);
	// An administrator is not subject to overwrites.
	if (permissions === ALL_PERMISSIONS) return ALL_PERMISSIONS;

	const overwrites = overwritesFor(input.channel, input.parent);
	// Discord applies `@everyone`, then role overwrites from lowest to highest
	// role, then the member overwrite. The later write wins per bit.
	const everyone = overwrites.find((overwrite) => overwrite.type === 0 && overwrite.id === input.guildId);
	if (everyone) permissions = applyOverwrite(permissions, everyone);

	const positions = new Map(input.roles.map((role) => [role.id, role.position ?? 0]));
	const roleOverwrites = overwrites
		.filter(
			(overwrite) =>
				overwrite.type === 0 &&
				overwrite.id !== input.guildId &&
				input.memberRoleIds.includes(overwrite.id),
		)
		.sort((a, b) => (positions.get(a.id) ?? 0) - (positions.get(b.id) ?? 0));
	for (const overwrite of roleOverwrites) permissions = applyOverwrite(permissions, overwrite);

	const member = overwrites.find((overwrite) => overwrite.type === 1 && overwrite.id === input.userId);
	if (member) permissions = applyOverwrite(permissions, member);

	// A private thread also requires being in it, or a thread/channel manager.
	// Returning no permissions (rather than a separate boolean) keeps every
	// caller fail-closed without having to remember this rule.
	if (input.channel.type === PRIVATE_THREAD) {
		const manages =
			hasPermission(permissions, Permission.ManageThreads) ||
			hasPermission(permissions, Permission.ManageChannels) ||
			hasPermission(permissions, Permission.Administrator);
		if (input.isThreadMember !== true && !manages) return 0n;
	}

	return permissions;
}
