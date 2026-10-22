/**
 * The Discord plugin: tells the agent where its conversation lives.
 *
 * Eryn's agent runs in a thread but has no way to observe that: it cannot list
 * channels, and its tools only reach the workspace and GitHub. So this plugin
 * reads the {@link DiscordContext} the session object stored in the session's
 * own metadata and appends it to the system prompt, which is the only place a
 * request can be told about its surroundings.
 *
 * It is read from metadata rather than held in the plugin, because metadata is
 * per session and the plugin is per host: one host serves every thread in the
 * guild, so the context has to travel with the request. Nothing here knows
 * about the gateway or the session object — only the metadata key.
 */

import { Plugin } from "@opencode/plugin";
import { describeError } from "../discord/api";
import { DISCORD_MARKER, describeDiscordContext, readDiscordContext } from "../discord/context";

/**
 * Hooks that build the messages the model will actually read.
 *
 * `context` is the agent loop, and `compaction` rewrites the conversation the
 * next request will contain — a summary that had lost the context would hand
 * the next request a thread belonging to nowhere. The auxiliary requests
 * (`title` and `generate`) never reply to a thread, so the channel would only
 * cost tokens there.
 */
const HOOKS = ["context", "compaction"] as const;

function log(message: string): void {
	console.log(`[eryn:discord-plugin] ${message}`);
}

export function discordPlugin() {
	return Plugin.define({
		id: "eryn.discord",
		async setup(ctx) {
			for (const name of HOOKS) {
				await ctx.session.hook(name, async (event) => {
					// The hook carries no session metadata, so it is read from the
					// session itself. A failure to read it must not fail the request:
					// a missing context only costs the agent some awareness, while a
					// thrown error would fail the whole turn.
					const session = await ctx.session.get({ sessionID: event.sessionID }).catch((error) => {
						log(`could not read the session, so no Discord context was added: ${describeError(error)}`);
						return undefined;
					});
					const context = readDiscordContext(session?.metadata);
					if (!context) return;
					// Idempotence: the same request can pass through a hook more than
					// once, and a repeated block reads as a second, contradictory thread.
					if (event.system.some((part) => part.text.includes(DISCORD_MARKER))) return;
					event.system.push({ type: "text", text: describeDiscordContext(context) });
				});
			}
		},
	});
}
