/**
 * The guild session's data model.
 *
 * Every record the session stores, and every request body it accepts, is an
 * Effect `Schema`. Nothing here is trusted: a stored record is parsed on read,
 * and an internal route body is parsed before it is looked at.
 */

import { Schema } from "effect";

import { DiscordContextSchema } from "../discord/context";

/** A group's access level: `none` hides it, `all` is read plus write. */
export const AccessLevelSchema = Schema.Literals(["none", "read", "write", "all"]);
export type AccessLevel = typeof AccessLevelSchema.Type;

/** What tools a guild link is allowed to reach on an external MCP server. */
export const ToolAccessSchema = Schema.Struct({
	groups: Schema.Record(Schema.String, AccessLevelSchema),
	tools: Schema.optional(
		Schema.Struct({
			include: Schema.optional(Schema.Array(Schema.String)),
			exclude: Schema.optional(Schema.Array(Schema.String)),
		}),
	),
});
export type ToolAccess = typeof ToolAccessSchema.Type;

/**
 * What is needed to keep an OAuth link's bearer alive.
 *
 * The access token itself lives on the link as `token`, so the agent never
 * needs to know how it was obtained. This record is what a refresh needs, and
 * it is only ever present on a link that was added through a sign-in.
 */
export const McpOAuthSchema = Schema.Struct({
	refreshToken: Schema.optional(Schema.String),
	clientId: Schema.String,
	clientSecret: Schema.optional(Schema.String),
	tokenEndpoint: Schema.String,
	expiresAt: Schema.Number,
	scope: Schema.optional(Schema.String),
	/** The RFC 8707 resource indicator, when the server asked for one. */
	resource: Schema.optional(Schema.String),
});
export type McpOAuth = typeof McpOAuthSchema.Type;

/**
 * One external MCP server a guild has linked.
 *
 * `token` is the bearer the agent presents and `oauth` is what keeps it alive.
 * Both are sealed at rest and never leave the guild object; the public
 * `McpLink` is the same record without them.
 */
export const McpLinkSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	url: Schema.String,
	/**
	 * Legacy marker from when Eryn hosted MCP servers itself. Such links point
	 * at an endpoint that no longer exists and are ignored on read; new links
	 * never set it.
	 */
	kind: Schema.optional(Schema.Literals(["eryn", "external"])),
	token: Schema.optional(Schema.String),
	oauth: Schema.optional(McpOAuthSchema),
	tools: ToolAccessSchema,
	createdAt: Schema.Number,
});
export type McpLink = typeof McpLinkSchema.Type;

/** A link as a caller may see it: no secret. */
export type PublicLink = Omit<McpLink, "token" | "oauth">;

/** One tool an MCP server advertises, as a connection test reports it. */
export const McpToolSummarySchema = Schema.Struct({
	name: Schema.String,
	title: Schema.optional(Schema.String),
	description: Schema.optional(Schema.String),
});
export type McpToolSummary = typeof McpToolSummarySchema.Type;

/** The outcome of talking to an MCP server: what it offers, or why it refused. */
export const McpProbeResponseSchema = Schema.Struct({
	ok: Schema.Boolean,
	tools: Schema.Array(McpToolSummarySchema),
	serverName: Schema.optional(Schema.String),
	/** Set when the server answered with a Bearer challenge and might sign us in. */
	needsAuth: Schema.optional(Schema.Boolean),
	resourceMetadataUrl: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.String),
	error: Schema.optional(Schema.String),
});
export type McpProbeResponse = typeof McpProbeResponseSchema.Type;

/**
 * A sign-in with an external MCP server that has started but not finished.
 *
 * The redirect comes back to the Worker rather than to the interaction that
 * started it, so the attempt (client registration, PKCE verifier, endpoint)
 * has to outlive the request and be found again by its signed `state`.
 */
export const PendingMcpAuthSchema = Schema.Struct({
	attemptId: Schema.String,
	name: Schema.String,
	url: Schema.String,
	/** Where to confirm completion, so the browser callback can say so. */
	channelId: Schema.optional(Schema.String),
	state: Schema.String,
	clientId: Schema.String,
	clientSecret: Schema.optional(Schema.String),
	tokenEndpoint: Schema.String,
	resource: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.String),
	codeVerifier: Schema.String,
	redirectUri: Schema.String,
	status: Schema.Literals(["pending", "complete", "failed"]),
	message: Schema.optional(Schema.String),
	linkId: Schema.optional(Schema.String),
	createdAt: Schema.Number,
});
export type PendingMcpAuth = typeof PendingMcpAuthSchema.Type;

/** A sign-in's state, as the Discord interaction asks about it. */
export const McpAuthStatusSchema = Schema.Struct({
	status: Schema.Literals(["pending", "complete", "failed", "missing"]),
	message: Schema.optional(Schema.String),
	link: Schema.optional(McpLinkSchema),
});
export type McpAuthStatus = typeof McpAuthStatusSchema.Type;

export const McpAuthStartResponseSchema = Schema.Struct({
	ok: Schema.optional(Schema.Boolean),
	attemptId: Schema.optional(Schema.String),
	url: Schema.optional(Schema.String),
	error: Schema.optional(Schema.String),
});
export type McpAuthStartResponse = typeof McpAuthStartResponseSchema.Type;

export const McpAuthCompleteResponseSchema = Schema.Struct({
	ok: Schema.optional(Schema.Boolean),
	status: Schema.optional(Schema.Literals(["complete", "failed"])),
	message: Schema.optional(Schema.String),
	link: Schema.optional(McpLinkSchema),
	tools: Schema.optional(Schema.Array(McpToolSummarySchema)),
});
export type McpAuthCompleteResponse = typeof McpAuthCompleteResponseSchema.Type;

/** One provider credential a guild has connected. */
export const ProviderConnectionSchema = Schema.Struct({
	integrationID: Schema.String,
	/** The flow it was connected with: `key` or `oauth`. */
	method: Schema.String,
	/** The secret, for a `key` connection; empty when a sign-in holds it instead. */
	key: Schema.String,
});
export type ProviderConnection = typeof ProviderConnectionSchema.Type;

/** What a guild has configured, without any secret. */
export const GuildSettingsSchema = Schema.Struct({
	model: Schema.String,
	configuredBy: Schema.optional(Schema.String),
	updatedAt: Schema.Number,
});
export type GuildSettings = typeof GuildSettingsSchema.Type;

/** A connection as the status command shows it: never the secret. */
export interface ConnectionSummary {
	integrationID: string;
	method: string;
	/** The start of the key, for display only. */
	prefix?: string;
}

// --- Provider catalogue --------------------------------------------------------

/** One way a provider can be connected, as the host describes it. */
export const ProviderFieldSchema = Schema.Struct({
	key: Schema.String,
	type: Schema.Literals(["string", "number", "integer", "boolean"]),
	title: Schema.optional(Schema.String),
	description: Schema.optional(Schema.String),
	placeholder: Schema.optional(Schema.String),
	required: Schema.optional(Schema.Boolean),
	default: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
	options: Schema.optional(
		Schema.Array(
			Schema.Struct({
				value: Schema.String,
				label: Schema.String,
				description: Schema.optional(Schema.String),
			}),
		),
	),
	when: Schema.optional(
		Schema.Array(
			Schema.Struct({
				key: Schema.String,
				op: Schema.Literals(["eq", "neq"]),
				value: Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
			}),
		),
	),
});
export type ProviderField = typeof ProviderFieldSchema.Type;

export const IntegrationMethodOptionSchema = Schema.Struct({
	type: Schema.String,
	/** OAuth methods are addressed by id when a flow is started. */
	id: Schema.optional(Schema.String),
	label: Schema.String,
	/** Whether this deployment can run the flow at all. */
	supported: Schema.Boolean,
	fields: Schema.optional(Schema.Array(ProviderFieldSchema)),
});
export type IntegrationMethodOption = typeof IntegrationMethodOptionSchema.Type;

/** A provider a guild could connect, and what connecting it would take. */
export const IntegrationOptionSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	connected: Schema.Boolean,
	methods: Schema.Array(IntegrationMethodOptionSchema),
});
export type IntegrationOption = typeof IntegrationOptionSchema.Type;

/** A model the picker can offer, normalised from the host's catalogue. */
export const ModelOptionSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	provider: Schema.String,
	status: Schema.String,
	enabled: Schema.Boolean,
	connected: Schema.Boolean,
});
export type ModelOption = typeof ModelOptionSchema.Type;

/** A sign-in the host has started, and where to send the user. */
export const OAuthAttemptSchema = Schema.Struct({
	attemptID: Schema.String,
	url: Schema.String,
	instructions: Schema.String,
	mode: Schema.Literals(["auto", "code"]),
});
export type OAuthAttempt = typeof OAuthAttemptSchema.Type;

/** How a sign-in attempt is doing. */
export const OAuthStatusSchema = Schema.Struct({
	status: Schema.Literals(["pending", "complete", "failed", "expired"]),
	message: Schema.optional(Schema.String),
});
export type OAuthStatus = typeof OAuthStatusSchema.Type;

/**
 * A sign-in that has started but not finished.
 *
 * A device-code flow finishes out of band, so the attempt has to outlive the
 * interaction that started it: the code modal only carries the provider id, and
 * this is where the attempt id comes from.
 */
export const PendingOAuthSchema = Schema.Struct({
	integrationID: Schema.String,
	attemptID: Schema.String,
	createdAt: Schema.Number,
});
export type PendingOAuth = typeof PendingOAuthSchema.Type;

// --- Internal route bodies -----------------------------------------------------

export const GuildRefSchema = Schema.Struct({ guildId: Schema.String });

export const ProviderConnectRequestSchema = Schema.Struct({
	guildId: Schema.String,
	integrationID: Schema.String,
	methodID: Schema.optional(Schema.String),
	key: Schema.optional(Schema.String),
	action: Schema.optional(Schema.Literals(["start", "status", "complete", "cancel"])),
	attemptID: Schema.optional(Schema.String),
	code: Schema.optional(Schema.String),
	answer: Schema.optional(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean]))),
});
export type ProviderConnectRequest = typeof ProviderConnectRequestSchema.Type;

export const ProviderConnectResponseSchema = Schema.Struct({
	ok: Schema.optional(Schema.Boolean),
	url: Schema.optional(Schema.String),
	attemptID: Schema.optional(Schema.String),
	mode: Schema.optional(Schema.String),
	instructions: Schema.optional(Schema.String),
	status: Schema.optional(OAuthStatusSchema),
	error: Schema.optional(Schema.String),
});
export type ProviderConnectResponse = typeof ProviderConnectResponseSchema.Type;

export const ModelRequestSchema = Schema.Struct({ guildId: Schema.String, model: Schema.String });

export const LinkAddRequestSchema = Schema.Struct({ guildId: Schema.String, link: McpLinkSchema });
export const LinkRemoveRequestSchema = Schema.Struct({ guildId: Schema.String, linkId: Schema.String });
export const McpProbeRequestSchema = Schema.Struct({
	guildId: Schema.String,
	url: Schema.String,
	token: Schema.optional(Schema.String),
});
export const McpTestRequestSchema = Schema.Struct({ guildId: Schema.String, linkId: Schema.String });
export const McpAuthStartRequestSchema = Schema.Struct({
	guildId: Schema.String,
	name: Schema.String,
	url: Schema.String,
	channelId: Schema.optional(Schema.String),
	/** The `resource_metadata` URL from the server's challenge, when it gave one. */
	resourceMetadataUrl: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.String),
});
export const McpAuthAttemptRequestSchema = Schema.Struct({
	guildId: Schema.String,
	attemptId: Schema.String,
});
export const McpAuthCompleteRequestSchema = Schema.Struct({
	guildId: Schema.String,
	attemptId: Schema.String,
	code: Schema.optional(Schema.String),
	/** Set when the authorization server sent the browser back with an error. */
	error: Schema.optional(Schema.String),
});

/** A guild's configuration, as the bot hands it to a turn. */
export const GuildConfigSchema = Schema.Struct({
	connections: Schema.Array(ProviderConnectionSchema),
	model: Schema.String,
});
export type GuildConfig = typeof GuildConfigSchema.Type;

/** One file a Discord message carried, as the session needs it. */
export const PromptAttachmentSchema = Schema.Struct({
	url: Schema.String,
	name: Schema.optional(Schema.String),
	contentType: Schema.optional(Schema.String),
	size: Schema.optional(Schema.Number),
});
export type PromptAttachment = typeof PromptAttachmentSchema.Type;

export const PromptRequestSchema = Schema.Struct({
	guildId: Schema.String,
	threadId: Schema.String,
	title: Schema.optional(Schema.String),
	text: Schema.String,
	/** The name the speaker goes by, so the agent knows who it is answering. */
	author: Schema.optional(Schema.String),
	/** Where the request came from in Discord, recorded on the session. */
	discord: Schema.optional(DiscordContextSchema),
	/** Files attached to the message, for the model to read. */
	attachments: Schema.optional(Schema.Array(PromptAttachmentSchema)),
	/** Optional override; the session falls back to its own stored config. */
	config: Schema.optional(GuildConfigSchema),
});
export type PromptRequest = typeof PromptRequestSchema.Type;

export const InterruptRequestSchema = Schema.Struct({
	threadId: Schema.String,
	gone: Schema.optional(Schema.Boolean),
});
export type InterruptRequest = typeof InterruptRequestSchema.Type;

/** The status the bot reports for a guild without exposing any secret. */
export interface GuildStatus {
	ready: boolean;
	model: string;
	providers: ConnectionSummary[];
	links: McpLink[];
}
