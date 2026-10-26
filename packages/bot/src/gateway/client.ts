/**
 * The bot gateway's typed clients.
 *
 * Two narrow interfaces meet here: the guild session's internal routes (bot DO
 * to bot DO), and the gateway user's internal routes (bot to gateway), over the
 * `GATEWAY_USER` binding. Nothing in this file holds a database or a socket; it
 * is plumbing for the two objects that do.
 */

import { Option, Schema } from "effect";
import { withDeploy } from "../deploy";
import { botError, describeError } from "../errors";
import {
	IntegrationOptionSchema,
	McpLinkSchema,
	ModelOptionSchema,
	ToolAccessSchema,
	type GuildStatus,
	type IntegrationOption,
	type McpLink,
	type ModelOption,
	type ProviderConnectRequest,
	type ProviderConnectResponse,
	type PublicLink,
	type ToolAccess,
} from "../session/models";

/** A hosted MCP server as the gateway describes it to the bot. */
export interface HostedServer {
	id: string;
	name: string;
	title?: string;
	enabled: boolean;
	tools: ToolAccess;
}

const HostedServerSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	title: Schema.optional(Schema.String),
	enabled: Schema.Boolean,
	tools: ToolAccessSchema,
});

const ServerListSchema = Schema.Struct({ servers: Schema.Array(HostedServerSchema) });
const GrantSchema = Schema.Struct({ ok: Schema.optional(Schema.Boolean), url: Schema.String, token: Schema.String });
const LinkListSchema = Schema.Struct({ links: Schema.Array(McpLinkSchema) });
const ConfigSchema = Schema.Struct({
	ready: Schema.Boolean,
	model: Schema.String,
	providers: Schema.Array(
		Schema.Struct({
			integrationID: Schema.String,
			method: Schema.String,
			prefix: Schema.optional(Schema.String),
		}),
	),
	links: Schema.Array(McpLinkSchema),
});
const ProviderListSchema = Schema.Struct({ integrations: Schema.Array(IntegrationOptionSchema) });
const ModelListSchema = Schema.Struct({ models: Schema.Array(ModelOptionSchema) });
const ConnectSchema = Schema.Struct({
	ok: Schema.optional(Schema.Boolean),
	url: Schema.optional(Schema.String),
	attemptID: Schema.optional(Schema.String),
	mode: Schema.optional(Schema.String),
	instructions: Schema.optional(Schema.String),
	status: Schema.optional(
		Schema.Struct({
			status: Schema.Literals(["pending", "complete", "failed", "expired"]),
			message: Schema.optional(Schema.String),
		}),
	),
	error: Schema.optional(Schema.String),
});

function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown, label: string): S["Type"] {
	const parsed = Schema.decodeUnknownOption(schema)(input);
	if (Option.isNone(parsed)) throw botError(`${label} returned an unexpected shape`);
	return parsed.value;
}

/** The guild's own session object, addressed by guild id. */
export class SessionClient {
	constructor(
		private readonly env: Env,
		private readonly guildId: string,
	) {}

	private stub(): DurableObjectStub {
		return this.env.BOT_SESSION.get(this.env.BOT_SESSION.idFromName(this.guildId));
	}

	private async post(path: string, body: unknown): Promise<unknown> {
		const response = await this.stub().fetch(
			`https://bot.internal${path}`,
			withDeploy(this.env, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
		const payload = (await response.json().catch(() => undefined)) as unknown;
		if (!response.ok) {
			const message =
				payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string"
					? (payload as { error: string }).error
					: `the guild session returned HTTP ${response.status}`;
			throw botError(message);
		}
		return payload;
	}

	async config(): Promise<GuildStatus> {
		const parsed = decode(ConfigSchema, await this.post("/config", { guildId: this.guildId }), "the guild session");
		return {
			ready: parsed.ready,
			model: parsed.model,
			providers: parsed.providers.map((provider) => ({
				integrationID: provider.integrationID,
				method: provider.method,
				...(provider.prefix ? { prefix: provider.prefix } : {}),
			})),
			links: [...parsed.links],
		};
	}

	async providers(): Promise<IntegrationOption[]> {
		const parsed = decode(ProviderListSchema, await this.post("/providers", { guildId: this.guildId }), "the guild session");
		return [...parsed.integrations];
	}

	async models(): Promise<ModelOption[]> {
		const parsed = decode(ModelListSchema, await this.post("/models", { guildId: this.guildId }), "the guild session");
		return [...parsed.models];
	}

	async providerConnect(request: ProviderConnectRequest): Promise<ProviderConnectResponse> {
		const parsed = decode(ConnectSchema, await this.post("/provider/connect", request), "the guild session");
		return parsed;
	}

	async setModel(model: string): Promise<void> {
		await this.post("/model", { guildId: this.guildId, model });
	}

	async links(): Promise<PublicLink[]> {
		const parsed = decode(LinkListSchema, await this.post("/links", { guildId: this.guildId }), "the guild session");
		return parsed.links.map((link) => {
			const { token: _token, ...rest } = link;
			return rest;
		});
	}

	async addLink(link: McpLink): Promise<void> {
		await this.post("/link/add", { guildId: this.guildId, link });
	}

	async removeLink(linkId: string): Promise<void> {
		await this.post("/link/remove", { guildId: this.guildId, linkId });
	}

	async prompt(body: unknown): Promise<void> {
		await this.post("/prompt", { ...(body as object), guildId: this.guildId });
	}

	async interrupt(threadId: string, gone: boolean): Promise<boolean> {
		const payload = (await this.post("/interrupt", { threadId, gone })) as { stopped?: unknown };
		return payload?.stopped === true;
	}
}

/** A caller's Eryn-hosted MCP servers, and the grants the bot holds on them. */
export class GatewayClient {
	constructor(private readonly env: Env) {}

	private stub(userId: string): DurableObjectStub {
		return this.env.GATEWAY_USER.get(this.env.GATEWAY_USER.idFromName(userId));
	}

	private async post(path: string, body: unknown): Promise<unknown> {
		const userId = (body as { userId: string }).userId;
		const response = await this.stub(userId).fetch(
			`https://gateway.internal${path}`,
			withDeploy(this.env, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		);
		const payload = (await response.json().catch(() => undefined)) as unknown;
		if (!response.ok) throw botError(`the gateway returned HTTP ${response.status} for ${path}`);
		return payload;
	}

	async servers(userId: string): Promise<HostedServer[]> {
		const parsed = decode(ServerListSchema, await this.post("/servers", { userId }), "the gateway");
		return [...parsed.servers];
	}

	async grant(
		userId: string,
		guildId: string,
		mcpServerId: string,
		tools: ToolAccess,
	): Promise<{ url: string; token: string }> {
		const parsed = decode(
			GrantSchema,
			await this.post("/grant", { userId, guildId, mcpServerId, tools }),
			"the gateway",
		);
		return { url: parsed.url, token: parsed.token };
	}

	async revoke(userId: string, guildId: string, mcpServerId: string): Promise<void> {
		await this.post("/revoke", { userId, guildId, mcpServerId });
	}
}

export { describeError };
