/**
 * The bot's typed client for the guild session.
 *
 * It is one narrow interface over the session object's internal routes. Nothing
 * here holds a database or a socket; it is plumbing for the object that does.
 */

import { Option, Schema } from "effect";
import { withDeploy } from "../deploy";
import { botError } from "../errors";
import {
	IntegrationOptionSchema,
	McpAuthCompleteResponseSchema,
	McpAuthStartResponseSchema,
	McpAuthStatusSchema,
	McpAuthUrlResponseSchema,
	PublicLinkSchema,
	McpProbeResponseSchema,
	ModelOptionSchema,
	type GuildStatus,
	type IntegrationOption,
	type McpAuthCompleteResponse,
	type McpAuthStartResponse,
	type McpAuthStatus,
	type McpLink,
	type McpProbeResponse,
	type ModelOption,
	type ProviderConnectRequest,
	type ProviderConnectResponse,
	type PublicLink,
} from "../session/models";

const LinkListSchema = Schema.Struct({ links: Schema.Array(PublicLinkSchema) });
const ConfigSchema = Schema.Struct({
	ready: Schema.Boolean,
	model: Schema.String,
	providers: Schema.Array(
		Schema.Struct({
			integrationID: Schema.String,
			method: Schema.String,
		}),
	),
	links: Schema.Array(PublicLinkSchema),
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
			providers: [...parsed.providers],
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

	async disconnectProvider(integrationID: string): Promise<void> {
		await this.post("/disconnect", { guildId: this.guildId, integrationID });
	}

	async setModel(model: string): Promise<void> {
		await this.post("/model", { guildId: this.guildId, model });
	}

	async links(): Promise<PublicLink[]> {
		const parsed = decode(LinkListSchema, await this.post("/links", { guildId: this.guildId }), "the guild session");
		return [...parsed.links];
	}

	async addLink(link: McpLink): Promise<void> {
		await this.post("/link/add", { guildId: this.guildId, link });
	}

	async removeLink(linkId: string): Promise<void> {
		await this.post("/link/remove", { guildId: this.guildId, linkId });
	}

	/** Ask a URL what it offers before it is linked, and how it wants to be authed. */
	async probe(url: string, token?: string): Promise<McpProbeResponse> {
		return decode(
			McpProbeResponseSchema,
			await this.post("/link/probe", { guildId: this.guildId, url, ...(token ? { token } : {}) }),
			"the guild session",
		);
	}

	/** Test a link that is already stored, refreshing its token if needed. */
	async testLink(linkId: string): Promise<McpProbeResponse> {
		return decode(
			McpProbeResponseSchema,
			await this.post("/link/test", { guildId: this.guildId, linkId }),
			"the guild session",
		);
	}

	/** Start an OAuth sign-in with an external MCP server. */
	async mcpAuthStart(input: {
		name: string;
		url: string;
		channelId?: string;
		resourceMetadataUrl?: string;
		scope?: string;
	}): Promise<McpAuthStartResponse> {
		return decode(
			McpAuthStartResponseSchema,
			await this.post("/link/oauth/start", { guildId: this.guildId, ...input }),
			"the guild session",
		);
	}

	async mcpAuthStatus(attemptId: string): Promise<McpAuthStatus> {
		return decode(
			McpAuthStatusSchema,
			await this.post("/link/oauth/status", { guildId: this.guildId, attemptId }),
			"the guild session",
		);
	}

	async mcpAuthUrl(attemptId: string): Promise<string> {
		return decode(
			McpAuthUrlResponseSchema,
			await this.post("/link/oauth/url", { guildId: this.guildId, attemptId }),
			"the guild session",
		).url;
	}

	/** Finish a sign-in from the browser callback or the "I've finished" button. */
	async mcpAuthComplete(attemptId: string, code?: string, error?: string): Promise<McpAuthCompleteResponse> {
		return decode(
			McpAuthCompleteResponseSchema,
			await this.post("/link/oauth/complete", {
				guildId: this.guildId,
				attemptId,
				...(code ? { code } : {}),
				...(error ? { error } : {}),
			}),
			"the guild session",
		);
	}

	async prompt(body: unknown): Promise<void> {
		await this.post("/prompt", { ...(body as object), guildId: this.guildId });
	}

	async interrupt(threadId: string, gone: boolean): Promise<boolean> {
		const payload = (await this.post("/interrupt", { threadId, gone })) as { stopped?: unknown };
		return payload?.stopped === true;
	}
}


