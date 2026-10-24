/**
 * The gateway's domain model.
 *
 * Everything a request carries and everything that is stored is described here
 * with Effect `Schema` and parsed, never trusted. Storage holds the same shapes,
 * so a record written by one deploy is read back through the same schema.
 */

import { Schema } from "effect";

export const Provider = Schema.Literals(["discord", "github", "google"]);
export type Provider = Schema.Schema.Type<typeof Provider>;

export const TOOL_ACCESS_LEVELS = ["none", "read", "write", "all"] as const;
export const ToolAccessLevel = Schema.Literals(TOOL_ACCESS_LEVELS);
export type ToolAccessLevel = Schema.Schema.Type<typeof ToolAccessLevel>;

/**
 * What a hosted server (or a guild link) exposes.
 *
 * `groups` is the coarse control — a group set to `read` shows only its
 * read-only tools, `write` only its mutating ones, `all` both — and `tools`
 * narrows it further when a caller needs tool-level precision.
 */
export const ToolAccess = Schema.Struct({
	groups: Schema.Record(Schema.String, ToolAccessLevel),
	tools: Schema.optional(
		Schema.Struct({
			include: Schema.optional(Schema.Array(Schema.String)),
			exclude: Schema.optional(Schema.Array(Schema.String)),
		}),
	),
});
export type ToolAccess = Schema.Schema.Type<typeof ToolAccess>;

export const PROFILE = Schema.Struct({
	id: Schema.String,
	username: Schema.String,
	name: Schema.optional(Schema.String),
	avatarUrl: Schema.optional(Schema.String),
	/** A public profile URL, when the provider has one. */
	url: Schema.optional(Schema.String),
});
export type Profile = Schema.Schema.Type<typeof PROFILE>;

export const CREDENTIAL = Schema.Struct({
	kind: Provider,
	/** The bearer token, when the provider uses one. */
	token: Schema.optional(Schema.String),
	/** A refresh token, for the providers that rotate. */
	refreshToken: Schema.optional(Schema.String),
	/** When `token` stops working, in ms since the epoch. */
	expiresAt: Schema.optional(Schema.Number),
	/** A GitHub App installation id, the other way to act as GitHub. */
	installationId: Schema.optional(Schema.String),
});
export type Credential = Schema.Schema.Type<typeof CREDENTIAL>;

export const Account = Schema.Struct({
	id: Schema.String,
	provider: Provider,
	label: Schema.String,
	profile: PROFILE,
	credential: CREDENTIAL,
	createdAt: Schema.Number,
});
export type Account = Schema.Schema.Type<typeof Account>;

/** An account as the console sees it: never the credential. */
export const AccountSummary = Schema.Struct({
	id: Schema.String,
	provider: Provider,
	label: Schema.String,
	profile: PROFILE,
	createdAt: Schema.Number,
});
export type AccountSummary = Schema.Schema.Type<typeof AccountSummary>;

export const McpServer = Schema.Struct({
	id: Schema.String,
	/** The URL slug; unique per user and the last segment of the endpoint. */
	name: Schema.String,
	title: Schema.optional(Schema.String),
	enabled: Schema.Boolean,
	/** The accounts its tools may act through. */
	accountIds: Schema.Array(Schema.String),
	tools: ToolAccess,
	createdAt: Schema.Number,
});
export type McpServer = Schema.Schema.Type<typeof McpServer>;

export const Grant = Schema.Struct({
	guildId: Schema.String,
	mcpServerId: Schema.String,
	/** The subset of tool names this guild may use. */
	toolNames: Schema.Array(Schema.String),
	createdAt: Schema.Number,
});
export type Grant = Schema.Schema.Type<typeof Grant>;

export const ServerSummary = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	title: Schema.optional(Schema.String),
	enabled: Schema.Boolean,
	accounts: Schema.Array(
		Schema.Struct({ id: Schema.String, provider: Provider, label: Schema.String, avatarUrl: Schema.optional(Schema.String) }),
	),
	tools: ToolAccess,
	endpoint: Schema.String,
	grants: Schema.Array(Schema.Struct({ guildId: Schema.String })),
});
export type ServerSummary = Schema.Schema.Type<typeof ServerSummary>;

/** A tool as the console lists it, with the access level it implies. */
export const CatalogTool = Schema.Struct({
	name: Schema.String,
	title: Schema.String,
	description: Schema.String,
	group: Schema.String,
	access: Schema.Literals(["read", "write"]),
});
export type CatalogTool = Schema.Schema.Type<typeof CatalogTool>;

export const EMPTY_ACCESS: ToolAccess = { groups: {} };

/** A fresh id for a record. */
export function newId(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

/**
 * A URL slug from a display name.
 *
 * The name is what appears in the endpoint path, so it is lowercased and
 * stripped to characters a URL and a tool prefix can both carry.
 */
export function slugify(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40);
}
