/**
 * Per-guild authorization for the speaker behind a Discord tool call.
 *
 * Eryn's tools run with the bot's token, so Discord only enforces the bot's own
 * permissions. This class answers the other half of the question: may the user
 * who prompted this turn do this, here? It caches Discord lookups because a
 * single turn can call several tools, and a member's roles or a channel's
 * overwrites do not change between two calls in the same minute.
 *
 * Every failure — a missing member, a guild lookup that 404s, a thrown request
 * — resolves to "no permission". Authorization that cannot be established is
 * denied, never granted.
 */

import { THREAD_TYPES, type DiscordChannelRef, type DiscordRest, type DiscordRole } from "./api";
import {
	effectivePermissions,
	guildPermissions,
	hasPermission,
	Permission,
} from "./permissions";

/** How long the guild's roles and owner are trusted. These change rarely. */
const GUILD_TTL_MS = 5 * 60_000;
/**
 * How long a member's roles are trusted. A demotion should take effect within
 * seconds, not minutes, so this is deliberately short.
 */
const MEMBER_TTL_MS = 30_000;
/** Channel overwrites and thread membership change about as often as membership. */
const CHANNEL_TTL_MS = 30_000;
const THREAD_MEMBER_TTL_MS = 30_000;
/** A failed lookup is retried soon, but not on every tool call. */
const FAILURE_TTL_MS = 5_000;

interface GuildPermissions {
	readonly roles: readonly DiscordRole[];
	readonly ownerId?: string;
}

interface CacheEntry<T> {
	readonly value: T;
	readonly expiresAt: number;
}

export class DiscordAuthority {
	/** The guild-wide role list and owner id. */
	private guild?: CacheEntry<GuildPermissions | undefined>;
	/** Role ids per member. */
	private readonly members = new Map<string, CacheEntry<readonly string[] | undefined>>();
	/** Channel metadata, keyed by channel id (parents included). */
	private readonly channels = new Map<string, CacheEntry<DiscordChannelRef | undefined>>();
	/** Private-thread membership, keyed by `threadId:userId`. */
	private readonly threadMembers = new Map<string, CacheEntry<boolean>>();

	constructor(
		private readonly rest: DiscordRest,
		private readonly guildId: string,
	) {}

	private fresh<T>(entry: CacheEntry<T> | undefined, now: number): entry is CacheEntry<T> {
		return entry !== undefined && entry.expiresAt > now;
	}

	private async guildPermissions(): Promise<GuildPermissions | undefined> {
		const now = Date.now();
		const cached = this.guild;
		if (this.fresh(cached, now)) return cached.value;
		try {
			const [roles, info] = await Promise.all([
				this.rest.guildRoles(this.guildId),
				this.rest.guildInfo(this.guildId),
			]);
			const value: GuildPermissions = {
				roles,
				...(info?.ownerId ? { ownerId: info.ownerId } : {}),
			};
			this.guild = { value, expiresAt: now + GUILD_TTL_MS };
			return value;
		} catch {
			this.guild = { value: undefined, expiresAt: now + FAILURE_TTL_MS };
			return undefined;
		}
	}

	private async memberRoles(userId: string): Promise<readonly string[] | undefined> {
		const now = Date.now();
		const cached = this.members.get(userId);
		if (this.fresh(cached, now)) return cached.value;
		try {
			const member = await this.rest.guildMember(this.guildId, userId);
			// Undefined means Discord said this user is not a member; there is
			// nothing to grant them.
			this.members.set(userId, {
				value: member?.roles,
				expiresAt: now + (member ? MEMBER_TTL_MS : FAILURE_TTL_MS),
			});
			return member?.roles;
		} catch {
			this.members.set(userId, { value: undefined, expiresAt: now + FAILURE_TTL_MS });
			return undefined;
		}
	}

	private async channelInfo(channelId: string): Promise<DiscordChannelRef | undefined> {
		const now = Date.now();
		const cached = this.channels.get(channelId);
		if (this.fresh(cached, now)) return cached.value;
		try {
			const channel = await this.rest.channel(channelId);
			this.channels.set(channelId, {
				value: channel,
				expiresAt: now + (channel ? CHANNEL_TTL_MS : FAILURE_TTL_MS),
			});
			return channel;
		} catch {
			this.channels.set(channelId, { value: undefined, expiresAt: now + FAILURE_TTL_MS });
			return undefined;
		}
	}

	/** A thread and its parent. A missing parent is a denial, not an empty overwrite list. */
	private async channelAndParent(
		channelId: string,
	): Promise<{ channel: DiscordChannelRef; parent?: DiscordChannelRef } | undefined> {
		const channel = await this.channelInfo(channelId);
		if (!channel) return undefined;
		if (!THREAD_TYPES.has(channel.type) || !channel.parent_id) return { channel };
		const parent = await this.channelInfo(channel.parent_id);
		if (!parent) return undefined;
		return { channel, parent };
	}

	private async threadMember(threadId: string, userId: string): Promise<boolean> {
		const key = `${threadId}:${userId}`;
		const now = Date.now();
		const cached = this.threadMembers.get(key);
		if (this.fresh(cached, now)) return cached.value;
		// The REST helper already maps every failure to false; catching here
		// keeps a future change to it from turning into a grant.
		const member = await this.rest.isThreadMember(threadId, userId).catch(() => false);
		this.threadMembers.set(key, { value: member, expiresAt: now + THREAD_MEMBER_TTL_MS });
		return member;
	}

	/** Whether `userId` has every bit in `required` in `channelId`. */
	async can(userId: string, channelId: string, required: bigint): Promise<boolean> {
		try {
			const [member, guild, found] = await Promise.all([
				this.memberRoles(userId),
				this.guildPermissions(),
				this.channelAndParent(channelId),
			]);
			if (!member || !guild || !found) return false;
			const isThreadMember =
				found.channel.type === 12 ? await this.threadMember(channelId, userId) : false;
			const permissions = effectivePermissions({
				guildId: this.guildId,
				...(guild.ownerId ? { ownerId: guild.ownerId } : {}),
				userId,
				roles: guild.roles,
				memberRoleIds: member,
				channel: found.channel,
				...(found.parent ? { parent: found.parent } : {}),
				isThreadMember,
			});
			return hasPermission(permissions, required);
		} catch {
			return false;
		}
	}

	/** Whether `userId` may configure the server (Discord's Manage Server bit). */
	async canManageGuild(userId: string): Promise<boolean> {
		try {
			const [member, guild] = await Promise.all([this.memberRoles(userId), this.guildPermissions()]);
			if (!member || !guild) return false;
			const permissions = guildPermissions({
				guildId: this.guildId,
				...(guild.ownerId ? { ownerId: guild.ownerId } : {}),
				userId,
				roles: guild.roles,
				memberRoleIds: member,
			});
			return hasPermission(permissions, Permission.ManageGuild);
		} catch {
			return false;
		}
	}

	/**
	 * The read/send/manage capabilities `userId` has in one channel.
	 *
	 * Used when a schedule is created or its scope expands: the schedule must
	 * not gain more Discord reach than the person creating or editing it.
	 */
	async scopeCapabilities(
		userId: string,
		channel: DiscordChannelRef,
	): Promise<{ read: boolean; send: boolean; manage: boolean }> {
		const thread = THREAD_TYPES.has(channel.type);
		return {
			read: await this.can(
				userId,
				channel.id,
				Permission.ViewChannel | Permission.ReadMessageHistory,
			),
			send: await this.can(
				userId,
				channel.id,
				Permission.ViewChannel |
					(thread ? Permission.SendMessagesInThreads : Permission.SendMessages),
			),
			manage: await this.can(
				userId,
				channel.id,
				Permission.ViewChannel | (thread ? Permission.ManageThreads : Permission.ManageMessages),
			),
		};
	}

	/**
	 * The channels `userId` can view, preserving the caller's order.
	 *
	 * Member roles and the guild are resolved once, but every channel still
	 * needs its own overwrites. A channel whose overwrites cannot be read is
	 * omitted rather than shown.
	 */
	async filterVisible(
		userId: string,
		channels: readonly DiscordChannelRef[],
	): Promise<DiscordChannelRef[]> {
		try {
			const [member, guild] = await Promise.all([this.memberRoles(userId), this.guildPermissions()]);
			if (!member || !guild) return [];
			// The caller has already listed these channels, so their metadata is
			// fresher than a per-channel fetch and saves parents being re-read.
			const now = Date.now();
			for (const channel of channels) {
				this.channels.set(channel.id, { value: channel, expiresAt: now + CHANNEL_TTL_MS });
			}
			const visible: DiscordChannelRef[] = [];
			for (const channel of channels) {
				const parent =
					THREAD_TYPES.has(channel.type) && channel.parent_id
						? await this.channelInfo(channel.parent_id)
						: undefined;
				// A thread cannot be evaluated without its parent: the parent holds
				// the overwrites when the thread has none of its own.
				if (THREAD_TYPES.has(channel.type) && channel.parent_id && !parent) continue;
				const isThreadMember =
					channel.type === 12 ? await this.threadMember(channel.id, userId) : false;
				const permissions = effectivePermissions({
					guildId: this.guildId,
					...(guild.ownerId ? { ownerId: guild.ownerId } : {}),
					userId,
					roles: guild.roles,
					memberRoleIds: member,
					channel,
					...(parent ? { parent } : {}),
					isThreadMember,
				});
				if (hasPermission(permissions, Permission.ViewChannel)) visible.push(channel);
			}
			return visible;
		} catch {
			return [];
		}
	}
}
