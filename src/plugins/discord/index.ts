/**
 * The Discord plugin: tells the agent where its conversation lives, and how to
 * act in it.
 *
 * Eryn's agent runs in a Discord conversation but has no way to observe that:
 * it cannot list channels through its normal tools. So this plugin reads the
 * {@link DiscordContext} the session object stored in the session's own
 * metadata and appends it to the system prompt, which is the only place a
 * request can be told about its surroundings. It then registers the
 * `discord_*` tools, which are how the agent acts on that context.
 *
 * The context is read from metadata rather than held in the plugin, because
 * metadata is per session and the plugin is per host: one host serves every
 * conversation in the guild, so the context has to travel with the request.
 * Nothing here knows about the gateway or the session object — only the
 * metadata key.
 */

import { Plugin } from "@opencode/plugin";

import { log } from "../../config";
import type { DiscordRest } from "../../discord/api";
import { DiscordAuthority } from "../../discord/authority";
import { describeError } from "../../errors";
import { appendToSystemPrompt } from "../hooks";
import type { FileStore } from "../workspace/store";
import { DISCORD_MARKER, describeDiscordContext, readDiscordContext } from "./context";
import { registerScheduleScope } from "./schedule";
import { discordTools, type SetMessageSubscription } from "./tools";

export function discordPlugin(
	rest: DiscordRest,
	guildId: string,
	store: FileStore,
	setSubscription: (kind: "thread" | "channel", id: string, subscribed: boolean) => Promise<void>,
	setMessageSubscription: SetMessageSubscription,
	onMessageSent?: (threadId: string) => void,
	onScheduleCreated?: (threadId: string) => void,
) {
	// One per host/guild. A cache shared across guilds would let a role id from
	// one server be read as a role in another.
	const authority = new DiscordAuthority(rest, guildId);
	const tools = discordTools(
		rest,
		guildId,
		store,
		setSubscription,
		setMessageSubscription,
		authority,
		onMessageSent,
	);

	return Plugin.define({
		id: "eryn.discord",
		async setup(ctx) {
			await Promise.all([
				tools.setup(ctx),
				registerScheduleScope(ctx, rest, guildId, authority, onScheduleCreated),
				// The hook carries no session metadata, so it is read from the session
				// itself. A failure to read it must not fail the request: a missing
				// context only costs the agent some awareness, while a thrown error
				// would fail the whole turn.
				appendToSystemPrompt(ctx, DISCORD_MARKER, async (sessionID) => {
					const session = await ctx.session.get({ sessionID }).catch((error) => {
						log("discord-plugin", `could not read the session, so no Discord context was added: ${describeError(error)}`);
						return undefined;
					});
					const context = readDiscordContext(session?.metadata);
					return context ? describeDiscordContext(context) : undefined;
				}),
			]);
		},
	});
}
