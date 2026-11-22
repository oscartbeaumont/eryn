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
