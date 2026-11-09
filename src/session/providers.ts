/**
 * Project the host's provider catalogue onto what the bot can show and choose.
 *
 * The host describes integrations, sign-in methods, and models in its own
 * vocabulary. This module decodes those descriptions into the small records the
 * setup flow renders, and picks a runnable model from the catalogue. Everything
 * here is pure: it never builds a host or talks to one.
 */

import { Option, Schema } from "effect";

import {
	HostProviderFieldSchema,
	type HostProviderField,
	type IntegrationMethodOption,
	type ModelOption,
	type ProviderField,
} from "./models";

/**
 * One way a provider can be connected, as far as this deployment can use it.
 *
 * Only the kinds a Discord modal can render are recognised. The union is
 * decoded rather than trusted, and a flow with any other field is reported as
 * unavailable instead of being offered and then failing.
 */
const HostMethodSchema = Schema.Union([
	Schema.Struct({ type: Schema.Literal("key"), label: Schema.optional(Schema.String) }),
	Schema.Struct({
		type: Schema.Literal("oauth"),
		id: Schema.String,
		label: Schema.String,
		form: Schema.optional(Schema.Array(HostProviderFieldSchema)),
	}),
	Schema.Struct({ type: Schema.Literal("env"), names: Schema.Array(Schema.String) }),
	Schema.Struct({ type: Schema.Literal("command"), id: Schema.String, label: Schema.String }),
	Schema.Struct({ type: Schema.Literal("external"), id: Schema.String, label: Schema.String }),
]);
type HostMethod = typeof HostMethodSchema.Type;

/** The field kinds a Discord modal can render, or `undefined` for the rest. */
function renderableType(type: string): ProviderField["type"] | undefined {
	switch (type) {
		case "string":
		case "number":
		case "integer":
		case "boolean":
			return type;
		default:
			return undefined;
	}
}

/** Project one form field, or `undefined` when a modal cannot render its kind. */
function describeField(field: HostProviderField): ProviderField | undefined {
	const type = renderableType(field.type);
	if (!type) return undefined;
	const common = {
		key: field.key,
		...(field.title ? { title: field.title } : {}),
		...(field.description ? { description: field.description } : {}),
		...(field.required ? { required: true } : {}),
		...(field.when ? { when: field.when } : {}),
	};
	if (type !== "string") {
		return { ...common, type, ...(field.default === undefined ? {} : { default: field.default }) };
	}
	return {
		...common,
		type,
		...(field.placeholder ? { placeholder: field.placeholder } : {}),
		...(typeof field.default === "string" ? { default: field.default } : {}),
		...(field.options ? { options: field.options } : {}),
	};
}

/**
 * Which flows this deployment can run.
 *
 * `key` is a secret we can hold and replay, and `oauth` is a browser round trip
 * the host performs. The rest cannot work here, and are reported rather than
 * hidden so the setup command can say why a provider cannot be connected.
 */
function describeMethod(method: HostMethod): IntegrationMethodOption | undefined {
	switch (method.type) {
		case "key":
			return { type: "key", label: method.label?.trim() || "API key", supported: true };
		case "oauth": {
			const form = method.form ?? [];
			const fields = form.map(describeField);
			return {
				type: "oauth",
				id: method.id,
				label: method.label.trim() || "Sign in",
				supported: fields.every((field) => field !== undefined),
				fields: fields.filter((field): field is ProviderField => field !== undefined),
			};
		}
		case "env":
			return {
				type: "env",
				label: method.names.length ? `Environment variable (${method.names.join(", ")})` : "Environment variable",
				supported: false,
			};
		case "command":
			return { type: "command", label: method.label.trim() || "Run a command", supported: false };
		case "external":
			return { type: "external", label: method.label.trim() || "External credential", supported: false };
	}
}

/** The integration's methods, skipping any the host described in a shape we cannot read. */
export function describeMethods(methods: unknown): IntegrationMethodOption[] {
	if (!Array.isArray(methods)) return [];
	return methods.flatMap((value) => {
		const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(HostMethodSchema)(value));
		const described = parsed ? describeMethod(parsed) : undefined;
		return described ? [described] : [];
	});
}

/**
 * Whether a sign-in sends the browser back to the machine running this Worker.
 *
 * Several of OpenCode's provider flows open a listener on `127.0.0.1` and wait
 * for the provider to redirect to it. That cannot work here: a Worker has no
 * inbound socket, and the address names the *caller's* machine. The only trace
 * is the redirect in the URL the flow hands back, so that is what is inspected.
 */
export function needsLocalCallback(url: string): boolean {
	try {
		const redirect = new URL(url).searchParams.get("redirect_uri");
		if (!redirect) return false;
		const host = new URL(redirect).hostname.toLowerCase().replace(/^\[|\]$/g, "");
		return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "0.0.0.0";
	} catch {
		return false;
	}
}

/** Split a stored `provider/model` reference for the session API. */
export function parseModelRef(model: string): { providerID: string; id: string } | undefined {
	const at = model.indexOf("/");
	if (at <= 0 || at === model.length - 1) return undefined;
	return { providerID: model.slice(0, at), id: model.slice(at + 1) };
}

/** Models preferred when a guild has not chosen one (or chose a free one). */
const PREFERRED_MODELS = [
	"deepseek-v4.1-flash",
	"claude-sonnet-4-5",
	"claude-sonnet-4-6",
	"gpt-5",
	"gpt-5.1",
	"gemini-2.5-pro",
];

/**
 * The model a turn should use, given the guild's stored choice.
 *
 * A guild can connect a provider while the stored model still names another
 * one — the default names `opencode-go`, but a guild may have connected
 * `opencode`. That model cannot run, and the turn would produce nothing, so
 * fall back to a model from a provider that is actually connected. A `-free`
 * model is treated the same way: it is the host's fallback rather than a choice
 * worth keeping, and the provider the guild connected has real models.
 */
export async function resolveModelChoice(
	current: string,
	directlyConnected: boolean,
	loadModels: () => Promise<readonly ModelOption[]>,
): Promise<string> {
	const free = /-free$/i.test(current);
	if (directlyConnected && !free) return current;
	const models = await loadModels();
	// An integration can supply providers beyond its own id, such as OpenCode
	// Console supplying OpenCode Go.
	if (!free && models.some((entry) => entry.id === current && entry.connected)) return current;

	const candidates = models.filter((entry) => entry.connected && entry.enabled);
	const preferred = PREFERRED_MODELS.map((name) => candidates.find((entry) => entry.id.endsWith(`/${name}`))).find(
		(entry) => entry !== undefined,
	);
	const fallback =
		preferred ??
		candidates.find((entry) => !/-free$/i.test(entry.id)) ??
		candidates[0] ??
		models.find((entry) => entry.connected);
	return fallback?.id ?? current;
}
