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
import { ORIGIN_HEADER, deployRestart, withDeploy, withOrigin } from "../deploy.ts";
import { describeError } from "../errors.ts";
import { discordRest } from "../discord/api.ts";
import { controlCall } from "../platform/clients.ts";
import { DiscordAuthority } from "../discord/authority.ts";
import { DiscordSocket } from "../discord/socket.ts";
import type { DiscordModal } from "../discord/components.ts";
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

interface FormSubmitBody {
	approvalId: string;
	values: Record<string, string>;
	userId?: string;
}

const AuthoritySchema = Schema.Struct({
	guildId: Schema.String,
	userId: Schema.String,
	channelId: Schema.String,
});

/** The commands this build registers. */
const COMMANDS = [
	{
		type: 1,
		name: "eryn",
		description: "Eryn",
		options: [
			{ type: 1, name: "setup", description: "Open this server's settings" },
			{
				type: 1,
				name: "claim",
				description: "Bind this Discord server to an Eryn server with a code",
				options: [{ type: 3, name: "code", description: "The code from the Eryn settings page", required: true }],
			},
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
	// A reply often asks about the screenshot in the message above, so the
	// referenced files count too.
	const files = [...(message.attachments ?? []), ...(message.referenced_message?.attachments ?? [])];
	const seen = new Set<string>();

	return files.flatMap((file) => {
		const url = file.url ?? file.proxy_url;

		if (!url || seen.has(url)) return [];
		seen.add(url);

		return [{ url, name: file.filename, contentType: file.content_type, size: file.size }];
	});
}

export class Gateway extends DurableObject<Env> {
	private readonly token: string;
	private readonly rest: ReturnType<typeof discordRest>;
	private socket: DiscordSocket | undefined;
	private botUserId: string | undefined;
	private origin: string | undefined;
	private commandsRegistered = false;
	private active = 0;
	private restartPending = false;

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
		if (await deployRestart(this.ctx.storage, request, this.env)) this.restartPending = true;

		try {
			if (path === WAKE_PATH) return await this.wake();
			if (path === INTERACTION_PATH && request.method === "POST") return await this.interactionRequest(request);
			if (path === REGISTER_PATH && request.method === "POST") return await this.register(request);
			if (path === "/authority" && request.method === "POST") return await this.authority(request);
			if (path === UNREGISTER_PATH && request.method === "POST") return await this.unregister(request);
			return failure("Not found.", 404);
		} catch (error) {
			log("gateway", "route failed: " + describeError(error));

			return failure("The gateway could not answer.", 500);
		}
	}

	async alarm(): Promise<void> {
		if (this.restartPending) {
			if (this.active > 0) {
				await this.ctx.storage.setAlarm(Date.now() + 5_000);

				return;
			}

			this.ctx.abort("deploy changed", { retryAlarm: true });

			return;
		}

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

	private async authority(request: Request): Promise<Response> {
		const input = await body(request, AuthoritySchema);

		if (input instanceof Response) return input;
		const channel = await this.rest.channel(input.channelId).catch(() => undefined);

		if (!channel) return json({ ok: false, error: "That channel does not exist." });

		let authority = this.authorities.get(input.guildId);

		if (!authority) {
			authority = new DiscordAuthority(this.rest, input.guildId);
			this.authorities.set(input.guildId, authority);
		}

		return json({ ok: true, capabilities: await authority.scopeCapabilities(input.userId, channel) });
	}

	/** Whether the person who ran a slash command holds a capability here. */
	private async mayManage(
		interaction: DiscordInteraction,
		guildId: string,
		capability: "manage" | "send",
	): Promise<boolean> {
		const actor = interaction.member?.user?.id ?? interaction.user?.id;
		const channelId = interaction.channel_id;

		if (!actor || !channelId) return false;
		let authority = this.authorities.get(guildId);

		if (!authority) {
			authority = new DiscordAuthority(this.rest, guildId);
			this.authorities.set(guildId, authority);
		}

		const channel = await this.rest.channel(channelId).catch(() => undefined);

		if (!channel) return false;
		const capabilities = await authority.scopeCapabilities(actor, channel);

		return capabilities[capability];
	}

	/**
	 * Bind this guild to an Eryn server.
	 *
	 * A deployment-wide bot token is in every guild, so which guild is not proof
	 * of anything. The code comes from the settings page and the claim is
	 * accepted only from someone with Manage Server here, which is the one place
	 * Discord can vouch for the person asking.
	 */
	private async claim(interaction: DiscordInteraction, guildId: string): Promise<void> {
		const code = optionValue(subOptions(interaction), "code") ?? "";
		const actor = interaction.member?.user?.id ?? interaction.user?.id;
		const reply = async (text: string) =>
			await this.rest.interactionReply(interaction.id, interaction.token, text);

		if (!actor) return await reply("Could not identify you.");
		if (!code.trim()) return await reply("Include the code from the Eryn settings page.");

		const claim = await controlCall(this.env, "/claim/get", { code: code.trim() });

		if (!claim.ok) {
			return await reply(
				typeof claim.data.error === "string" ? claim.data.error : "That code is not valid.",
			);
		}

		if (claim.data.guildId !== guildId) {
			return await reply("That code belongs to a different Discord server.");
		}

		let authority = this.authorities.get(guildId);

		if (!authority) {
			authority = new DiscordAuthority(this.rest, guildId);
			this.authorities.set(guildId, authority);
		}

		if (!(await authority.canManageGuild(actor))) {
			return await reply("You need Manage Server here to connect Eryn.");
		}

		const serverId = String(claim.data.serverId ?? "");
		const confirmed = await this.toServer(serverId, "/messaging/discord/confirm", {
			guildId,
			code: code.trim(),
			ownerDiscordId: actor,
		}).catch(() => undefined);

		if (confirmed?.ok !== true) {
			return await reply(
				typeof confirmed?.error === "string"
					? confirmed.error
					: "That Eryn server could not be connected.",
			);
		}

		await reply("Eryn is connected to this Discord server.");
	}

	private async keepAlive(): Promise<void> {
		if (this.restartPending) return;
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
			// Cloudflare drops an outbound WebSocket after 15 minutes, and the
			// object becomes evictable with it. Recycle on our own schedule so
			// no message falls into the gap.
			if (this.socket.stale) this.socket.recycle();
			else this.socket.ensure();
		}

		await this.ensureCommands();
		await this.ctx.storage.setAlarm(Date.now() + (this.socket?.open ? KEEPALIVE_MS : 10_000));
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
			userId: message.author?.id,
		});

		if (consumed?.consumed === true) return;
		const ingested = await this.toHub(serverId, "/ingest", { message: outbound });

		if (ingested?.ignored === true) return;
		await this.toServer(serverId, "/nudge", { message: outbound });
	}

	private channelNames = new Map<string, string>();

	private readonly roleCache = new Map<string, { expires: number; roles: string[] }>();
	private readonly authorities = new Map<string, DiscordAuthority>();

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
		if (interaction.type === 5) return await this.onModal(interaction);
		if (interaction.type !== 2) return;
		const guildId = interaction.guild_id;
		const name = interaction.data?.name;

		if (name !== "eryn" || !guildId) return;
		const sub = interaction.data?.options?.[0]?.name ?? "help";
		const serverId = await this.ctx.storage.get<string>(KEYS.guildIndex + guildId);
		const origin = configuredOrigin(this.env) ?? this.origin;

		if (sub === "claim") {
			await this.claim(interaction, guildId);

			return;
		}

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
			if (!(await this.mayManage(interaction, guildId, "manage"))) {
				return await this.rest.interactionReply(
					interaction.id,
					interaction.token,
					"Your Discord permissions do not allow compacting this conversation.",
				);
			}

			if (serverId) await this.toServer(serverId, "/compact", { channelId: interaction.channel_id });
			await this.rest.interactionReply(interaction.id, interaction.token, "Compacting this conversation.");

			return;
		}

		if (sub === "command") {
			if (!(await this.mayManage(interaction, guildId, "manage"))) {
				return await this.rest.interactionReply(
					interaction.id,
					interaction.token,
					"Your Discord permissions do not allow running commands here.",
				);
			}

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
			if (!(await this.mayManage(interaction, guildId, "send"))) {
				return await this.rest.interactionReply(
					interaction.id,
					interaction.token,
					"Your Discord permissions do not allow stopping runs here.",
				);
			}

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

		if (customId.startsWith("form:")) {
			return await this.onFormButton(interaction, customId.slice("form:".length));
		}

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

	/** The "Fill form" button opens a Discord modal. */
	private async onFormButton(interaction: DiscordInteraction, approvalId: string): Promise<void> {
		const guildId = interaction.guild_id;
		const serverId = guildId
			? await this.ctx.storage.get<string>(KEYS.guildIndex + guildId)
			: undefined;

		if (!serverId) {
			await this.rest.interactionReply(interaction.id, interaction.token, "This form is no longer connected.");

			return;
		}

		const definition = await this.toServer(serverId, "/form/definition", { approvalId });
		const fields = Array.isArray(definition?.fields) ? definition.fields : [];

		if (!definition || fields.length === 0 || fields.length > 5) {
			await this.rest.interactionReply(interaction.id, interaction.token, "This form is no longer available.");

			return;
		}

		const inputs = fields.flatMap((raw) => {
			const field = toJsonObject(raw as never);

			if (!field || typeof field.key !== "string") return [];
			const title = (typeof field.title === "string" ? field.title : field.key).slice(0, 45);
			const type = typeof field.type === "string" ? field.type : "string";

			return [
				{
					type: 4 as const,
					custom_id: field.key,
					label: title || "Answer",
					style: type === "string" ? (2 as const) : (1 as const),
					required: field.required !== false,
					max_length: type === "string" ? 4_000 : 100,
				},
			];
		});

		if (inputs.length === 0) return;
		const modal: DiscordModal = {
			custom_id: "form:" + approvalId,
			title: (typeof definition.title === "string" ? definition.title : "Input needed").slice(0, 45),
			components: inputs.map((input) => ({ type: 1, components: [input] })),
		};

		await this.rest.interactionModal(interaction.id, interaction.token, modal);
	}

	/** A submitted form modal. */
	private async onModal(interaction: DiscordInteraction): Promise<void> {
		const customId = interaction.data?.custom_id ?? "";

		if (!customId.startsWith("form:")) return;
		const approvalId = customId.slice("form:".length);
		const guildId = interaction.guild_id;
		const serverId = guildId
			? await this.ctx.storage.get<string>(KEYS.guildIndex + guildId)
			: undefined;

		if (!serverId) return;
		const values: Record<string, string> = {};

		for (const row of interaction.data?.components ?? []) {
			for (const component of row.components ?? []) {
				if (typeof component.custom_id === "string" && typeof component.value === "string") {
					values[component.custom_id] = component.value;
				}
			}
		}

		const userId = interaction.member?.user?.id ?? interaction.user?.id;

		const body: FormSubmitBody = {
			approvalId,
			values,
		};

		if (userId) body.userId = userId;
		await this.toServer(serverId, "/form/submit", body);
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
