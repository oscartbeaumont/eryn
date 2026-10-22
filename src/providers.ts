/**
 * The provider catalogue's shape.
 *
 * Shared by the session object that builds it, the Worker that proxies it, and
 * (mirrored in `client/api.ts`) the console that renders it. Nothing here knows
 * which providers exist: the list comes from the embedded OpenCode server, so
 * this only describes how one is presented.
 */

/** One way a provider can be connected, as the host itself describes it. */
export interface IntegrationMethodOption {
	type: string;
	/** OAuth methods are addressed by id when a flow is started. */
	id?: string;
	label: string;
	/**
	 * Whether this deployment can run the flow. `key` and `oauth` can; `env`,
	 * `command`, and `external` cannot inside a Worker, and the console says so
	 * rather than offering something that would fail.
	 */
	supported: boolean;
	/** What the flow needs before it can start, such as a deployment type. */
	fields?: ProviderField[];
}

/**
 * One input a flow needs before it can start.
 *
 * The provider declares these, not Eryn, so a provider that needs an extra
 * detail gets a form without any change here. Only the field kinds a Worker can
 * render are described: anything else marks the flow unavailable rather than
 * asking for something that cannot be collected.
 */
export interface ProviderField {
	key: string;
	type: "string" | "number" | "integer" | "boolean";
	title?: string;
	description?: string;
	placeholder?: string;
	required?: boolean;
	default?: string | number | boolean;
	/** A string field restricted to a fixed set of choices. */
	options?: { value: string; label: string; description?: string }[];
	/** Only ask for this field while these conditions hold. */
	when?: { key: string; op: "eq" | "neq"; value: string | number | boolean }[];
}

/** A provider a guild could connect, and what connecting it would take. */
export interface IntegrationOption {
	id: string;
	name: string;
	connected: boolean;
	methods: IntegrationMethodOption[];
}

/** A sign-in the host has started, and where to send the user. */
export interface OAuthAttempt {
	attemptID: string;
	url: string;
	instructions: string;
	/** `auto` finishes on its own; `code` needs the code the provider showed. */
	mode: "auto" | "code";
}

/** How a sign-in attempt is doing. */
export interface OAuthAttemptStatus {
	status: "pending" | "complete" | "failed" | "expired";
	message?: string;
}
