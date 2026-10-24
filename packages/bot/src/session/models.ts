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

/**
 * What a hosted MCP server exposes, and again (as a narrowing subset) what a
 * guild link is allowed to reach.
 */
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
 * One MCP server a guild has linked: Eryn-hosted or external.
 *
 * `token` is the bearer the agent presents. It is sealed at rest and never
 * leaves the guild object; the contract's public `McpLink` is the same record
 * without it.
 */
export const McpLinkSchema = Schema.Struct({
	id: Schema.String,
	kind: Schema.Literals(["eryn", "external"]),
	name: Schema.String,
	url: Schema.String,
	mcpServerId: Schema.optional(Schema.String),
	token: Schema.optional(Schema.String),
	tools: ToolAccessSchema,
	createdAt: Schema.Number,
});
export type McpLink = typeof McpLinkSchema.Type;

/** A link as the gateway may see it: no secret. */
export type PublicLink = Omit<McpLink, "token">;

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

/** A guild's configuration, as the gateway hands it to a turn. */
export const GuildConfigSchema = Schema.Struct({
	connections: Schema.Array(ProviderConnectionSchema),
	model: Schema.String,
});
export type GuildConfig = typeof GuildConfigSchema.Type;

export const PromptRequestSchema = Schema.Struct({
	guildId: Schema.String,
	threadId: Schema.String,
	title: Schema.optional(Schema.String),
	text: Schema.String,
	/** The name the speaker goes by, so the agent knows who it is answering. */
	author: Schema.optional(Schema.String),
	/** Where the request came from in Discord, recorded on the session. */
	discord: Schema.optional(DiscordContextSchema),
	/** Optional override; the session falls back to its own stored config. */
	config: Schema.optional(GuildConfigSchema),
});
export type PromptRequest = typeof PromptRequestSchema.Type;

export const InterruptRequestSchema = Schema.Struct({
	threadId: Schema.String,
	gone: Schema.optional(Schema.Boolean),
});
export type InterruptRequest = typeof InterruptRequestSchema.Type;

/** The status the gateway reports for a guild without exposing any secret. */
export interface GuildStatus {
	ready: boolean;
	model: string;
	providers: ConnectionSummary[];
	links: McpLink[];
}
