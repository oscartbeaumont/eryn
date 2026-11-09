/**
 * The Discord lookups a gateway object caches.
 *
 * The gateway is long-lived and every message needs its channel (and, in a
 * thread, the thread's parent), its guild's name, and the bot's managed role.
 * Each is fetched at most once; a failed lookup is not a missing channel, so it
 * is not remembered and the next message tries again.
 *
 * Gateway update events replace the cached entry, which is what makes a rename
 * visible to the next message instead of only after a restart.
 */

import type { DiscordChannelRef, DiscordRest } from "../discord/api";
import type { DiscordChannel, DiscordMessage } from "../discord/socket";
import type { DiscordContext } from "../session/models";

/** A long-lived guild object should not remember every channel forever. */
const MAX_CACHED_CHANNELS = 500;

export class DiscordLookups {
	private readonly channels = new Map<string, DiscordChannelRef>();
	private readonly guildNames = new Map<string, string>();
	private readonly botRoles = new Map<string, string>();

	constructor(private readonly rest: DiscordRest) {}

	/** A channel or thread, cached. */
	async channel(channelId: string): Promise<DiscordChannelRef | undefined> {
		const cached = this.channels.get(channelId);
		if (cached) return cached;
		const channel = await this.rest.channel(channelId).catch(() => undefined);
		if (!channel) return undefined;
		if (this.channels.size > MAX_CACHED_CHANNELS) this.channels.clear();
		this.channels.set(channelId, channel);
		return channel;
	}

	/**
	 * A channel already read during this object's lifetime, without a request.
	 *
	 * Used to notice what a name was before an update replaces it; `undefined`
	 * means the old name was never needed, not that the channel is missing.
	 */
	cached(channelId: string): DiscordChannelRef | undefined {
		return this.channels.get(channelId);
	}

	/**
	 * Use a gateway channel payload as the fresh cache entry.
	 *
	 * The payload carries every field a context needs, and a rename arrives this
	 * way before the next message, so remembering it is what stops a rename from
	 * being invisible until this object restarts.
	 */
	remember(channel: DiscordChannel): DiscordChannelRef | undefined {
		if (typeof channel.type !== "number") return undefined;
		const ref: DiscordChannelRef = {
			id: channel.id,
			type: channel.type,
			...(channel.guild_id ? { guild_id: channel.guild_id } : {}),
			...(channel.parent_id ? { parent_id: channel.parent_id } : {}),
			...(channel.name ? { name: channel.name } : {}),
		};
		if (this.channels.size > MAX_CACHED_CHANNELS) this.channels.clear();
		this.channels.set(ref.id, ref);
		return ref;
	}

	/** A guild's name, from one cached listing. A failed listing is not cached. */
	async guildName(guildId: string): Promise<string | undefined> {
		const cached = this.guildNames.get(guildId);
		if (cached) return cached;
		const guilds = await this.rest.guilds().catch(() => undefined);
		if (!guilds) return undefined;
		for (const guild of guilds) this.guildNames.set(guild.id, guild.name);
		return this.guildNames.get(guildId);
	}

	/** Replace a cached guild name from a gateway payload. */
	rememberGuild(guildId: string, name: string): void {
		this.guildNames.set(guildId, name);
	}

	/**
	 * The bot's managed role id for the guild, but only when the message might
	 * reference it, so ordinary messages never pay for the lookup.
	 */
	async botRoleMention(message: DiscordMessage, botUserId: string): Promise<string | undefined> {
		const guildId = message.guild_id;
		if (guildId === undefined) return undefined;
		const roles = message.mention_roles ?? [];
		if (!roles.length && !/<@&\d+>/.test(message.content ?? "")) return undefined;
		const cached = this.botRoles.get(guildId);
		if (cached) return cached;
		const guildRoles = await this.rest.guildRoles(guildId).catch(() => undefined);
		const role = guildRoles?.find((candidate) => candidate.tags?.bot_id === botUserId);
		if (!role) return undefined;
		this.botRoles.set(guildId, role.id);
		return role.id;
	}

	/**
	 * Describe where the agent was invoked, for the session to store and the
	 * `eryn.discord` plugin to put in front of the model.
	 *
	 * `conversation` is where replies go. It is usually a thread, but a
	 * subscribed channel is its own conversation, so `kind` says which.
	 */
	async context(
		guildId: string,
		invocation: DiscordChannelRef | undefined,
		conversation: { id: string; name?: string },
		kind: "thread" | "channel" = "thread",
	): Promise<DiscordContext> {
		const channel = invocation ?? conversation;
		const guildName = await this.guildName(guildId);
		return {
			guild: guildName ? { id: guildId, name: guildName } : { id: guildId },
			channel: channel.name ? { id: channel.id, name: channel.name } : { id: channel.id },
			thread: conversation.name ? { id: conversation.id, name: conversation.name } : { id: conversation.id },
			kind,
		};
	}
}
