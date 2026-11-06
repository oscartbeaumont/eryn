/**
 * The Discord plugin: tells the agent where its conversation lives.
 *
 * Eryn's agent runs in a thread but has no way to observe that: it cannot list
 * channels, and its tools only reach the workspace. So this plugin reads the
 * {@link DiscordContext} the session object stored in the session's own
 * metadata and appends it to the system prompt, which is the only place a
 * request can be told about its surroundings.
 *
 * It is read from metadata rather than held in the plugin, because metadata is
 * per session and the plugin is per host: one host serves every thread in the
 * guild, so the context has to travel with the request. Nothing here knows
 * about the gateway or the session object — only the metadata key.
 */

import { Plugin } from "@opencode/plugin";

import { log } from "../../config";
import { describeError } from "../../errors";
import { appendToSystemPrompt } from "../hooks";
import { DISCORD_MARKER, describeDiscordContext, readDiscordContext } from "./context";

export function discordPlugin() {
	return Plugin.define({
		id: "eryn.discord",
		async setup(ctx) {
			// The hook carries no session metadata, so it is read from the session
			// itself. A failure to read it must not fail the request: a missing
			// context only costs the agent some awareness, while a thrown error
			// would fail the whole turn.
			await appendToSystemPrompt(ctx, DISCORD_MARKER, async (sessionID) => {
				const session = await ctx.session.get({ sessionID }).catch((error) => {
					log("discord-plugin", `could not read the session, so no Discord context was added: ${describeError(error)}`);
					return undefined;
				});
				const context = readDiscordContext(session?.metadata);
				return context ? describeDiscordContext(context) : undefined;
			});
		},
	});
}
