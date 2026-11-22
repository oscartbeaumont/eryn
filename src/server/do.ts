/**
 * One Eryn server: settings, inference credentials, MCP links, plugins, and the
 * OpenCode host. Messaging lives in Hub; this object only decides what the agent
 * can do and where its files are.
 */

import { DurableObject } from "cloudflare:workers";
import { Schema } from "effect";

import { capture } from "../analytics.ts";
import type { AnalyticsValue } from "../analytics.ts";
import { DEFAULT_MODEL, KEYS, log, optional } from "../config.ts";
import { newId } from "../core/ids.ts";
import { body, failure, json } from "../core/http.ts";
import {
	McpLinkSchema,
	PluginRecordSchema,
	ProviderConnectionSchema,
	ServerSettingsSchema,
} from "../core/schema.ts";
import type { InboundMessage, McpLink, PluginRecord } from "../core/schema.ts";
import { recordStore } from "../core/store.ts";
import type { RecordStore } from "../core/store.ts";
import { ORIGIN_HEADER } from "../deploy.ts";
import { describeError } from "../errors.ts";
import { discordRest } from "../discord/api.ts";
import { SERVER_ROOT } from "../core/paths.ts";
import { toJsonObject } from "../json.ts";
import type { Mutable } from "../mutable.ts";
import { webhookMatches } from "../hub/do.ts";
import { ServerAgent } from "./agent.ts";
import { ChannelRecordSchema } from "./models.ts";
import type { ChannelRecord } from "./models.ts";
import { seedServer } from "./seed.ts";

const AWAKE_MS = 2 * 60_000;

const InitSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	ownerId: Schema.String,
});

const RenameSchema = Schema.Struct({ name: Schema.String });

const ModelSchema = Schema.Struct({ model: Schema.String });

const ConnectSchema = Schema.Struct({ integrationID: Schema.String, key: Schema.String });

const DisconnectSchema = Schema.Struct({ integrationID: Schema.String });

const LinkAddSchema = Schema.Struct({
	name: Schema.String,
	url: Schema.String,
	token: Schema.optional(Schema.String),
});

const LinkRemoveSchema = Schema.Struct({ id: Schema.String });

const PluginAddSchema = Schema.Struct({
	name: Schema.String,
	code: Schema.String,
	allowNetwork: Schema.optional(Schema.Boolean),
});

const PluginRemoveSchema = Schema.Struct({ id: Schema.String });

const PluginToggleSchema = Schema.Struct({ id: Schema.String, enabled: Schema.Boolean });

const AttachSchema = Schema.Struct({
	channelId: Schema.String,
	provider: Schema.Literals(["discord", "imessage"]),
	name: Schema.optional(Schema.String),
	containerId: Schema.optional(Schema.String),
});

const DetachSchema = Schema.Struct({ channelId: Schema.String });

const InterruptSchema = Schema.Struct({ channelId: Schema.String });

const NudgeSchema = Schema.Struct({ message: Schema.Unknown });

const DiscordSchema = Schema.Struct({ guildId: Schema.String, guildName: Schema.optional(Schema.String) });

const ImessageSchema = Schema.Struct({
	apiKeyId: Schema.String,
	apiSecret: Schema.String,
	fromNumber: Schema.String,
});

const GuildSchema = Schema.Struct({ guildId: Schema.String });

/** Whether a link name is safe as an MCP server name. */
function serverName(value: string): string {
	return value.trim().toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "").slice(0, 48);
}

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class Server extends DurableObject<Env> {
	private readonly serverId: string;
	private readonly store: RecordStore;
	private readonly agent: ServerAgent;
	private origin: string | undefined;
	private readonly nudged = new Set<string>();

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.serverId = state.id.name ?? "";
		this.store = recordStore(state.storage, env.ENCRYPTION_KEY);
		this.agent = new ServerAgent({
			env,
			storage: state.storage,
			serverId: this.serverId,
			origin: () => this.origin,
			servers: env.SERVER,
			hubs: env.HUB,
			channels: async () => await this.channels(),
			saveChannel: async (record) => {
				await this.store.putPlain(KEYS.channel + record.channelId, ChannelRecordSchema, record);
			},
			settings: async () => await this.settings(),
			connections: async () => await this.store.listSealed(KEYS.provider, ProviderConnectionSchema),
			links: async () => await this.store.listSealed(KEYS.link, McpLinkSchema),
			plugins: async () => await this.store.listSealed(KEYS.plugin, PluginRecordSchema),
		});
	}

	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		const served = request.headers.get(ORIGIN_HEADER);

		if (!this.origin) this.origin = await this.ctx.storage.get<string>("server:origin");

		if (served) {
			this.origin = served.replace(/\/$/, "");
			await this.ctx.storage.put("server:origin", this.origin);
		}

		try {
			return await this.route(path, request);
		} catch (error) {
			log("server", "route " + path + " failed: " + describeError(error));

			return failure("The server could not answer.", 500);
		}
	}

	private async route(path: string, request: Request): Promise<Response> {
		if (path === "/init" && request.method === "POST") return await this.init(request);
		if (path === "/wake" && request.method === "POST") return await this.wake();
		if (path === "/status" && request.method === "POST") return await this.status();
		if (path === "/rename" && request.method === "POST") return await this.rename(request);
		if (path === "/model" && request.method === "POST") return await this.setModel(request);
		if (path === "/integrations" && request.method === "POST") return await this.integrations();
		if (path === "/models" && request.method === "POST") return await this.models();
		if (path === "/connect" && request.method === "POST") return await this.connectProvider(request);
		if (path === "/disconnect" && request.method === "POST") return await this.disconnect(request);
		if (path === "/links" && request.method === "POST") return await this.links();
		if (path === "/link/add" && request.method === "POST") return await this.addLink(request);
		if (path === "/link/remove" && request.method === "POST") return await this.removeLink(request);
		if (path === "/plugins" && request.method === "POST") return await this.plugins();
		if (path === "/plugin/add" && request.method === "POST") return await this.addPlugin(request);
		if (path === "/plugin/remove" && request.method === "POST") return await this.removePlugin(request);
		if (path === "/plugin/toggle" && request.method === "POST") return await this.togglePlugin(request);
		if (path === "/channels" && request.method === "POST") return await this.channelsRoute();
		if (path === "/channels/attach" && request.method === "POST") return await this.attach(request);
		if (path === "/channels/detach" && request.method === "POST") return await this.detach(request);
		if (path === "/interrupt" && request.method === "POST") return await this.interrupt(request);
		if (path === "/nudge" && request.method === "POST") return await this.nudge(request);
		if (path === "/messaging" && request.method === "POST") return await this.messaging();
		if (path === "/messaging/discord" && request.method === "POST") return await this.setDiscord(request);
		if (path === "/messaging/imessage" && request.method === "POST") return await this.setImessage(request);
		if (path === "/webhook/sendblue" && request.method === "POST") return await this.sendblueWebhook(request);
		if (path === "/discord/guilds" && request.method === "POST") return await this.discordGuilds();
		if (path === "/discord/channels" && request.method === "POST") return await this.discordChannels(request);
		if (path === "/reset" && request.method === "POST") return await this.reset();

		return failure("Not found.", 404);
	}

	async alarm(): Promise<void> {
		if (!this.origin) this.origin = await this.ctx.storage.get<string>("server:origin");

		if ((await this.channels()).length > 0) {
			await this.agent.wake().catch((error: unknown) =>
				log("server", "could not wake the host: " + describeError(error)),
			);
		}

		await this.ctx.storage.setAlarm(Date.now() + AWAKE_MS);
	}

	// --- State ---------------------------------------------------------------

	private async settings() {
		return (
			(await this.store.plain(KEYS.server, ServerSettingsSchema)) ?? {
				id: this.serverId,
				name: "Eryn",
				ownerId: "",
				model: DEFAULT_MODEL,
				createdAt: 0,
				updatedAt: 0,
			}
		);
	}

	private async channels(): Promise<ChannelRecord[]> {
		const channels = await this.store.listPlain(KEYS.channel, ChannelRecordSchema);

		return channels.sort((a, b) => a.createdAt - b.createdAt);
	}

	private async hub(path: string, payload: unknown): Promise<Schema.JsonObject | undefined> {
		const response = await this.env.HUB.get(this.env.HUB.idFromName(this.serverId)).fetch(
			"https://hub.internal" + path,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			},
		);

		return toJsonObject((await response.json().catch(() => undefined)) as never);
	}

	private async gateway(path: string, payload: unknown): Promise<boolean> {
		const response = await this.env.GATEWAY.get(this.env.GATEWAY.idFromName("gateway")).fetch(
			"https://gateway.internal" + path,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			},
		);

		if (!response.ok) log("server", "gateway returned HTTP " + response.status);

		return response.ok;
	}

	/** Coarse product analytics for this server; never blocks the request. */
	private track(event: string, properties: Record<string, AnalyticsValue> = {}): void {
		this.ctx.waitUntil(capture(this.env, event, properties, { serverId: this.serverId }));
	}

	private async init(request: Request): Promise<Response> {
		const input = await body(request, InitSchema);

		if (input instanceof Response) return input;
		const now = Date.now();
		const existing = await this.store.plain(KEYS.server, ServerSettingsSchema);
		const settings = {
			id: input.id,
			name: input.name,
			ownerId: input.ownerId,
			model: existing?.model ?? DEFAULT_MODEL,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};

		await this.store.putPlain(KEYS.server, ServerSettingsSchema, settings);
		await seedServer(this.ctx.storage, this.serverId);
		await this.ctx.storage.setAlarm(Date.now() + AWAKE_MS);

		return json({ server: settings });
	}

	private async wake(): Promise<Response> {
		await this.agent.wake().catch((error: unknown) => log("server", describeError(error)));
		await this.ctx.storage.setAlarm(Date.now() + AWAKE_MS);

		return json({ ok: true, ready: this.agent.ready() });
	}

	private async status(): Promise<Response> {
		const settings = await this.settings();
		const connections = await this.store.listSealed(KEYS.provider, ProviderConnectionSchema);
		const links = await this.store.listSealed(KEYS.link, McpLinkSchema);
		const plugins = await this.store.listSealed(KEYS.plugin, PluginRecordSchema);
		const channels = await this.channels();

		if (channels.length > 0 && !this.agent.hasHost()) {
			await this.agent
				.wake()
				.catch((error: unknown) => log("server", "could not start the host: " + describeError(error)));
		}

		let mcp: Schema.Json = [];

		if (this.agent.hasHost()) {
			try {
				const host = await this.agent.ensureHost();
				const listed = await host.mcp.list();

				mcp = listed.data;
			} catch (error) {
				log("server", "could not list MCP servers: " + describeError(error));
			}
		}

		const messaging: Mutable<Schema.JsonObject> = { ...(await this.hub("/messaging/status", {})) };
		const imessage = await this.ctx.storage.get<{ webhookSecret?: string }>("messaging:imessage");

		if (imessage?.webhookSecret && this.origin) {
			messaging.webhookUrl =
				this.origin + "/webhooks/sendblue/" + this.serverId + "?token=" + imessage.webhookSecret;
		}

		return json({
			server: settings,
			ready: this.agent.hasHost(),
			origin: this.origin ?? null,
			providers: connections.map((entry) => ({
				integrationID: entry.integrationID,
				method: entry.method,
			})),
			links: links.map((link) => {
				const { token: _token, oauth: _oauth, ...rest } = link;

				return rest;
			}),
			plugins: plugins.map((plugin) => {
				const { code: _code, ...rest } = plugin;

				return rest;
			}),
			channels,
			messaging,
			mcp,
		});
	}

	private async rename(request: Request): Promise<Response> {
		const input = await body(request, RenameSchema);

		if (input instanceof Response) return input;
		const settings = await this.settings();
		const next = { ...settings, name: input.name.trim().slice(0, 80) || settings.name, updatedAt: Date.now() };

		await this.store.putPlain(KEYS.server, ServerSettingsSchema, next);
		this.track("server_renamed");

		return json({ server: next });
	}

	private async setModel(request: Request): Promise<Response> {
		const input = await body(request, ModelSchema);

		if (input instanceof Response) return input;
		const settings = await this.settings();

		await this.store.putPlain(KEYS.server, ServerSettingsSchema, {
			...settings,
			model: input.model,
			updatedAt: Date.now(),
		});
		await this.agent.refreshModels().catch(() => undefined);
		const slash = input.model.indexOf("/");

		this.track("model_selected", {
			provider: slash > 0 ? input.model.slice(0, slash) : undefined,
			model: input.model,
		});

		return json({ ok: true });
	}

	// --- Inference -----------------------------------------------------------

	private async integrations(): Promise<Response> {
		const host = await this.agent.ensureHost();
		const listed = await host.integration.list({ location: { directory: SERVER_ROOT } });

		return json({ integrations: Array.isArray(listed.data) ? listed.data : [] });
	}

	private async models(): Promise<Response> {
		const host = await this.agent.ensureHost();
		const listed = await host.model.list({ location: { directory: SERVER_ROOT } });

		return json({ models: Array.isArray(listed) ? listed : [] });
	}

	private async connectProvider(request: Request): Promise<Response> {
		const input = await body(request, ConnectSchema);

		if (input instanceof Response) return input;
		const host = await this.agent.ensureHost();

		try {
			await host.integration.connect.key({
				integrationID: input.integrationID,
				key: input.key,
				location: { directory: SERVER_ROOT },
			});
		} catch (error) {
			return failure("That key was not accepted: " + describeError(error));
		}

		await this.store.putSealed(KEYS.provider + input.integrationID, ProviderConnectionSchema, {
			integrationID: input.integrationID,
			method: "key",
			key: input.key,
		});
		this.track("inference_connected", { provider: input.integrationID });

		return json({ ok: true });
	}

	private async disconnect(request: Request): Promise<Response> {
		const input = await body(request, DisconnectSchema);

		if (input instanceof Response) return input;
		await this.store.remove(KEYS.provider + input.integrationID);
		this.track("inference_disconnected", { provider: input.integrationID });

		return json({ ok: true });
	}

	// --- MCP links -----------------------------------------------------------

	private async links(): Promise<Response> {
		const links = await this.store.listSealed(KEYS.link, McpLinkSchema);

		return json({
			links: links.map((link) => {
				const { token: _token, oauth: _oauth, ...rest } = link;

				return rest;
			}),
		});
	}

	private async addLink(request: Request): Promise<Response> {
		const input = await body(request, LinkAddSchema);

		if (input instanceof Response) return input;
		const name = serverName(input.name);

		if (!name || name === "eryn") return failure("Choose a name other than \"eryn\".");

		try {
			const url = new URL(input.url);

			if (url.protocol !== "https:") return failure("An MCP server must use HTTPS.");
		} catch {
			return failure("That URL is not valid.");
		}

		const link: McpLink = {
			id: newId("mcp"),
			name,
			url: input.url,
			token: input.token,
			createdAt: Date.now(),
		};

		await this.store.putSealed(KEYS.link + link.id, McpLinkSchema, link);
		this.track("mcp_link_added");

		return json({ ok: true });
	}

	private async removeLink(request: Request): Promise<Response> {
		const input = await body(request, LinkRemoveSchema);

		if (input instanceof Response) return input;
		await this.store.remove(KEYS.link + input.id);
		this.track("mcp_link_removed");

		return json({ ok: true });
	}

	// --- Plugins -------------------------------------------------------------

	private async plugins(): Promise<Response> {
		const plugins = await this.store.listSealed(KEYS.plugin, PluginRecordSchema);

		return json({
			plugins: plugins.map((plugin) => {
				const { code: _code, ...rest } = plugin;

				return rest;
			}),
		});
	}

	private async addPlugin(request: Request): Promise<Response> {
		const input = await body(request, PluginAddSchema);

		if (input instanceof Response) return input;
		const now = Date.now();
		const version = (await sha256(input.code + (input.allowNetwork ? ":network" : ""))).slice(0, 16);
		const plugin: PluginRecord = {
			id: newId("plg"),
			name: input.name.trim().slice(0, 60) || "Plugin",
			version,
			enabled: true,
			allowNetwork: input.allowNetwork === true,
			code: input.code,
			createdAt: now,
			updatedAt: now,
		};

		await this.store.putSealed(KEYS.plugin + plugin.id, PluginRecordSchema, plugin);
		this.track("plugin_added", { allow_network: plugin.allowNetwork });

		return json({ ok: true, plugin: { ...plugin, code: undefined } });
	}

	private async removePlugin(request: Request): Promise<Response> {
		const input = await body(request, PluginRemoveSchema);

		if (input instanceof Response) return input;
		await this.store.remove(KEYS.plugin + input.id);
		this.track("plugin_removed");

		return json({ ok: true });
	}

	private async togglePlugin(request: Request): Promise<Response> {
		const input = await body(request, PluginToggleSchema);

		if (input instanceof Response) return input;
		const key = KEYS.plugin + input.id;
		const plugin = await this.store.sealed(key, PluginRecordSchema);

		if (!plugin) return failure("That plugin does not exist.", 404);
		await this.store.putSealed(key, PluginRecordSchema, {
			...plugin,
			enabled: input.enabled,
			updatedAt: Date.now(),
		});
		this.track("plugin_toggled", { enabled: input.enabled });

		return json({ ok: true });
	}

	// --- Channels ------------------------------------------------------------

	private async channelsRoute(): Promise<Response> {
		const messaging = await this.hub("/channels", {});

		return json({
			channels: Array.isArray(messaging?.channels) ? messaging.channels : [],
			projects: await this.channels(),
		});
	}

	private async attach(request: Request): Promise<Response> {
		const input = await body(request, AttachSchema);

		if (input instanceof Response) return input;
		await this.hub("/bind", {
			provider: input.provider,
			externalId: input.channelId,
			name: input.name,
			containerId: input.containerId,
		});
		const record = await this.agent.attachChannel({
			channelId: input.channelId,
			provider: input.provider,
			name: input.name,
			containerId: input.containerId,
			createdAt: Date.now(),
		});

		await this.ctx.storage.setAlarm(Date.now() + AWAKE_MS);
		this.track("channel_attached", { provider: input.provider });

		return json({ ok: true, channel: record });
	}

	private async detach(request: Request): Promise<Response> {
		const input = await body(request, DetachSchema);

		if (input instanceof Response) return input;
		const record = await this.store.plain(KEYS.channel + input.channelId, ChannelRecordSchema);

		await this.store.remove(KEYS.channel + input.channelId);
		await this.hub("/unbind", { id: input.channelId });

		if (record) await this.agent.detach(record).catch(() => undefined);
		this.track("channel_detached", { provider: record?.provider });

		return json({ ok: true });
	}

	private async interrupt(request: Request): Promise<Response> {
		const input = await body(request, InterruptSchema);

		if (input instanceof Response) return input;

		return json({ ok: await this.agent.interrupt(input.channelId) });
	}

	/** A Gateway or webhook nudge, so a cold object can catch the message. */
	private async nudge(request: Request): Promise<Response> {
		const input = await body(request, NudgeSchema);

		if (input instanceof Response) return input;
		// SAFETY: the only caller is this deployment, and an InboundMessage was
		// validated on the way into Hub before it got here.
		const message = input.message as InboundMessage;

		if (!message || typeof message.channel !== "string") return failure("Bad message.");

		if (this.nudged.has(message.id)) return json({ ok: true, prompted: false });
		this.nudged.add(message.id);

		if (this.nudged.size > 500) {
			const first = this.nudged.values().next().value;

			if (first) this.nudged.delete(first);
		}

		try {
			const prompted = await this.agent.prompt(message.channel, message);

			return json({ ok: true, prompted });
		} catch (error) {
			log("server", "nudge failed: " + describeError(error));

			return json({ ok: false });
		}
	}

	// --- Messaging configuration ---------------------------------------------

	private async messaging(): Promise<Response> {
		const status = (await this.hub("/messaging/status", {})) ?? {};
		const config = await this.ctx.storage.get<{ webhookSecret?: string }>("messaging:imessage");
		const response: Mutable<Schema.JsonObject> = { ...status };

		if (config?.webhookSecret && this.origin) {
			response.webhookUrl =
				this.origin + "/webhooks/sendblue/" + this.serverId + "?token=" + config.webhookSecret;
		}

		return json(response);
	}

	private async setDiscord(request: Request): Promise<Response> {
		const input = await body(request, DiscordSchema);

		if (input instanceof Response) return input;
		await this.hub("/messaging", {
			config: { kind: "discord", guildId: input.guildId, guildName: input.guildName },
		});
		const connected = await this.gateway("/register", { guildId: input.guildId, serverId: this.serverId });

		if (connected) this.track("discord_connected");

		return json({ ok: true });
	}

	private async setImessage(request: Request): Promise<Response> {
		const input = await body(request, ImessageSchema);

		if (input instanceof Response) return input;
		const secret = newId("whk", 24);

		await this.hub("/messaging", {
			config: {
				kind: "imessage",
				apiKeyId: input.apiKeyId,
				apiSecret: input.apiSecret,
				fromNumber: input.fromNumber,
				webhookSecret: secret,
			},
		});
		await this.ctx.storage.put("messaging:imessage", { webhookSecret: secret });
		this.track("imessage_connected");

		return json({ ok: true, webhookSecret: secret });
	}

	/** Receive a SendBlue message webhook for this server. */
	private async sendblueWebhook(request: Request): Promise<Response> {
		const stored = await this.ctx.storage.get<{ webhookSecret?: string }>("messaging:imessage");
		const token = request.headers.get("x-eryn-token") ?? "";

		if (!stored?.webhookSecret || !webhookMatches(stored.webhookSecret, token)) {
			return failure("Bad webhook token.", 401);
		}

		const payload = toJsonObject((await request.json().catch(() => undefined)) as never);

		if (!payload || payload.is_outbound === true) return json({ ok: true, ignored: true });
		const content = typeof payload.content === "string" ? payload.content : "";
		const from = typeof payload.from_number === "string" ? payload.from_number : "";
		const group = typeof payload.group_id === "string" ? payload.group_id : "";
		const media = typeof payload.media_url === "string" ? payload.media_url : "";

		if (!content && !media) return json({ ok: true, ignored: true });
		const message: InboundMessage = {
			id: typeof payload.message_handle === "string" ? payload.message_handle : newId("msg"),
			provider: "imessage",
			channel: group || from,
			author: { id: from || "unknown", name: from || "unknown" },
			text: content,
			attachments: media ? [{ url: media }] : [],
			mentions: [],
			createdAt: Date.now(),
			channelName: group || from,
		};

		await this.hub("/ingest", { message });
		this.ctx.waitUntil(
			this.agent.prompt(message.channel, message).catch((error: unknown) => {
				log("server", "could not prompt from webhook: " + describeError(error));
			}),
		);

		return json({ ok: true });
	}

	private async discordGuilds(): Promise<Response> {
		const rest = discordRest(optional(this.env, "DISCORD_BOT_TOKEN") ?? "");

		try {
			const guilds = await rest.guilds();

			return json({
				guilds: guilds.map((guild) => ({ id: guild.id, name: guild.name })),
			});
		} catch (error) {
			return failure("Discord could not be reached: " + describeError(error));
		}
	}

	private async discordChannels(request: Request): Promise<Response> {
		const input = await body(request, GuildSchema);

		if (input instanceof Response) return input;
		const rest = discordRest(optional(this.env, "DISCORD_BOT_TOKEN") ?? "");

		try {
			const channels = await rest.guildChannels(input.guildId);

			return json({
				channels: channels
					.filter((channel) => (channel.type ?? 0) === 0 || (channel.type ?? 0) === 5)
					.map((channel) => ({ id: channel.id, name: channel.name })),
			});
		} catch (error) {
			return failure("Discord could not be reached: " + describeError(error));
		}
	}

	// --- Reset ---------------------------------------------------------------

	private async reset(): Promise<Response> {
		let removed = 0;

		for (;;) {
			const entries = await this.ctx.storage.list<unknown>({ prefix: KEYS.fs, limit: 1_000 });
			const keys = [...entries.keys()];

			if (keys.length === 0) break;
			for (let index = 0; index < keys.length; index += 128) {
				await this.ctx.storage.delete(keys.slice(index, index + 128));
			}

			removed += keys.length;

			if (keys.length < 1_000) break;
		}

		const markers = await this.ctx.storage.list<unknown>({ prefix: KEYS.workspaceSeed });

		for (const key of markers.keys()) await this.ctx.storage.delete(key);
		await seedServer(this.ctx.storage, this.serverId);
		this.track("files_reset", { files_removed: removed });

		return json({ ok: true, files: removed });
	}
}

/** The singleton name a Worker uses to address a server. */
export function serverNameFor(id: string): string {
	return id;
}
