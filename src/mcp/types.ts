import { Schema } from "effect";

/** Shared shapes for talking to an external MCP server. */

export interface McpToolSummary {
	readonly name: string;
	readonly title?: string;
	readonly description?: string;
}

/** The outcome of a probe: what the server offers, or why it refused. */
/** A sign-in with an external MCP server that has started but not finished. */
export const PendingMcpAuthSchema = Schema.Struct({
	attemptId: Schema.String,
	name: Schema.String,
	url: Schema.String,
	elicitation: Schema.optional(Schema.Literals(["off", "browser", "agent"])),
	state: Schema.String,
	authorizationUrl: Schema.optional(Schema.String),
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
	createdAt: Schema.Finite,
});

export type PendingMcpAuth = typeof PendingMcpAuthSchema.Type;

export interface McpProbeResponse {
	readonly ok: boolean;
	readonly tools: readonly McpToolSummary[];
	readonly serverName?: string;
	/** The server answered with a Bearer challenge and might sign us in. */
	readonly needsAuth?: boolean;
	readonly resourceMetadataUrl?: string;
	readonly scope?: string;
	readonly error?: string;
	readonly status?: number;
}
