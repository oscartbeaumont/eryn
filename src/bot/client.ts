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
	ApprovalReplyResponseSchema,
	CompactResponseSchema,
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
	FormViewSchema,
	InteractResponseSchema,
	PolicyStateSchema,
	type CompactResponse,
	type DiscordContext,
	type ElicitationMode,
	type FormView,
	type GuildStatus,
	type IntegrationOption,
	type InteractResponse,
	type McpAuthCompleteResponse,
	type McpAuthStartResponse,
	type McpAuthStatus,
	type McpLink,
	type McpProbeResponse,
	type ModelOption,
	type Policy,
	type PolicyState,
	type PromptRequest,
	type ProviderConnectRequest,
	type ProviderConnectResponse,
	type PublicLink,
} from "../session/models";

const LinkListSchema = Schema.Struct({ links: Schema.Array(PublicLinkSchema) });
const ProviderListSchema = Schema.Struct({ integrations: Schema.Array(IntegrationOptionSchema) });
const ModelListSchema = Schema.Struct({ models: Schema.Array(ModelOptionSchema) });

function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, input: unknown): S["Type"] {
	return Option.getOrThrowWith(Schema.decodeUnknownOption(schema)(input), () =>
		botError("the guild session returned an unexpected shape"),
	);
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

	/**
	 * Send one internal request, scoped to this guild.
	 *
	 * A route that names its guild rejects a body that names another, so the id
	 * is added here rather than repeated in every method body.
	 */
	private async call<S extends Schema.ConstraintDecoder<unknown>>(
		path: string,
		schema: S,
		body: Record<string, unknown> = {},
	): Promise<S["Type"]> {
		const response = await this.stub().fetch(
			`https://bot.internal${path}`,
			withDeploy(this.env, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...body, guildId: this.guildId }),
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
		return this.call(ROUTES.config, GuildStatusSchema);
	}

	providers(): Promise<IntegrationOption[]> {
		return this.call(ROUTES.providers, ProviderListSchema).then((parsed) => [...parsed.integrations]);
	}

	models(): Promise<ModelOption[]> {
		return this.call(ROUTES.models, ModelListSchema).then((parsed) => [...parsed.models]);
	}

	providerConnect(request: Omit<ProviderConnectRequest, "guildId">): Promise<ProviderConnectResponse> {
		return this.call(ROUTES.providerConnect, ProviderConnectResponseSchema, request);
	}

	async disconnectProvider(integrationID: string): Promise<void> {
		await this.call(ROUTES.disconnect, Schema.Unknown, { integrationID });
	}

	async setModel(model: string): Promise<void> {
		await this.call(ROUTES.model, Schema.Unknown, { model });
	}

	links(): Promise<PublicLink[]> {
		return this.call(ROUTES.links, LinkListSchema).then((parsed) => [...parsed.links]);
	}

	async addLink(link: McpLink): Promise<void> {
		await this.call(ROUTES.linkAdd, Schema.Unknown, { link });
	}

	async removeLink(linkId: string): Promise<void> {
		await this.call(ROUTES.linkRemove, Schema.Unknown, { linkId });
	}

	/** Ask a URL what it offers before it is linked, and how it wants to be authed. */
	probe(url: string, token?: string): Promise<McpProbeResponse> {
		return this.call(ROUTES.linkProbe, McpProbeResponseSchema, {
			url,
			...(token ? { token } : {}),
		});
	}

	/** Test a link that is already stored, refreshing its token if needed. */
	testLink(linkId: string): Promise<McpProbeResponse> {
		return this.call(ROUTES.linkTest, McpProbeResponseSchema, { linkId });
	}

	/** Start an OAuth sign-in with an external MCP server. */
	mcpAuthStart(input: {
		name: string;
		url: string;
		elicitation?: ElicitationMode;
		applicationId?: string;
		interactionToken?: string;
		resourceMetadataUrl?: string;
		scope?: string;
	}): Promise<McpAuthStartResponse> {
		return this.call(ROUTES.linkOauthStart, McpAuthStartResponseSchema, input);
	}

	mcpAuthStatus(attemptId: string): Promise<McpAuthStatus> {
		return this.call(ROUTES.linkOauthStatus, McpAuthStatusSchema, { attemptId });
	}

	async mcpAuthUrl(attemptId: string): Promise<string> {
		const response = await this.call(ROUTES.linkOauthUrl, McpAuthUrlResponseSchema, { attemptId });
		return response.url;
	}

	/** Finish a sign-in from the browser callback or the "I've finished" button. */
	mcpAuthComplete(attemptId: string, code?: string, error?: string): Promise<McpAuthCompleteResponse> {
		return this.call(ROUTES.linkOauthComplete, McpAuthCompleteResponseSchema, {
			attemptId,
			...(code ? { code } : {}),
			...(error ? { error } : {}),
		});
	}

	async prompt(body: Omit<PromptRequest, "guildId">): Promise<void> {
		await this.call(ROUTES.prompt, Schema.Unknown, body);
	}

	/**
	 * Correct a conversation's recorded Discord context after a rename.
	 *
	 * A scheduled turn starts from the stored copy, so it has to be right even
	 * when no message follows the rename.
	 */
	async updateContext(threadId: string, discord: DiscordContext): Promise<void> {
		await this.call(ROUTES.context, Schema.Unknown, { threadId, discord });
	}

	policy(input: { channelId: string; threadId?: string }): Promise<PolicyState> {
		return this.call(ROUTES.policy, PolicyStateSchema, input);
	}

	async setPolicy(input: {
		scope: "guild" | "channel" | "thread";
		channelId: string;
		threadId?: string;
		policy: Policy;
	}): Promise<PolicyState> {
		const response = await this.call(
			ROUTES.policySet,
			Schema.Struct({ ok: Schema.Boolean, state: PolicyStateSchema }),
			input,
		);
		return response.state;
	}

	async clearPolicy(input: {
		scope: "guild" | "channel" | "thread";
		channelId: string;
		threadId?: string;
	}): Promise<PolicyState> {
		const response = await this.call(
			ROUTES.policyClear,
			Schema.Struct({ ok: Schema.Boolean, state: PolicyStateSchema }),
			input,
		);
		return response.state;
	}

	replyApproval(input: {
		threadId: string;
		requestId: string;
		decision: "once" | "always" | "block";
		userId?: string;
		manager?: boolean;
	}): Promise<{ ok: boolean; message?: string }> {
		return this.call(ROUTES.approval, ApprovalReplyResponseSchema, input);
	}

	form(formId: string, auth: { userId?: string; manager?: boolean } = {}): Promise<FormView> {
		return this.call(ROUTES.form, FormViewSchema, { formId, ...auth });
	}

	replyForm(
		formId: string,
		values: Record<string, string>,
		auth: { userId?: string; manager?: boolean } = {},
	): Promise<{ ok: boolean; message?: string }> {
		return this.call(ROUTES.formReply, ApprovalReplyResponseSchema, { formId, values, ...auth });
	}

	cancelForm(
		formId: string,
		auth: { userId?: string; manager?: boolean } = {},
	): Promise<{ ok: boolean; message?: string }> {
		return this.call(ROUTES.formCancel, ApprovalReplyResponseSchema, { formId, ...auth });
	}

	async interrupt(threadId: string, gone: boolean): Promise<boolean> {
		const payload = await this.call(
			ROUTES.interrupt,
			Schema.Struct({ stopped: Schema.optional(Schema.Boolean) }),
			{ threadId, gone },
		);
		return payload.stopped === true;
	}

	/** Compact this conversation's history at a member's request. */
	compact(threadId: string): Promise<CompactResponse> {
		return this.call(ROUTES.compact, CompactResponseSchema, { threadId });
	}

	/** Whether this Discord user covers the conversation's schedule scope. */
	canInteract(threadId: string, userId: string): Promise<InteractResponse> {
		return this.call(ROUTES.interact, InteractResponseSchema, { threadId, userId });
	}
}
