/** Records the server object keeps beyond its shared schemas. */

import { Schema } from "effect";

/** One channel project: its OpenCode session and its message subscription. */
export const ChannelRecordSchema = Schema.Struct({
	channelId: Schema.String,
	provider: Schema.String,
	name: Schema.optional(Schema.String),
	containerId: Schema.optional(Schema.String),
	sessionID: Schema.optional(Schema.String),
	automationID: Schema.optional(Schema.String),
	createdAt: Schema.Finite,
});

export type ChannelRecord = typeof ChannelRecordSchema.Type;

/** A provider OAuth attempt that has started and not finished. */
export const PendingOAuthSchema = Schema.Struct({
	integrationID: Schema.String,
	attemptID: Schema.String,
	url: Schema.String,
	instructions: Schema.String,
	mode: Schema.Literals(["auto", "code"]),
	createdAt: Schema.Finite,
});

export type PendingOAuth = typeof PendingOAuthSchema.Type;
