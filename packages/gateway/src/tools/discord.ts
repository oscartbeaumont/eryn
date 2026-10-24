/**
 * The Discord tools.
 *
 * They belong to the MCP endpoint rather than to the agent, so one set serves
 * both: the Discord bot is told the channel it was invoked in by the
 * `eryn.discord` plugin, and these take that id and read around it, while a
 * harness can use them against any server the bot is in.
 *
 * Everything acts as the bot, because that is the only identity with the
 * intents and permissions to read history. The tools are therefore as visible
 * as the bot is — they are not scoped to one Discord server — and they exist
 * only once the user has connected Discord on the MCP page.
 */

import { describeError, type DiscordGuildChannel, type DiscordMessageView, type DiscordRest } from "../discord/api";

/** One tool, described the way the MCP server registers it. */
export interface DiscordTool {
	name: string;
	title: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties: false;
	};
	/** Returns the text a harness sees. Throwing becomes a tool error. */
	run: (rest: DiscordRest, args: Record<string, unknown>) => Promise<string>;
}

const CHANNEL_TYPES: Record<number, string> = {
	0: "text",
	2: "voice",
	4: "category",
	5: "announcement",
	10: "announcement thread",
	11: "public thread",
	12: "private thread",
	13: "stage",
	15: "forum",
	16: "media",
};

/** How many characters of one message to include before cutting it short. */
const MESSAGE_LIMIT = 900;

const stringArg = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const numberArg = (value: unknown, fallback: number): number => {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};
const boolArg = (value: unknown): boolean => value === true || value === "true";

/** Discord's own id format, so a typo is caught before a request is made. */
function requireSnowflake(value: unknown, field: string): string {
	const id = stringArg(value);
	if (!id || !/^\d{5,32}$/.test(id)) throw new Error(`${field} must be a Discord id, got ${JSON.stringify(value ?? null)}`);
	return id;
}

function clip(text: string, limit = MESSAGE_LIMIT): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

function channelLine(channel: DiscordGuildChannel): string {
	const kind = CHANNEL_TYPES[channel.type] ?? `type ${channel.type}`;
	const name = channel.name ?? "(unnamed)";
	const parent = channel.parent_id ? ` parent=${channel.parent_id}` : "";
	const archived = channel.thread_metadata?.archived ? " archived" : "";
	return `${name} — id=${channel.id} (${kind}${archived}${parent})`;
}

function messageLine(message: DiscordMessageView): string {
	const author = message.author?.global_name || message.author?.username || message.author?.id || "unknown";
	const bot = message.author?.bot ? " (bot)" : "";
	const when = message.timestamp ?? "";
	const attachments = (message.attachments ?? [])
		.map((attachment) => attachment.filename ?? attachment.url ?? "attachment")
		.filter(Boolean);
	const reply = message.referenced_message?.id ? ` [replying to ${message.referenced_message.id}]` : "";
	const body = clip(message.content ?? "");
	return `${when} ${author}${bot} (${message.id})${reply}: ${body}${attachments.length ? ` [+${attachments.length} attachment(s): ${attachments.join(", ")}]` : ""}`;
}

/** A page of messages, or an explanation of why it is empty. */
function renderMessages(messages: DiscordMessageView[]): string {
	if (!messages.length) return "No messages.";
	// Discord returns newest first; reading oldest first is what a person expects.
	return [...messages].reverse().map(messageLine).join("\n");
}

export const DISCORD_TOOLS: readonly DiscordTool[] = [
	{
		name: "discord_guilds",
		title: "List Discord servers",
		description:
			"List the Discord servers this bot is in, with their ids. Use a server id with the other discord_ tools.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async (rest) => {
			const guilds = await rest.guilds();
			if (!guilds.length) return "The bot is in no servers.";
			return guilds.map((guild) => `${guild.name} — id=${guild.id}`).join("\n");
		},
	},
	{
		name: "discord_channels",
		title: "List channels in a Discord server",
		description:
			"List a Discord server's channels and categories, with their ids and types. Threads are not included; use discord_threads for those.",
		inputSchema: {
			type: "object",
			properties: { guild_id: { type: "string", description: "The server id, from discord_guilds or your context." } },
			required: ["guild_id"],
			additionalProperties: false,
		},
		run: async (rest, args) => {
			const guildId = requireSnowflake(args.guild_id, "guild_id");
			const channels = (await rest.guildChannels(guildId)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
			if (!channels.length) return "No channels visible to the bot.";
			return channels.map(channelLine).join("\n");
		},
	},
	{
		name: "discord_channel",
		title: "Read one Discord channel",
		description:
			"Read one channel or thread: its name, type, topic, and the channel it belongs to. Use this to identify the channel id you were given.",
		inputSchema: {
			type: "object",
			properties: { channel_id: { type: "string", description: "The channel or thread id." } },
			required: ["channel_id"],
			additionalProperties: false,
		},
		run: async (rest, args) => {
			const channelId = requireSnowflake(args.channel_id, "channel_id");
			const channel = await rest.channel(channelId);
			if (!channel) return `No channel or thread with id ${channelId} is visible to the bot.`;
			const lines = [channelLine({ ...channel })];
			if (channel.topic) lines.push(`topic: ${clip(channel.topic, 400)}`);
			return lines.join("\n");
		},
	},
	{
		name: "discord_messages",
		title: "Read Discord messages",
		description:
			"Read a channel's or thread's messages, oldest first. Page further back by passing the id of the oldest message you have as `before`; pass `after` to read forwards from an id.",
		inputSchema: {
			type: "object",
			properties: {
				channel_id: { type: "string", description: "The channel or thread id." },
				limit: { type: "integer", description: "How many messages, 1-100. Defaults to 50." },
				before: { type: "string", description: "Return messages older than this message id." },
				after: { type: "string", description: "Return messages newer than this message id." },
			},
			required: ["channel_id"],
			additionalProperties: false,
		},
		run: async (rest, args) => {
			const channelId = requireSnowflake(args.channel_id, "channel_id");
			const messages = await rest.channelMessages(channelId, {
				limit: numberArg(args.limit, 50),
				...(stringArg(args.before) ? { before: stringArg(args.before)! } : {}),
				...(stringArg(args.after) ? { after: stringArg(args.after)! } : {}),
			});
			return renderMessages(messages);
		},
	},
	{
		name: "discord_search",
		title: "Search Discord messages",
		description:
			"Search a Discord server's message history by text, optionally narrowed to one channel or author. Use this when you need to find something older than the recent history of a channel. Discord builds this server's index lazily, so a search can come back before it is ready.",
		inputSchema: {
			type: "object",
			properties: {
				guild_id: { type: "string", description: "The server to search." },
				content: { type: "string", description: "Text the message must contain." },
				channel_id: { type: "string", description: "Only search this channel or thread." },
				author_id: { type: "string", description: "Only messages from this user id." },
				limit: { type: "integer", description: "How many results, 1-25. Defaults to 25." },
				offset: { type: "integer", description: "Skip this many results, for paging." },
			},
			required: ["guild_id"],
			additionalProperties: false,
		},
		run: async (rest, args) => {
			const guildId = requireSnowflake(args.guild_id, "guild_id");
			const found = await rest.searchMessages(guildId, {
				...(stringArg(args.content) ? { content: stringArg(args.content)! } : {}),
				...(stringArg(args.channel_id) ? { channelId: stringArg(args.channel_id)! } : {}),
				...(stringArg(args.author_id) ? { authorId: stringArg(args.author_id)! } : {}),
				limit: numberArg(args.limit, 25),
				offset: numberArg(args.offset, 0),
			});
			// An unbuilt index reads as zero results, which would send the model away
			// believing there is nothing to find.
			if (found.indexing) {
				return "Discord is still building this server's search index, so nothing can be searched yet. Read the channel with discord_messages for recent history, or try again later.";
			}
			if (!found.messages.length) return `No messages matched (of ${found.total} the index counted).`;
			const header = `${found.messages.length} of ${found.total} matches:`;
			return [header, ...found.messages.map(messageLine)].join("\n");
		},
	},
	{
		name: "discord_threads",
		title: "List Discord threads",
		description:
			"List a server's active threads, or one channel's archived threads. Threads are where a conversation has moved; use discord_messages to read one.",
		inputSchema: {
			type: "object",
			properties: {
				guild_id: { type: "string", description: "The server whose active threads to list." },
				channel_id: { type: "string", description: "A channel whose archived threads to list instead." },
				archived: { type: "boolean", description: "Include archived threads (requires channel_id)." },
				limit: { type: "integer", description: "How many archived threads, 1-100. Defaults to 50." },
				before: { type: "string", description: "For archived threads, a timestamp to page from." },
			},
			additionalProperties: false,
		},
		run: async (rest, args) => {
			const channelId = stringArg(args.channel_id);
			if (channelId && boolArg(args.archived)) {
				const threads = await rest.archivedThreads(requireSnowflake(channelId, "channel_id"), {
					limit: numberArg(args.limit, 50),
					...(stringArg(args.before) ? { before: stringArg(args.before)! } : {}),
				});
				return threads.length ? threads.map(channelLine).join("\n") : "No archived threads in that channel.";
			}
			const guildId = stringArg(args.guild_id);
			if (!guildId) return "Give either guild_id for active threads, or channel_id and archived for archived ones.";
			const threads = await rest.activeThreads(requireSnowflake(guildId, "guild_id"));
			return threads.length ? threads.map(channelLine).join("\n") : "No active threads in that server.";
		},
	},
	{
		name: "discord_post",
		title: "Post a Discord message",
		description:
			"Post a message to a channel or thread. Use the channel id from your context to answer where you were invoked, or a thread id to continue that conversation.",
		inputSchema: {
			type: "object",
			properties: {
				channel_id: { type: "string", description: "The channel or thread to post in." },
				content: { type: "string", description: "The message body, up to 2000 characters." },
				reply_to: { type: "string", description: "A message id to reply to." },
			},
			required: ["channel_id", "content"],
			additionalProperties: false,
		},
		run: async (rest, args) => {
			const channelId = requireSnowflake(args.channel_id, "channel_id");
			const content = stringArg(args.content);
			if (!content) throw new Error("content is required");
			if (content.length > 2_000) throw new Error(`content is ${content.length} characters; Discord allows 2000`);
			const replyTo = stringArg(args.reply_to);
			const sent = await rest.sendMessage(channelId, content, replyTo ? { replyTo } : {});
			// Mentions are never parsed, so a posted message cannot ping a role or
			// everyone by accident.
			return `Posted ${sent.id} in ${channelId}.`;
		},
	},
	{
		name: "discord_create_thread",
		title: "Create a Discord thread",
		description:
			"Start a thread, either in a channel or attached to an existing message. A thread is how a long reply stays out of the channel it came from.",
		inputSchema: {
			type: "object",
			properties: {
				channel_id: { type: "string", description: "The channel to start the thread in." },
				name: { type: "string", description: "The thread's name, up to 100 characters." },
				message_id: { type: "string", description: "Attach the thread to this message instead." },
				auto_archive_duration: {
					type: "integer",
					description: "Minutes of inactivity before it archives: 60, 1440, 4320, or 10080. Defaults to 1440.",
				},
			},
			required: ["channel_id", "name"],
			additionalProperties: false,
		},
		run: async (rest, args) => {
			const channelId = requireSnowflake(args.channel_id, "channel_id");
			const name = stringArg(args.name);
			if (!name) throw new Error("name is required");
			const messageId = stringArg(args.message_id);
			const created = messageId
				? await rest.createThread(channelId, requireSnowflake(messageId, "message_id"), name.slice(0, 100))
				: await rest.startThread(channelId, name.slice(0, 100), {
						...(args.auto_archive_duration !== undefined
							? { autoArchiveDuration: numberArg(args.auto_archive_duration, 1_440) }
							: {}),
					});
			return `Created thread ${created.id} (${name}) in ${channelId}.`;
		},
	},
];

/** The tool with this name, for a caller that has to route a call. */
export function discordTool(name: string): DiscordTool | undefined {
	return DISCORD_TOOLS.find((tool) => tool.name === name);
}

/** Render a tool failure the way a harness expects to read one. */
export function discordFailure(error: unknown): string {
	return `Discord refused that: ${describeError(error)}`;
}
