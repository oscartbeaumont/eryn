/**
 * The guild session's data model.
 *
 * Every record the session stores, and every request body it accepts, is an
 * Effect `Schema`. Nothing here is trusted: a stored record is parsed on read,
 * and an internal route body is parsed before it is looked at.
 */

import { Schema } from "effect";

/**
 * Where a conversation lives, in Discord terms.
 *
 * The gateway writes this into a session's metadata so the Discord plugin can
 * tell the agent where it is. It lives here because it is a stored record: the
 * session owns the shape, and the plugin reads it.
 */
export const DiscordRefSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.optional(Schema.String),
});

export const DiscordContextSchema = Schema.Struct({
	/** The server the bot was invoked in. */
	guild: DiscordRefSchema,
	/** The channel the bot was invoked in — the thread's parent, when there is one. */
	channel: DiscordRefSchema,
	/**
	 * Where replies are posted: the thread for a threaded conversation, or the
	 * channel itself for a subscribed channel.
	 */
	thread: DiscordRefSchema,
	/** Whether replies land in a thread or directly in a subscribed channel. */
	kind: Schema.optional(Schema.Literals(["thread", "channel"])),
});
export type DiscordContext = typeof DiscordContextSchema.Type;

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
 * Both are sealed at rest and never leave the guild object; `PublicLink` is the
 * same record without them.
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
	createdAt: Schema.Number,
});
export type McpLink = typeof McpLinkSchema.Type;

/** A link as a caller may see it: no secret. */
export const PublicLinkSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	url: Schema.String,
	kind: Schema.optional(Schema.Literals(["eryn", "external"])),
	createdAt: Schema.Number,
});
export type PublicLink = typeof PublicLinkSchema.Type;

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
	state: Schema.String,
	/** The full authorization URL, for the short browser redirect. */
	authorizationUrl: Schema.optional(Schema.String),
	/** The interaction that posted the sign-in message, for editing it later. */
	applicationId: Schema.optional(Schema.String),
	interactionToken: Schema.optional(Schema.String),
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
	link: Schema.optional(PublicLinkSchema),
});
export type McpAuthStatus = typeof McpAuthStatusSchema.Type;

export const McpAuthUrlResponseSchema = Schema.Struct({ url: Schema.String });
export type McpAuthUrlResponse = typeof McpAuthUrlResponseSchema.Type;

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
	link: Schema.optional(PublicLinkSchema),
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

/** The status `/eryn setup` shows: readiness, the model, and no secret. */
export const GuildStatusSchema = Schema.Struct({
	ready: Schema.Boolean,
	model: Schema.String,
	providers: Schema.Array(Schema.Struct({ integrationID: Schema.String, method: Schema.String })),
	links: Schema.Array(PublicLinkSchema),
});
export type GuildStatus = typeof GuildStatusSchema.Type;

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

export const DisconnectRequestSchema = Schema.Struct({ guildId: Schema.String, integrationID: Schema.String });

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
	applicationId: Schema.optional(Schema.String),
	interactionToken: Schema.optional(Schema.String),
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

/** One file a Discord message carried, as the session needs it. */
export const PromptAttachmentSchema = Schema.Struct({
	url: Schema.String,
	name: Schema.optional(Schema.String),
	contentType: Schema.optional(Schema.String),
	size: Schema.optional(Schema.Number),
});
export type PromptAttachment = typeof PromptAttachmentSchema.Type;

/** A Discord account the model may need to identify in a message. */
export const PromptUserSchema = Schema.Struct({
	name: Schema.String,
	username: Schema.optional(Schema.String),
	id: Schema.optional(Schema.String),
	bot: Schema.optional(Schema.Boolean),
});
export type PromptUser = typeof PromptUserSchema.Type;

export const PromptRequestSchema = Schema.Struct({
	guildId: Schema.String,
	threadId: Schema.String,
	title: Schema.optional(Schema.String),
	text: Schema.String,
	/** The speaker's name, handle, and Discord id, so the agent knows who is talking. */
	author: Schema.optional(PromptUserSchema),
	/** Other users or bots mentioned in the message. */
	mentions: Schema.optional(Schema.Array(PromptUserSchema)),
	/** Where the request came from in Discord, recorded on the session. */
	discord: Schema.optional(DiscordContextSchema),
	/** Files attached to the message, for the model to read. */
	attachments: Schema.optional(Schema.Array(PromptAttachmentSchema)),
});
export type PromptRequest = typeof PromptRequestSchema.Type;

export const InterruptRequestSchema = Schema.Struct({
	threadId: Schema.String,
	gone: Schema.optional(Schema.Boolean),
});
export type InterruptRequest = typeof InterruptRequestSchema.Type;
