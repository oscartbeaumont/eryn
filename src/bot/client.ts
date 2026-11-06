/**
 * The bot's typed client for the guild session.
 *
 * It is one narrow interface over the session object's internal routes. Nothing
 * here holds a database or a socket; it is plumbing for the object that does.
 */

import { Option, Schema } from "effect";

import { withDeploy } from "../deploy";
import { ROUTES } from "../session/paths";
import { botError } from "../errors";
import {
	GuildStatusSchema,
	IntegrationOptionSchema,
	McpAuthCompleteResponseSchema,
	McpAuthStartResponseSchema,
	McpAuthStatusSchema,
	McpAuthUrlResponseSchema,
	McpProbeResponseSchema,
	ModelOptionSchema,
	ProviderConnectResponseSchema,
	PublicLinkSchema,
	type GuildStatus,
	type IntegrationOption,
	type McpAuthCompleteResponse,
	type McpAuthStartResponse,
	type McpAuthStatus,
	type McpLink,
	type McpProbeResponse,
	type ModelOption,
	type PromptRequest,
	type ProviderConnectRequest,
	type ProviderConnectResponse,
	type PublicLink,
} from "../session/models";

const LinkListSchema = Schema.Struct({ links: Schema.Array(PublicLinkSchema) });
const ProviderListSchema = Schema.Struct({ integrations: Schema.Array(IntegrationOptionSchema) });
const ModelListSchema = Schema.Struct({ models: Schema.Array(ModelOptionSchema) });

function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S["Type"] {
	const parsed = Schema.decodeUnknownOption(schema)(input);
	if (Option.isNone(parsed)) throw botError("the guild session returned an unexpected shape");
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

	private async call<S extends Schema.ConstraintDecoder<unknown>>(
		path: string,
		schema: S,
		body: unknown,
	): Promise<S["Type"]> {
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
		return decode(schema, payload);
	}

	config(): Promise<GuildStatus> {
		return this.call(ROUTES.config, GuildStatusSchema, { guildId: this.guildId });
	}

	providers(): Promise<IntegrationOption[]> {
		return this.call(ROUTES.providers, ProviderListSchema, { guildId: this.guildId }).then((parsed) => [...parsed.integrations]);
	}

	models(): Promise<ModelOption[]> {
		return this.call(ROUTES.models, ModelListSchema, { guildId: this.guildId }).then((parsed) => [...parsed.models]);
	}

	providerConnect(request: Omit<ProviderConnectRequest, "guildId">): Promise<ProviderConnectResponse> {
		return this.call(ROUTES.providerConnect, ProviderConnectResponseSchema, { ...request, guildId: this.guildId });
	}

	async disconnectProvider(integrationID: string): Promise<void> {
		await this.call(ROUTES.disconnect, Schema.Unknown, { guildId: this.guildId, integrationID });
	}

	async setModel(model: string): Promise<void> {
		await this.call(ROUTES.model, Schema.Unknown, { guildId: this.guildId, model });
	}

	links(): Promise<PublicLink[]> {
		return this.call(ROUTES.links, LinkListSchema, { guildId: this.guildId }).then((parsed) => [...parsed.links]);
	}

	async addLink(link: McpLink): Promise<void> {
		await this.call(ROUTES.linkAdd, Schema.Unknown, { guildId: this.guildId, link });
	}

	async removeLink(linkId: string): Promise<void> {
		await this.call(ROUTES.linkRemove, Schema.Unknown, { guildId: this.guildId, linkId });
	}

	/** Ask a URL what it offers before it is linked, and how it wants to be authed. */
	probe(url: string, token?: string): Promise<McpProbeResponse> {
		return this.call(ROUTES.linkProbe, McpProbeResponseSchema, {
			guildId: this.guildId,
			url,
			...(token ? { token } : {}),
		});
	}

	/** Test a link that is already stored, refreshing its token if needed. */
	testLink(linkId: string): Promise<McpProbeResponse> {
		return this.call(ROUTES.linkTest, McpProbeResponseSchema, { guildId: this.guildId, linkId });
	}

	/** Start an OAuth sign-in with an external MCP server. */
	mcpAuthStart(input: {
		name: string;
		url: string;
		applicationId?: string;
		interactionToken?: string;
		resourceMetadataUrl?: string;
		scope?: string;
	}): Promise<McpAuthStartResponse> {
		return this.call(ROUTES.linkOauthStart, McpAuthStartResponseSchema, { guildId: this.guildId, ...input });
	}

	mcpAuthStatus(attemptId: string): Promise<McpAuthStatus> {
		return this.call(ROUTES.linkOauthStatus, McpAuthStatusSchema, { guildId: this.guildId, attemptId });
	}

	async mcpAuthUrl(attemptId: string): Promise<string> {
		const response = await this.call(ROUTES.linkOauthUrl, McpAuthUrlResponseSchema, {
			guildId: this.guildId,
			attemptId,
		});
		return response.url;
	}

	/** Finish a sign-in from the browser callback or the "I've finished" button. */
	mcpAuthComplete(attemptId: string, code?: string, error?: string): Promise<McpAuthCompleteResponse> {
		return this.call(ROUTES.linkOauthComplete, McpAuthCompleteResponseSchema, {
			guildId: this.guildId,
			attemptId,
			...(code ? { code } : {}),
			...(error ? { error } : {}),
		});
	}

	async prompt(body: Omit<PromptRequest, "guildId">): Promise<void> {
		await this.call(ROUTES.prompt, Schema.Unknown, { ...body, guildId: this.guildId });
	}

	async interrupt(threadId: string, gone: boolean): Promise<boolean> {
		const payload = await this.call(
			ROUTES.interrupt,
			Schema.Struct({ stopped: Schema.optional(Schema.Boolean) }),
			{ threadId, gone },
		);
		return payload.stopped === true;
	}
}
