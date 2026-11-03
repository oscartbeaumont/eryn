/**
 * Discord tools for the agent.
 *
 * The agent runs inside a guild, so every tool is scoped to that guild: a
 * channel id from another server is rejected before a request is made. The
 * tools use the bot's own REST client, so Discord permissions still apply.
 *
 * The plugin is deliberately small and explicit. It exposes the operations the
 * agent needs to participate in a conversation: look around, read, reply,
 * manage threads, and react. It does not expose administrative server settings.
 */

import { Plugin } from "@opencode/plugin";

import { describeError } from "../errors";
import { THREAD_TYPES, type DiscordChannelRef, type DiscordRest } from "../discord/api";

const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({
	type: "object",
	properties,
	required,
	additionalProperties: false,
});

const text = (value: unknown) => ({ content: JSON.stringify(value, null, 2) });
const failed = (error: unknown) => ({ content: `Error: ${describeError(error)}` });

function channelSummary(channel: DiscordChannelRef) {
	return {
		id: channel.id,
		name: channel.name ?? null,
		type: channel.type,
		parentId: channel.parent_id ?? null,
		archived: channel.thread_metadata?.archived ?? false,
		thread: THREAD_TYPES.has(channel.type),
	};
}

export function discordToolsPlugin(rest: DiscordRest, guildId: string) {
	/** A channel or thread the bot can use, restricted to this guild. */
	const channel = async (channelId: string): Promise<DiscordChannelRef> => {
		const found = await rest.channel(channelId);
		if (!found) throw new Error(`Channel ${channelId} was not found.`);
		if (found.guild_id !== undefined && found.guild_id !== guildId) {
			throw new Error(`Channel ${channelId} is not in this server.`);
		}
		return found;
	};

	const thread = async (threadId: string): Promise<DiscordChannelRef> => {
		const found = await channel(threadId);
		if (!THREAD_TYPES.has(found.type)) throw new Error(`${threadId} is not a thread.`);
		return found;
	};

	return Plugin.define({
		id: "eryn.discord-tools",
		async setup(ctx) {
			await ctx.tool.transform((tools) => {
				tools.add({
					name: "discord_list_channels",
					description:
						"List the channels and active threads in this Discord server, with their ids, names, parent ids, and whether they are threads.",
					input: objectSchema({}),
					execute: async () => {
						try {
							const [channels, threads] = await Promise.all([
								rest.guildChannels(guildId),
								rest.activeThreads(guildId),
							]);
							return text([
								...channels.map(channelSummary),
								...threads.map(channelSummary),
							]);
						} catch (error) {
							return failed(error);
						}
					},
				});

				tools.add({
					name: "discord_list_threads",
					description: "List the active threads in this Discord server.",
					input: objectSchema({}),
					execute: async () => {
						try {
							return text((await rest.activeThreads(guildId)).map(channelSummary));
						} catch (error) {
							return failed(error);
						}
					},
				});

				tools.add({
					name: "discord_read_messages",
					description:
						"Read recent messages from a channel or thread in this server. Messages are returned newest first with author and attachment details.",
					input: objectSchema(
						{
							channelId: { type: "string", description: "Channel or thread id" },
							limit: { type: "number", description: "Number of messages, 1–50 (default 20)" },
							before: { type: "string", description: "Only messages before this message id" },
						},
						["channelId"],
					),
					execute: async (rawInput) => {
						try {
							const input = rawInput as { channelId: string; limit?: number; before?: string };
							await channel(input.channelId);
							const messages = await rest.channelMessages(input.channelId, {
								limit: Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), 50),
								...(input.before ? { before: input.before } : {}),
							});
							return text(messages);
						} catch (error) {
							return failed(error);
						}
					},
				});

				tools.add({
					name: "discord_send_message",
					description:
						"Send a message to a channel or thread in this server. Mentions are suppressed; replyTo attaches the message as a reply.",
					input: objectSchema(
						{
							channelId: { type: "string", description: "Channel or thread id" },
							content: { type: "string", description: "Message text, up to 2000 characters" },
							replyTo: { type: "string", description: "Optional message id to reply to" },
						},
						["channelId", "content"],
					),
					execute: async (rawInput) => {
						try {
							const input = rawInput as { channelId: string; content: string; replyTo?: string };
							await channel(input.channelId);
							if (!input.content.trim()) throw new Error("Message content is required.");
							if (input.content.length > 2_000) throw new Error("Discord messages are limited to 2000 characters.");
							return text(
								await rest.sendMessage(input.channelId, input.content, {
									...(input.replyTo ? { replyTo: input.replyTo } : {}),
								}),
							);
						} catch (error) {
							return failed(error);
						}
					},
				});

				tools.add({
					name: "discord_create_thread",
					description:
						"Create a public thread in a text channel, optionally attached to a message. Returns the new thread id.",
					input: objectSchema(
						{
							channelId: { type: "string", description: "Text channel id" },
							name: { type: "string", description: "Thread name, up to 100 characters" },
							messageId: { type: "string", description: "Optional message to start the thread from" },
						},
						["channelId", "name"],
					),
					execute: async (rawInput) => {
						try {
							const input = rawInput as { channelId: string; name: string; messageId?: string };
							await channel(input.channelId);
							const name = input.name.trim().slice(0, 100);
							if (!name) throw new Error("A thread name is required.");
							return text(
								input.messageId
									? await rest.createThread(input.channelId, input.messageId, name)
									: await rest.startThread(input.channelId, name),
							);
						} catch (error) {
							return failed(error);
						}
					},
				});

				tools.add({
					name: "discord_archive_thread",
					description: "Archive or close a thread. Set locked to also prevent new messages.",
					input: objectSchema(
						{
							threadId: { type: "string", description: "Thread id" },
							locked: { type: "boolean", description: "Also lock the thread (default false)" },
						},
						["threadId"],
					),
					execute: async (rawInput) => {
						try {
							const input = rawInput as { threadId: string; locked?: boolean };
							await thread(input.threadId);
							await rest.setThreadArchived(input.threadId, true, input.locked ?? false);
							return text({ ok: true, threadId: input.threadId });
						} catch (error) {
							return failed(error);
						}
					},
				});

				tools.add({
					name: "discord_join_thread",
					description: "Follow a thread so it stays in the bot's thread list.",
					input: objectSchema({ threadId: { type: "string", description: "Thread id" } }, ["threadId"]),
					execute: async (rawInput) => {
						try {
							const input = rawInput as { threadId: string };
							await thread(input.threadId);
							await rest.joinThread(input.threadId);
							return text({ ok: true, threadId: input.threadId });
						} catch (error) {
							return failed(error);
						}
					},
				});

				tools.add({
					name: "discord_leave_thread",
					description: "Stop following a thread.",
					input: objectSchema({ threadId: { type: "string", description: "Thread id" } }, ["threadId"]),
					execute: async (rawInput) => {
						try {
							const input = rawInput as { threadId: string };
							await thread(input.threadId);
							await rest.leaveThread(input.threadId);
							return text({ ok: true, threadId: input.threadId });
						} catch (error) {
							return failed(error);
						}
					},
				});

				tools.add({
					name: "discord_react",
					description: "Add or remove an emoji reaction on a message.",
					input: objectSchema(
						{
							channelId: { type: "string", description: "Channel or thread id" },
							messageId: { type: "string", description: "Message id" },
							emoji: { type: "string", description: "Unicode emoji or custom emoji as name:id" },
							remove: { type: "boolean", description: "Remove the reaction instead of adding it" },
						},
						["channelId", "messageId", "emoji"],
					),
					execute: async (rawInput) => {
						try {
							const input = rawInput as {
								channelId: string;
								messageId: string;
								emoji: string;
								remove?: boolean;
							};
							await channel(input.channelId);
							if (input.remove) await rest.removeReaction(input.channelId, input.messageId, input.emoji);
							else await rest.addReaction(input.channelId, input.messageId, input.emoji);
							return text({ ok: true });
						} catch (error) {
							return failed(error);
						}
					},
				});

				tools.add({
					name: "discord_edit_message",
					description: "Edit a message the bot is allowed to edit.",
					input: objectSchema(
						{
							channelId: { type: "string", description: "Channel or thread id" },
							messageId: { type: "string", description: "Message id" },
							content: { type: "string", description: "New message text, up to 2000 characters" },
						},
						["channelId", "messageId", "content"],
					),
					execute: async (rawInput) => {
						try {
							const input = rawInput as { channelId: string; messageId: string; content: string };
							await channel(input.channelId);
							if (input.content.length > 2_000) throw new Error("Discord messages are limited to 2000 characters.");
							await rest.editMessage(input.channelId, input.messageId, input.content);
							return text({ ok: true });
						} catch (error) {
							return failed(error);
						}
					},
				});

				tools.add({
					name: "discord_delete_message",
					description: "Delete a message the bot is allowed to delete.",
					input: objectSchema(
						{
							channelId: { type: "string", description: "Channel or thread id" },
							messageId: { type: "string", description: "Message id" },
						},
						["channelId", "messageId"],
					),
					execute: async (rawInput) => {
						try {
							const input = rawInput as { channelId: string; messageId: string };
							await channel(input.channelId);
							await rest.deleteMessage(input.channelId, input.messageId);
							return text({ ok: true });
						} catch (error) {
							return failed(error);
						}
					},
				});

				tools.add({
					name: "discord_pin_message",
					description: "Pin or unpin a message in a channel or thread.",
					input: objectSchema(
						{
							channelId: { type: "string", description: "Channel or thread id" },
							messageId: { type: "string", description: "Message id" },
							remove: { type: "boolean", description: "Unpin instead of pinning" },
						},
						["channelId", "messageId"],
					),
					execute: async (rawInput) => {
						try {
							const input = rawInput as { channelId: string; messageId: string; remove?: boolean };
							await channel(input.channelId);
							if (input.remove) await rest.unpinMessage(input.channelId, input.messageId);
							else await rest.pinMessage(input.channelId, input.messageId);
							return text({ ok: true });
						} catch (error) {
							return failed(error);
						}
					},
				});
			});
		},
	});
}
