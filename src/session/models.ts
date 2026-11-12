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

/** What a schedule may do in one Discord channel. */
export const ScheduleChannelScopeSchema = Schema.Struct({
	read: Schema.Boolean,
	send: Schema.Boolean,
	/** Absent on scopes stored before inherited threads needed this bit. */
	sendInThreads: Schema.optional(Schema.Boolean),
	manage: Schema.Boolean,
	/** Absent on scopes stored before thread creation was a capability. */
	createThread: Schema.optional(Schema.Boolean),
	/** Absent on scopes stored before reactions were a capability. */
	react: Schema.optional(Schema.Boolean),
});

/**
 * A schedule's Discord capability scope.
 *
 * One scope covers every schedule in a conversation. It is persisted beside
 * the Discord context rather than rendered into the prompt: it is an
 * authorization input, not something the model needs to see.
 */
export const ScheduleScopeSchema = Schema.Struct({
	/** The person who created the schedules, for scope edits and audit. */
	ownerId: Schema.String,
	scheduleIds: Schema.Array(Schema.String),
	channels: Schema.Record(Schema.String, ScheduleChannelScopeSchema),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
});
export type ScheduleScope = typeof ScheduleScopeSchema.Type;

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
	/**
	 * The Discord account that prompted the current turn.
	 *
	 * The Discord tools act with the bot's token, which can reach more than the
	 * person talking to Eryn. This id is what lets them hold the turn to the
	 * speaker's own permissions. A scheduled turn has no speaker, so the field
	 * is absent and cross-channel actions are refused.
	 */
	authorId: Schema.optional(Schema.String),
	/**
	 * Whether the current turn was started by a schedule rather than a person.
	 *
	 * Set when the turn's latest message is the wake message the schedule
	 * runner created for this session (matched by id, not by time). A human
	 * prompt clears it.
	 */
	scheduleTurn: Schema.optional(Schema.Boolean),
	/** The capability scope every schedule in this conversation runs under. */
	scheduleScope: Schema.optional(ScheduleScopeSchema),
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
	/** Where this server's approval or input question is answered. */
	elicitation: Schema.optional(Schema.Literals(["off", "discord", "browser", "agent"])),
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
	elicitation: Schema.optional(Schema.Literals(["off", "discord", "browser", "agent"])),
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
	/** Carried across the browser round trip so the finished link keeps it. */
	elicitation: Schema.optional(Schema.Literals(["off", "discord", "browser", "agent"])),
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

export const McpAuthStartResponseSchema = Schema.Struct({
	ok: Schema.optional(Schema.Boolean),
	attemptId: Schema.optional(Schema.String),
	url: Schema.optional(Schema.String),
	/** The short signed link that forwards the browser to `url`. */
	startUrl: Schema.optional(Schema.String),
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

// --- Conversation policy -------------------------------------------------------

/**
 * What a tool group may do.
 *
 * `allow` runs without asking, `ask` posts a card in the conversation, and
 * `block` hides the tool from the agent entirely.
 */
export const PolicyEffectSchema = Schema.Literals(["allow", "ask", "block"]);
export type PolicyEffect = typeof PolicyEffectSchema.Type;

/**
 * The built-in starting points.
 *
 * `standard` is the server default: web search and the shell are enabled, but
 * Eryn cannot reach other channels. `full` is every capability, `none` is no
 * capabilities at all. `chat`, `read-only`, and `locked` are kept so a policy
 * stored by an older build still resolves to the profile it chose.
 */
export const PolicyPresetSchema = Schema.Literals([
	"standard",
	"full",
	"none",
	"chat",
	"read-only",
	"locked",
]);
export type PolicyPreset = typeof PolicyPresetSchema.Type;

/** How an approval or MCP input request is delivered. */
export const ElicitationModeSchema = Schema.Literals(["off", "discord", "browser", "agent"]);
export type ElicitationMode = typeof ElicitationModeSchema.Type;

/**
 * One scope's policy patch.
 *
 * A patch is sparse: only the values an admin chose at this scope. The
 * effective policy is built by layering server, channel, and thread patches,
 * then expanding a preset into the groups it implies.
 */
export const PolicySchema = Schema.Struct({
	/** A built-in or custom profile this scope selects. */
	profile: Schema.optional(Schema.String),
	/** The older name for the same idea; still read, never written. */
	preset: Schema.optional(PolicyPresetSchema),
	/** Group or exact tool name to an effect. */
	tools: Schema.optional(Schema.Record(Schema.String, PolicyEffectSchema)),
	/** MCP server name to an effect; `*` is every server. */
	mcp: Schema.optional(Schema.Record(Schema.String, PolicyEffectSchema)),
	elicitation: Schema.optional(ElicitationModeSchema),
	updatedAt: Schema.optional(Schema.Number),
});
export type Policy = typeof PolicySchema.Type;

/**
 * A named permission profile, owned by the server.
 *
 * Built-in profiles are returned by the API but not stored here; a custom
 * profile is a complete set of group and MCP effects, so it can be selected by
 * any channel without knowing how it was built.
 */
export const PolicyProfileSchema = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	tools: Schema.Record(Schema.String, PolicyEffectSchema),
	mcp: Schema.Record(Schema.String, PolicyEffectSchema),
	/** Built-in profiles never appear in storage; this marks the API copy. */
	builtin: Schema.optional(Schema.Boolean),
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
});
export type PolicyProfile = typeof PolicyProfileSchema.Type;

/** What the policy menu reads: the scope, its own patch, and the layered result. */
export const PolicyStateSchema = Schema.Struct({
	scope: Schema.Literals(["guild", "channel", "thread"]),
	channelId: Schema.String,
	threadId: Schema.optional(Schema.String),
	/** The patch stored at this scope, before inheritance. */
	own: Schema.optional(PolicySchema),
	/** The resolved result after inheritance and profile expansion. */
	effective: PolicySchema,
	/** The MCP servers the policy can name. */
	mcpServers: Schema.Array(Schema.String),
	/** Built-in and custom profiles a channel may select. */
	profiles: Schema.Array(PolicyProfileSchema),
	/** The profile the server uses when a channel has no override. */
	defaultProfile: Schema.String,
});
export type PolicyState = typeof PolicyStateSchema.Type;

/** The profiles a server owns, and the one it uses by default. */
export const ProfilesStateSchema = Schema.Struct({
	profiles: Schema.Array(PolicyProfileSchema),
	defaultProfile: Schema.String,
});
export type ProfilesState = typeof ProfilesStateSchema.Type;

/** Where a policy card lives, so a later edit can replace it. */
export const PolicyCardSchema = Schema.Struct({
	channelId: Schema.String,
	messageId: Schema.String,
});
export type PolicyCard = typeof PolicyCardSchema.Type;

/** The policy applied to a conversation after a change, for callers to render. */
export const PolicyChangeResponseSchema = Schema.Struct({
	ok: Schema.Boolean,
	state: PolicyStateSchema,
	message: Schema.optional(Schema.String),
});
export type PolicyChangeResponse = typeof PolicyChangeResponseSchema.Type;

/** One choice an MCP form offers, with the value the server expects back. */
export const FormFieldOptionSchema = Schema.Struct({
	value: Schema.String,
	label: Schema.String,
	description: Schema.optional(Schema.String),
});
export type FormFieldOption = typeof FormFieldOptionSchema.Type;

/** One field an MCP form asks for, as Discord can render it. */
export const FormFieldSchema = Schema.Struct({
	key: Schema.String,
	title: Schema.String,
	type: Schema.String,
	required: Schema.Boolean,
	description: Schema.optional(Schema.String),
	placeholder: Schema.optional(Schema.String),
	url: Schema.optional(Schema.String),
	options: Schema.optional(Schema.Array(FormFieldOptionSchema)),
	/** Whether the server accepts a value outside `options`. */
	custom: Schema.optional(Schema.Boolean),
	minItems: Schema.optional(Schema.Number),
	maxItems: Schema.optional(Schema.Number),
});
export type FormField = typeof FormFieldSchema.Type;

/** A form as the Discord side sees it: the questions, not the UI controls. */
export const FormViewSchema = Schema.Struct({
	id: Schema.String,
	title: Schema.String,
	fields: Schema.Array(FormFieldSchema),
	/** Indices of the fields already answered in the conversation. */
	answered: Schema.Array(Schema.Number),
});
export type FormView = typeof FormViewSchema.Type;

// --- Provider catalogue --------------------------------------------------------

/** The parts of a provider form field every kind shares. */
const ProviderFieldBase = {
	key: Schema.String,
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
};

/** One way a provider can be connected, as the host describes it. */
export const ProviderFieldSchema = Schema.Struct({
	...ProviderFieldBase,
	type: Schema.Literals(["string", "number", "integer", "boolean"]),
});
export type ProviderField = typeof ProviderFieldSchema.Type;

/**
 * A field as the host describes it, before this deployment decides whether a
 * Discord modal can render it. The type is left open so an unsupported field is
 * reported rather than making the whole method unreadable.
 */
export const HostProviderFieldSchema = Schema.Struct({
	...ProviderFieldBase,
	type: Schema.String,
});
export type HostProviderField = typeof HostProviderFieldSchema.Type;

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

/** A request body that names the guild it is for, which the object verifies. */
function guildScoped<Fields extends Schema.Struct.Fields>(fields: Fields) {
	return Schema.Struct({ guildId: Schema.String, ...fields });
}

export const GuildRefSchema = guildScoped({});

export const ProviderConnectRequestSchema = guildScoped({
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

export const ModelRequestSchema = guildScoped({ model: Schema.String });

export const DisconnectRequestSchema = guildScoped({ integrationID: Schema.String });

export const LinkAddRequestSchema = guildScoped({ link: McpLinkSchema });
export const LinkRemoveRequestSchema = guildScoped({ linkId: Schema.String });
export const McpProbeRequestSchema = guildScoped({
	url: Schema.String,
	token: Schema.optional(Schema.String),
});
export const McpTestRequestSchema = guildScoped({ linkId: Schema.String });
export const McpAuthStartRequestSchema = guildScoped({
	name: Schema.String,
	url: Schema.String,
	elicitation: Schema.optional(Schema.Literals(["off", "discord", "browser", "agent"])),
	applicationId: Schema.optional(Schema.String),
	interactionToken: Schema.optional(Schema.String),
	/** The `resource_metadata` URL from the server's challenge, when it gave one. */
	resourceMetadataUrl: Schema.optional(Schema.String),
	scope: Schema.optional(Schema.String),
});
export const McpAuthAttemptRequestSchema = guildScoped({
	attemptId: Schema.String,
});
export const McpAuthCompleteRequestSchema = guildScoped({
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

export const PromptRequestSchema = guildScoped({
	threadId: Schema.String,
	title: Schema.optional(Schema.String),
	text: Schema.String,
	/** The speaker's name, handle, and Discord id, so the agent knows who is talking. */
	author: Schema.optional(PromptUserSchema),
	/** Other users or bots mentioned in the message. */
	mentions: Schema.optional(Schema.Array(PromptUserSchema)),
	/** Where the request came from in Discord, recorded on the session. */
	discord: Schema.optional(DiscordContextSchema),
	/**
	 * An automated Discord notice to put in front of the message, such as a
	 * rename. Kept separate so it is not attributed to the speaker.
	 */
	notice: Schema.optional(Schema.String),
	/** Files attached to the message, for the model to read. */
	attachments: Schema.optional(Schema.Array(PromptAttachmentSchema)),
});
export type PromptRequest = typeof PromptRequestSchema.Type;

/** Run one of this guild's OpenCode commands. */
export const CommandRequestSchema = guildScoped({
	threadId: Schema.String,
	title: Schema.optional(Schema.String),
	/** The OpenCode command name, such as `review` or `team/review`. */
	command: Schema.String,
	/** The raw argument text the command template expands. */
	text: Schema.String,
	author: Schema.optional(PromptUserSchema),
	discord: Schema.optional(DiscordContextSchema),
});
export type CommandRequest = typeof CommandRequestSchema.Type;

export const CommandResponseSchema = Schema.Struct({
	ok: Schema.Boolean,
	message: Schema.optional(Schema.String),
});
export type CommandResponse = typeof CommandResponseSchema.Type;

/** List the commands available in one conversation's project. */
export const CommandListRequestSchema = guildScoped({
	channelId: Schema.optional(Schema.String),
});

export const CommandInfoSchema = Schema.Struct({
	name: Schema.String,
	description: Schema.optional(Schema.String),
});
export type CommandInfo = typeof CommandInfoSchema.Type;

export const CommandListResponseSchema = Schema.Struct({
	commands: Schema.Array(CommandInfoSchema),
});

/**
 * A fresh description of a conversation, written when Discord renames it.
 *
 * The gateway sends the same {@link DiscordContext} it records on prompts, so
 * the session object can correct the stored copy before the next turn.
 */
export const ContextUpdateRequestSchema = guildScoped({
	threadId: Schema.String,
	discord: DiscordContextSchema,
});

export const InterruptRequestSchema = Schema.Struct({
	threadId: Schema.String,
	gone: Schema.optional(Schema.Boolean),
});

/** Whether one Discord user may take part in a scheduled conversation. */
export const InteractRequestSchema = guildScoped({
	threadId: Schema.String,
	userId: Schema.String,
});

export const InteractResponseSchema = Schema.Struct({
	ok: Schema.Boolean,
	message: Schema.optional(Schema.String),
});
export type InteractResponse = typeof InteractResponseSchema.Type;

/** Trigger a manual compaction of one conversation's history. */
export const CompactRequestSchema = guildScoped({
	threadId: Schema.String,
});

export const CompactResponseSchema = Schema.Struct({
	ok: Schema.Boolean,
	message: Schema.optional(Schema.String),
});
export type CompactResponse = typeof CompactResponseSchema.Type;

/** The number of files removed before the defaults were restored. */
export const ResetResponseSchema = Schema.Struct({
	files: Schema.Number,
});
export type ResetResponse = typeof ResetResponseSchema.Type;

export const PolicyGetRequestSchema = guildScoped({
	channelId: Schema.String,
	threadId: Schema.optional(Schema.String),
});

export const PolicySetRequestSchema = guildScoped({
	scope: Schema.Literals(["guild", "channel", "thread"]),
	channelId: Schema.String,
	threadId: Schema.optional(Schema.String),
	policy: PolicySchema,
});

export const PolicyClearRequestSchema = guildScoped({
	scope: Schema.Literals(["guild", "channel", "thread"]),
	channelId: Schema.String,
	threadId: Schema.optional(Schema.String),
});

/** Create or replace one custom profile. Built-in ids are refused. */
export const ProfileSetRequestSchema = guildScoped({
	id: Schema.String,
	name: Schema.String,
	tools: Schema.Record(Schema.String, PolicyEffectSchema),
	mcp: Schema.Record(Schema.String, PolicyEffectSchema),
});

export const ProfileRemoveRequestSchema = guildScoped({ id: Schema.String });

/** Pick the profile every channel inherits. */
export const ProfileDefaultRequestSchema = guildScoped({ id: Schema.String });

/** A decision on an approval card. `block` also writes a deny rule. */
export const ApprovalReplyRequestSchema = guildScoped({
	threadId: Schema.String,
	requestId: Schema.String,
	decision: Schema.Literals(["once", "always", "block"]),
	userId: Schema.optional(Schema.String),
	manager: Schema.optional(Schema.Boolean),
});

export const ApprovalReplyResponseSchema = Schema.Struct({
	ok: Schema.Boolean,
	message: Schema.optional(Schema.String),
});

export const FormGetRequestSchema = guildScoped({
	formId: Schema.String,
	userId: Schema.optional(Schema.String),
	manager: Schema.optional(Schema.Boolean),
});

export const FormReplyRequestSchema = guildScoped({
	formId: Schema.String,
	/** Keyed `f0`, `f1`, … in field order; the agent maps them back. */
	values: Schema.Record(Schema.String, Schema.String),
	/** Submit even when optional fields are still unanswered. */
	submit: Schema.optional(Schema.Boolean),
	userId: Schema.optional(Schema.String),
	manager: Schema.optional(Schema.Boolean),
});

export const FormCancelRequestSchema = guildScoped({
	formId: Schema.String,
	userId: Schema.optional(Schema.String),
	manager: Schema.optional(Schema.Boolean),
});

/**
 * Answer one field of a form from a button or select.
 *
 * `option` is the index into the field's own options, never a client-supplied
 * value: the session maps it back, so a crafted id cannot submit an option the
 * server did not offer. `values` is the select-menu form, which Discord sends
 * as values rather than indices.
 */
export const FormFieldRequestSchema = guildScoped({
	formId: Schema.String,
	field: Schema.Number,
	option: Schema.optional(Schema.Number),
	values: Schema.optional(Schema.Array(Schema.String)),
	userId: Schema.optional(Schema.String),
	manager: Schema.optional(Schema.Boolean),
});

/** A message answering the next free-text field of a form. */
export const FormTextRequestSchema = guildScoped({
	threadId: Schema.String,
	userId: Schema.String,
	text: Schema.String,
});

export const FormTextResponseSchema = Schema.Struct({
	/** Whether the message was a form answer, rather than a new request. */
	consumed: Schema.Boolean,
	message: Schema.optional(Schema.String),
});
export type FormTextResponse = typeof FormTextResponseSchema.Type;

export const FormReplyResponseSchema = Schema.Struct({
	ok: Schema.Boolean,
	message: Schema.optional(Schema.String),
});
