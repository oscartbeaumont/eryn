/**
 * The records every part of Eryn shares.
 *
 * A record is parsed when it is read from storage and when it crosses an
 * internal route, so an old or malformed value fails at the boundary instead of
 * becoming a runtime surprise deep inside an agent turn.
 */

import { Schema } from "effect";

// --- Identity -----------------------------------------------------------------

/** A user account. The email is the login identity and the id never changes. */
export const UserSchema = Schema.Struct({
	id: Schema.String,
	email: Schema.String,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
});

export type User = typeof UserSchema.Type;

/** One browser session. The cookie carries the id; this record is the proof. */
export const AuthSessionSchema = Schema.Struct({
	id: Schema.String,
	userId: Schema.String,
	createdAt: Schema.Finite,
	expiresAt: Schema.Finite,
	userAgent: Schema.optional(Schema.String),
});

export type AuthSession = typeof AuthSessionSchema.Type;

/** A login code that has been sent but not used. Only its hash is stored. */
export const LoginCodeSchema = Schema.Struct({
	email: Schema.String,
	hash: Schema.String,
	expiresAt: Schema.Finite,
	attempts: Schema.Finite,
	createdAt: Schema.Finite,
});

export type LoginCode = typeof LoginCodeSchema.Type;

/** One Eryn server: the unit a person configures and an agent runs in. */
export const ServerRefSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	ownerId: Schema.String,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
});

export type ServerRef = typeof ServerRefSchema.Type;

// --- Messaging ----------------------------------------------------------------

export const ProviderKindSchema = Schema.Literals(["discord", "imessage"]);

export type ProviderKind = typeof ProviderKindSchema.Type;

/** A file or image a message carried. */
export const AttachmentSchema = Schema.Struct({
	url: Schema.String,
	name: Schema.optional(Schema.String),
	contentType: Schema.optional(Schema.String),
	size: Schema.optional(Schema.Finite),
});

export type Attachment = typeof AttachmentSchema.Type;

/** The person or bot that sent a message. */
export const AuthorSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	handle: Schema.optional(Schema.String),
	bot: Schema.optional(Schema.Boolean),
	/** Discord role ids, used to resolve the speaker's policy. */
	roles: Schema.optional(Schema.Array(Schema.String)),
});

export type Author = typeof AuthorSchema.Type;

/**
 * A conversation with a messaging surface.
 *
 * `externalId` is whatever the provider addresses messages with: a Discord
 * channel or thread id, or an E.164 phone number for iMessage. It is the only
 * provider-specific value the rest of Eryn needs.
 */
export const ChannelBindingSchema = Schema.Struct({
	id: Schema.String,
	provider: ProviderKindSchema,
	externalId: Schema.String,
	name: Schema.optional(Schema.String),
	/** The Discord guild, or another provider's container id. */
	containerId: Schema.optional(Schema.String),
	/** How the binding was made, so the Server can tell a thread to attach. */
	source: Schema.optional(Schema.Literals(["manual", "thread", "mention"])),
	enabled: Schema.Boolean,
	createdAt: Schema.Finite,
});

export type ChannelBinding = typeof ChannelBindingSchema.Type;

/** A normalised inbound message, whatever surface it arrived on. */
export const InboundMessageSchema = Schema.Struct({
	id: Schema.String,
	provider: ProviderKindSchema,
	/** The binding's external id: channel, thread, or phone number. */
	channel: Schema.String,
	/** The thread inside the channel, when the surface has threads. */
	thread: Schema.optional(Schema.String),
	author: AuthorSchema,
	text: Schema.String,
	attachments: Schema.Array(AttachmentSchema),
	mentions: Schema.Array(AuthorSchema),
	replyTo: Schema.optional(Schema.String),
	createdAt: Schema.Finite,
	/** Whether the bot itself sent it, so it is not fed back to the agent. */
	outbound: Schema.optional(Schema.Boolean),
	/** Whether the message names the agent, so an unbound channel may open. */
	addressed: Schema.optional(Schema.Boolean),
	/** A display name for the channel, used when a binding is created. */
	channelName: Schema.optional(Schema.String),
});

export type InboundMessage = typeof InboundMessageSchema.Type;

/** An event stored for MCP Events and replayed after a reconnect. */
export const StoredEventSchema = Schema.Struct({
	/** Monotonic cursor, opaque to the client. */
	cursor: Schema.String,
	eventId: Schema.String,
	name: Schema.String,
	timestamp: Schema.String,
	data: Schema.Unknown,
});

export type StoredEvent = typeof StoredEventSchema.Type;

// --- Messaging configuration --------------------------------------------------

/** Discord: the guild this Eryn server is bound to. */
export const DiscordConfigSchema = Schema.Struct({
	kind: Schema.Literal("discord"),
	guildId: Schema.String,
	guildName: Schema.optional(Schema.String),
});

/** iMessage through SendBlue. */
export const SendBlueConfigSchema = Schema.Struct({
	kind: Schema.Literal("imessage"),
	apiKeyId: Schema.String,
	apiSecret: Schema.String,
	fromNumber: Schema.String,
	/** Per-server secret in the webhook URL. */
	webhookSecret: Schema.String,
});

export const MessagingConfigSchema = Schema.Union([DiscordConfigSchema, SendBlueConfigSchema]);

export type MessagingConfig = typeof MessagingConfigSchema.Type;

// --- Server settings ----------------------------------------------------------

/** What a server has configured, without secrets. */
export const ServerSettingsSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	ownerId: Schema.String,
	model: Schema.String,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
});

export type ServerSettings = typeof ServerSettingsSchema.Type;

/** One inference credential a server has connected. */
export const ProviderConnectionSchema = Schema.Struct({
	integrationID: Schema.String,
	method: Schema.String,
	key: Schema.String,
});

export type ProviderConnection = typeof ProviderConnectionSchema.Type;

/** One MCP server a server has linked. */
export const McpLinkSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	url: Schema.String,
	elicitation: Schema.optional(Schema.Literals(["off", "browser", "agent"])),
	token: Schema.optional(Schema.String),
	oauth: Schema.optional(
		Schema.Struct({
			refreshToken: Schema.optional(Schema.String),
			clientId: Schema.String,
			clientSecret: Schema.optional(Schema.String),
			tokenEndpoint: Schema.String,
			expiresAt: Schema.Finite,
			scope: Schema.optional(Schema.String),
			resource: Schema.optional(Schema.String),
		}),
	),
	createdAt: Schema.Finite,
});

export type McpLink = typeof McpLinkSchema.Type;

/** A link without its secrets. */
export const PublicLinkSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	url: Schema.String,
	elicitation: Schema.optional(Schema.Literals(["off", "browser", "agent"])),
	createdAt: Schema.Finite,
});

export type PublicLink = typeof PublicLinkSchema.Type;

/** A custom agent plugin. The code is sealed with the deployment key. */
export const PluginRecordSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	version: Schema.String,
	enabled: Schema.Boolean,
	allowNetwork: Schema.Boolean,
	code: Schema.String,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
});

export type PluginRecord = typeof PluginRecordSchema.Type;

export const PublicPluginSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	version: Schema.String,
	enabled: Schema.Boolean,
	allowNetwork: Schema.Boolean,
	createdAt: Schema.Finite,
	updatedAt: Schema.Finite,
});

export type PublicPlugin = typeof PublicPluginSchema.Type;

// --- Internal route bodies ----------------------------------------------------

export const EmptySchema = Schema.Struct({});

export const IngestRequestSchema = Schema.Struct({
	message: InboundMessageSchema,
});

export const BindChannelRequestSchema = Schema.Struct({
	provider: ProviderKindSchema,
	externalId: Schema.String,
	name: Schema.optional(Schema.String),
	containerId: Schema.optional(Schema.String),
	source: Schema.optional(Schema.Literals(["manual", "thread", "mention"])),
});

export const UnbindChannelRequestSchema = Schema.Struct({
	id: Schema.String,
});

export const PushMessagingConfigSchema = Schema.Struct({
	config: MessagingConfigSchema,
});

export const RememberSessionSchema = Schema.Struct({
	sessionID: Schema.String,
	channel: Schema.String,
});

export const SendMessageRequestSchema = Schema.Struct({
	channel: Schema.String,
	text: Schema.String,
	attachments: Schema.optional(Schema.Array(AttachmentSchema)),
	replyTo: Schema.optional(Schema.String),
	/** Discord components, or undefined on a provider that has none. */
	components: Schema.optional(Schema.Json),
});

export const SendMessageResponseSchema = Schema.Struct({
	ok: Schema.Boolean,
	id: Schema.optional(Schema.String),
	error: Schema.optional(Schema.String),
});

export const HistoryRequestSchema = Schema.Struct({
	channel: Schema.String,
	limit: Schema.optional(Schema.Finite),
});

export const HistoryResponseSchema = Schema.Struct({
	messages: Schema.Array(InboundMessageSchema),
});

export const ChannelsResponseSchema = Schema.Struct({
	channels: Schema.Array(ChannelBindingSchema),
});
