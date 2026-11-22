/**
 * The deployment-wide Discord gateway.
 *
 * One object holds the sharded socket and nothing else. It maps a guild to the
 * Eryn server that bound it and forwards normalised messages to that server's
 * Hub. It never builds an agent, so a socket restart cannot interrupt a turn.
 */

import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";

import { KEYS, configuredOrigin, log, optional } from "../config.ts";
import { newId } from "../core/ids.ts";
import { body, failure, json } from "../core/http.ts";
import { stringField, toJsonObject } from "../json.ts";
import { InboundMessageSchema } from "../core/schema.ts";
import { ORIGIN_HEADER, withDeploy, withOrigin } from "../deploy.ts";
import { describeError } from "../errors.ts";
import { discordRest } from "../discord/api.ts";
import { DiscordSocket } from "../discord/socket.ts";
import type {
	DiscordChannel,
	DiscordGuildCreate,
	DiscordInteraction,
	DiscordMessage,
	DiscordSocketHandlers,
} from "../discord/socket.ts";

const WAKE_PATH = "/wake";
const INTERACTION_PATH = "/interaction";
const REGISTER_PATH = "/register";
const UNREGISTER_PATH = "/unregister";

const KEEPALIVE_MS = 120_000;

const RegisterSchema = Schema.Struct({ guildId: Schema.String, serverId: Schema.String });

const UnregisterSchema = Schema.Struct({ guildId: Schema.String });

/** The commands this build registers. */
const COMMANDS = [
	{
		type: 1,
		name: "eryn",
		description: "Eryn",
		options: [
			{ type: 1, name: "setup", description: "Open this server's settings" },
			{ type: 1, name: "stop", description: "Stop the current run" },
			{ type: 1, name: "compact", description: "Compact this conversation" },
			{
				type: 1,
				name: "command",
				description: "Run an OpenCode command",
				options: [
					{ type: 3, name: "name", description: "Command name", required: true },
					{ type: 3, name: "arguments", description: "Arguments", required: false },
				],
			},
			{ type: 1, name: "commands", description: "List OpenCode commands" },
			{ type: 1, name: "policy", description: "Open access settings" },
			{ type: 1, name: "reset", description: "Open file reset settings" },
			{ type: 1, name: "help", description: "How to use Eryn" },
		],
	},
] as const;

function subOptions(interaction: DiscordInteraction) {
	return interaction.data?.options?.[0]?.options ?? [];
}

function optionValue(
	options: readonly { readonly name?: string; readonly value?: unknown }[],
	name: string,
): string | undefined {
	const value = options.find((option) => option.name === name)?.value;

	return typeof value === "string" ? value : undefined;
}

function isBot(message: DiscordMessage): boolean {
	return message.author?.bot === true || message.webhook_id !== undefined;
}

function attachmentsOf(message: DiscordMessage) {
	return (message.attachments ?? []).flatMap((file) =>
		file.url
			? [
					{
						url: file.url,
						name: file.filename,
						contentType: file.content_type,
						size: file.size,
					},
				]
			: [],
	);
}

export class Gateway extends DurableObject<Env> {
	private readonly token: string;
	private readonly rest: ReturnType<typeof discordRest>;
	private socket: DiscordSocket | undefined;
	private botUserId: string | undefined;
	private origin: string | undefined;
	private commandsRegistered = false;
	private active = 0;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.token = optional(env, "DISCORD_BOT_TOKEN") ?? "";
		this.rest = discordRest(this.token);
		void state.blockConcurrencyWhile(() => this.keepAlive());
	}

	private readonly handlers: DiscordSocketHandlers = {
		onMessage: (message) => this.track(() => this.onMessage(message)),
		onInteraction: (interaction) => this.track(() => this.onInteraction(interaction)),
		onGuild: (guild) => this.track(() => this.onGuild(guild)),
		onGuildUpdate: (guild) => this.track(() => this.onGuild(guild)),
		onThreadCreate: (thread) => this.track(() => this.onChannel(thread)),
		onChannelUpdate: (channel) => this.track(() => this.onChannel(channel)),
		onChannelDelete: () => undefined,
	};

	private track(run: () => Promise<void>): void {
		this.active += 1;
		void run()
			.catch((error: unknown) => log("gateway", describeError(error)))
			.finally(() => {
				this.active -= 1;
			});
	}

	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		const origin = request.headers.get(ORIGIN_HEADER);

		if (origin) this.origin = origin.replace(/\/$/, "");

		try {
			if (path === WAKE_PATH) return await this.wake();
			if (path === INTERACTION_PATH && request.method === "POST") return await this.interactionRequest(request);
			if (path === REGISTER_PATH && request.method === "POST") return await this.register(request);
			if (path === UNREGISTER_PATH && request.method === "POST") return await this.unregister(request);
			return failure("Not found.", 404);
		} catch (error) {
			log("gateway", "route failed: " + describeError(error));

			return failure("The gateway could not answer.", 500);
		}
	}

	async alarm(): Promise<void> {
		await this.keepAlive();
	}

	private async wake(): Promise<Response> {
		await this.keepAlive();

		return json({ ok: true, connected: this.socket?.open ?? false, guilds: await this.guildCount() });
	}

	private async guildCount(): Promise<number> {
		const index = await this.ctx.storage.list<boolean>({ prefix: KEYS.guildIndex });

		return index.size;
	}

	private async register(request: Request): Promise<Response> {
		const input = await body(request, RegisterSchema);

		if (input instanceof Response) return input;
		const previous = await this.ctx.storage.get<string>(KEYS.guildIndex + input.guildId);

		if (previous && previous !== input.serverId) {
			return failure("That Discord server is already bound to another Eryn server.", 409);
		}

		await this.ctx.storage.put(KEYS.guildIndex + input.guildId, input.serverId);
		await this.ensureCommands();

		return json({ ok: true });
	}

	private async unregister(request: Request): Promise<Response> {
		const input = await body(request, UnregisterSchema);

		if (input instanceof Response) return input;
		await this.ctx.storage.delete(KEYS.guildIndex + input.guildId);

		return json({ ok: true });
	}

	private async keepAlive(): Promise<void> {
		if (!this.token) return;

		if (!this.socket) {
			try {
				const me = await this.rest.me();

				this.botUserId = me.id;
				const shards = await this.rest.gatewayShards().catch(() => 1);

				this.socket = new DiscordSocket(this.token, (message) => log("gateway", message), this.handlers, shards);
				this.socket.ensure();
				log("gateway", "signed in as " + (me.username ?? me.id));
			} catch (error) {
				log("gateway", "could not start: " + describeError(error));
			}
		} else {
			this.socket.ensure();
		}

		await this.ensureCommands();
		await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS);
	}

	private async ensureCommands(): Promise<void> {
		if (this.commandsRegistered || !this.botUserId) return;

		try {
			const registered = (await this.rest.listCommands(this.botUserId)) ?? [];
			const current = JSON.stringify(
				registered.map((command) => ({
					name: command.name,
					description: command.description,
					options: command.options,
				})),
			);
			const desired = JSON.stringify(COMMANDS);

			if (current !== desired) {
				await this.rest.overwriteCommands(this.botUserId, COMMANDS);
				log("gateway", "registered the /eryn command");
			}

			this.commandsRegistered = true;
		} catch (error) {
			log("gateway", "could not register commands: " + describeError(error));
		}
	}

	// --- Inbound ---------------------------------------------------------------

	private async onMessage(message: DiscordMessage): Promise<void> {
		if (isBot(message) || !message.guild_id || !this.botUserId) return;

		const serverId = await this.ctx.storage.get<string>(KEYS.guildIndex + message.guild_id);

		if (!serverId) return;
		const mentioned = (message.mentions ?? []).some((user) => user.id === this.botUserId);
		const text = message.content ?? "";

		if (!mentioned && !text.trim() && (message.attachments?.length ?? 0) === 0) return;
		const channelName = await this.channelName(message.guild_id, message.channel_id);
		const outbound = InboundMessageSchema.make({
			id: message.id,
			provider: "discord",
			channel: message.channel_id,
			author: {
				id: message.author?.id ?? "unknown",
				name: message.member?.nick ?? message.author?.global_name ?? message.author?.username ?? "unknown",
				handle: message.author?.username,
				bot: message.author?.bot === true,
				roles: await this.rolesFor(message.guild_id, message.author?.id ?? ""),
			},
			text: mentioned ? text.replaceAll(new RegExp("<@!?" + this.botUserId + ">", "g"), "").trim() : text,
			attachments: attachmentsOf(message),
			mentions: (message.mentions ?? []).map((user) => ({
				id: user.id,
				name: user.global_name ?? user.username ?? user.id,
				handle: user.username,
				bot: user.bot === true,
			})),
			replyTo: message.message_reference?.message_id,
			createdAt: Date.now(),
			addressed: mentioned,
			channelName,
		});

		const consumed = await this.toServer(serverId, "/consume", {
			channel: message.channel_id,
			text: outbound.text,
		});

		if (consumed?.consumed === true) return;
		const ingested = await this.toHub(serverId, "/ingest", { message: outbound });

		if (ingested?.ignored === true) return;
		await this.toServer(serverId, "/nudge", { message: outbound });
	}

	private channelNames = new Map<string, string>();

	private readonly roleCache = new Map<string, { expires: number; roles: string[] }>();

	/** The member's role ids, cached briefly so a conversation does not cost a REST call per message. */
	private async rolesFor(guildId: string, userId: string): Promise<string[]> {
		const key = guildId + ":" + userId;
		const cached = this.roleCache.get(key);

		if (cached && cached.expires > Date.now()) return cached.roles;

		try {
			const member = await this.rest.guildMember(guildId, userId);
			const roles = member?.roles ?? [];

			this.roleCache.set(key, { expires: Date.now() + 60_000, roles });

			return roles;
		} catch {
			return [];
		}
	}

	private async channelName(guildId: string, channelId: string): Promise<string | undefined> {
		const cached = this.channelNames.get(channelId);

		if (cached) return cached;

		try {
			const channel = await this.rest.channel(channelId);
			const name = channel?.name;

			if (name) this.channelNames.set(channelId, name);

			return name;
		} catch {
			return undefined;
		}
	}

	private async onGuild(guild: DiscordGuildCreate): Promise<void> {
		if (guild.unavailable) return;
		log("gateway", "in guild " + guild.id + (guild.name ? " (" + guild.name + ")" : ""));
	}

	private async onChannel(channel: DiscordChannel): Promise<void> {
		if (channel.name) this.channelNames.set(channel.id, channel.name);
	}

	private async interactionRequest(request: Request): Promise<Response> {
		const body = await request.json().catch(() => undefined);

		if (!body || typeof body !== "object") return failure("Bad interaction.");
		await this.onInteraction(body as DiscordInteraction);

		return json({ ok: true });
	}

	private async onInteraction(interaction: DiscordInteraction): Promise<void> {
		if (interaction.type === 3) return await this.onComponent(interaction);
		if (interaction.type !== 2) return;
		const guildId = interaction.guild_id;
		const name = interaction.data?.name;

		if (name !== "eryn" || !guildId) return;
		const sub = interaction.data?.options?.[0]?.name ?? "help";
		const serverId = await this.ctx.storage.get<string>(KEYS.guildIndex + guildId);
		const origin = configuredOrigin(this.env) ?? this.origin;

		if (sub === "setup") {
			const target = serverId
				? (origin ? origin + "/app/servers/" + serverId : "(Open the Eryn site to finish setup.)")
				: origin
					? origin + "/app"
					: "(Open the Eryn site to create a server.)";

			await this.rest.interactionReply(
				interaction.id,
				interaction.token,
				serverId
					? "Configure this server at " + target
					: "Connect this Discord server by creating an Eryn server at " + target,
			);

			return;
		}

		if (sub === "compact") {
			if (serverId) await this.toServer(serverId, "/compact", { channelId: interaction.channel_id });
			await this.rest.interactionReply(interaction.id, interaction.token, "Compacting this conversation.");

			return;
		}

		if (sub === "command") {
			const commandName = optionValue(subOptions(interaction), "name");
			const argumentsText = optionValue(subOptions(interaction), "arguments") ?? "";

			if (!serverId || !commandName) {
				await this.rest.interactionReply(interaction.id, interaction.token, "Name the command to run.");

				return;
			}

			const result = await this.toServer(serverId, "/command", {
				channelId: interaction.channel_id,
				command: commandName,
				text: argumentsText,
			});

			await this.rest.interactionReply(
				interaction.id,
				interaction.token,
				result?.ok === true ? "Running " + commandName + "." : "That command could not be started.",
			);

			return;
		}

		if (sub === "commands") {
			if (!serverId) {
				await this.rest.interactionReply(interaction.id, interaction.token, "Connect this server first.");

				return;
			}

			const result = await this.toServer(serverId, "/commands", { channelId: interaction.channel_id });
			const commands = Array.isArray(result?.commands) ? result.commands : [];
			const text = commands.length
				? commands
						.map((entry) => {
							const command = toJsonObject(entry as never);

							return "/eryn command " + (stringField(command, "name") ?? "?");
						})
						.join("\n")
				: "No commands in this project.";

			await this.rest.interactionReply(interaction.id, interaction.token, text);

			return;
		}

		if (sub === "policy" || sub === "reset") {
			const target = serverId && origin ? origin + "/app/servers/" + serverId : "(Open the Eryn site.)";

			await this.rest.interactionReply(
				interaction.id,
				interaction.token,
				"Configure " + sub + " at " + target,
			);

			return;
		}

		if (sub === "stop") {
			if (serverId) await this.toServer(serverId, "/interrupt", { channelId: interaction.channel_id });
			await this.rest.interactionReply(interaction.id, interaction.token, "Stopped.");

			return;
		}

		await this.rest.interactionReply(
			interaction.id,
			interaction.token,
			"Eryn is configured from the web app, not with slash commands. Use /eryn setup for a link.",
		);
	}

	/** A button on an approval message. */
	private async onComponent(interaction: DiscordInteraction): Promise<void> {
		const customId = interaction.data?.custom_id ?? "";
		const prefix = "approval:";

		if (!customId.startsWith(prefix)) return;
		const [, id, decision] = customId.slice(prefix.length).split(":");

		if (!id || (decision !== "once" && decision !== "always" && decision !== "block")) return;

		const guildId = interaction.guild_id;
		const serverId = guildId
			? await this.ctx.storage.get<string>(KEYS.guildIndex + guildId)
			: undefined;
		const userId = interaction.member?.user?.id ?? interaction.user?.id;

		if (!serverId) {
			await this.rest.interactionReply(interaction.id, interaction.token, "This approval is no longer connected.");

			return;
		}

		await this.toServer(serverId, "/approval", { approvalId: id, decision, userId });
		await this.rest.interactionDeferUpdate(interaction.id, interaction.token);
	}

	private async toHub(serverId: string, path: string, payload: unknown): Promise<Schema.JsonObject | undefined> {
		const stub = this.env.HUB.get(this.env.HUB.idFromName(serverId));
		const response = await stub.fetch("https://hub.internal" + path, withDeploy(this.env, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		}));

		if (!response.ok) log("gateway", "hub returned HTTP " + response.status);

		return toJsonObject((await response.json().catch(() => undefined)) as never);
	}

	private async toServer(serverId: string, path: string, payload: unknown): Promise<Schema.JsonObject | undefined> {
		const stub = this.env.SERVER.get(this.env.SERVER.idFromName(serverId));
		const init = withDeploy(this.env, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
		});
		const response = await stub.fetch(
			"https://server.internal" + path,
			this.origin ? withOrigin(init, this.origin) : init,
		);

		if (!response.ok) log("gateway", "server returned HTTP " + response.status);

		return toJsonObject((await response.json().catch(() => undefined)) as never);
	}
}

/** A random id for a channel this build has not seen. */
export { newId };
