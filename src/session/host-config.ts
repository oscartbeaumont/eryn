/**
 * Build the embedded OpenCode host for one guild configuration.
 *
 * The config is the guild's connected providers, its chosen model, and its
 * linked MCP servers. Everything the host needs from the deployment — the
 * plugin set, the filtered catalogue URL, the MCP servers, and the credentials
 * to replay — is assembled here, so the agent only has to decide *when* to
 * rebuild it.
 */

import type { Configuration } from "@opencode/sdk/workerd";

import { CATALOGUE_PATH } from "../catalogue";
import { log, publicOrigin } from "../config";
import { withDeploy } from "../deploy";
import type { DiscordRest } from "../discord/api";
import { describeError } from "../errors";
import {
	agentInstructionsPlugin,
	discordPlugin,
	mcpGuidancePlugin,
	workspacePlugin,
} from "../plugins";
import { createHost, type HostInterface } from "./host";
import type { DiscordContext, McpLink, ProviderConnection } from "./models";

/** Everything the host needs to be built, and to decide whether to rebuild. */
export interface HostConfig {
	readonly connections: readonly ProviderConnection[];
	readonly model: string;
	readonly links: readonly McpLink[];
}

/** The pieces of the guild object the host is built against. */
export interface HostBuildOptions {
	readonly env: Env;
	readonly storage: DurableObjectStorage;
	readonly rest: DiscordRest;
	readonly guildId: string;
	/** The directory every session in this deployment lives in. */
	readonly directory: string;
}

/**
 * Integrations that supply provider ids other than their own. The catalogue
 * filter has to keep those providers' models, or the host never sees them.
 */
const INTEGRATION_PROVIDERS: Record<string, readonly string[]> = {
	opencode: ["opencode-go"],
};

/** The shape the host's config wants for a remote MCP server. */
type RemoteMcpServer = {
	type: "remote";
	url: string;
	headers?: Record<string, string>;
	oauth: false;
};

/** POST one internal body to the bot gateway, throwing when it refuses. */
async function postToGateway(env: Env, path: string, body: Record<string, unknown>): Promise<void> {
	const stub = env.BOT_GATEWAY.get(env.BOT_GATEWAY.idFromName("bot"));
	const response = await stub.fetch(
		`https://bot.internal${path}`,
		withDeploy(env, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
	if (!response.ok) throw new Error(`the bot gateway returned HTTP ${response.status}`);
}

/** Add or remove the bot gateway's marker for a subscribed conversation. */
async function setSubscription(
	env: Env,
	guildId: string,
	kind: "thread" | "channel",
	id: string,
	subscribed: boolean,
): Promise<void> {
	await postToGateway(env, "/subscription", { guildId, kind, id, subscribed });
}

/** Add or remove the bot gateway's watch for a message that may grow a thread. */
async function setMessageSubscription(
	env: Env,
	guildId: string,
	watch: {
		readonly channelId: string;
		readonly messageId: string;
		readonly notifyThreadId?: string;
		readonly notifyTitle?: string;
		readonly notifyDiscord?: DiscordContext;
	},
	subscribed: boolean,
): Promise<void> {
	await postToGateway(env, "/message-watch", { guildId, ...watch, subscribed });
}

function mcpConfig(links: readonly McpLink[]): Configuration["mcp"] {
	const servers: Record<string, RemoteMcpServer> = {};
	for (const link of links) {
		servers[link.name] = {
			type: "remote",
			url: link.url,
			oauth: false,
			// Leave codemode unset. OpenCode uses Code Mode for normal MCP
			// servers and keeps Executor/PostHog direct because they already
			// expose their own execute tool.
			...(link.token ? { headers: { Authorization: `Bearer ${link.token}` } } : {}),
		};
	}
	return Object.keys(servers).length ? { servers } : undefined;
}

/** Signature of the provider set, so a changed or rotated credential rebuilds the host. */
export function connectionSignature(connections: readonly ProviderConnection[]): string {
	return connections
		.map((connection) => `${connection.integrationID}:${connection.method}:${connection.key}`)
		.sort()
		.join("\u0000");
}

/** Signature of the linked MCP servers, so adding one rebuilds the host. */
export function linkSignature(links: readonly McpLink[]): string {
	return links
		.map((link) => `${link.id}:${link.url}:${link.token ?? ""}`)
		.sort()
		.join("|");
}

/** Build a host for this config; the returned promise rejects if it cannot start. */
export async function buildHost(config: HostConfig, options: HostBuildOptions): Promise<HostInterface> {
	const { env, storage, rest, guildId, directory } = options;
	const location = { directory };

	// Every plugin is the promise API, which is what this host accepts.
	const plugins = [
		agentInstructionsPlugin(),
		workspacePlugin(storage),
		discordPlugin(
			rest,
			guildId,
			(kind, id, subscribed) => setSubscription(env, guildId, kind, id, subscribed),
			(watch, subscribed) => setMessageSubscription(env, guildId, watch, subscribed),
		),
	];
	const guidance = mcpGuidancePlugin(config.links.map((link) => link.name));
	if (guidance) plugins.push(guidance);

	const catalogueProviders = new Set(config.connections.map((connection) => connection.integrationID));
	for (const [integrationID, providerIDs] of Object.entries(INTEGRATION_PROVIDERS)) {
		if (!catalogueProviders.has(integrationID)) continue;
		for (const providerID of providerIDs) catalogueProviders.add(providerID);
	}

	const host = await createHost({
		storage,
		// The bundled catalogue is 7.8 MB of JSON, and decoding all of it
		// exceeds a Durable Object's memory. Ask this deployment's own
		// endpoint for the same catalogue with only the connected providers
		// keeping their models; the provider list itself stays complete.
		models: {
			snapshot: false,
			fetch: true,
			url: `${publicOrigin(env)}${CATALOGUE_PATH}/${[...catalogueProviders].join(",")}`,
		},
		config: {
			model: config.model,
			default_agent: "build",
			// Sessions are only read through the bot, so generating a title is
			// pure token overhead.
			agents: { title: { disabled: true } },
			permissions: [{ action: "*", resource: "*", effect: "allow" }],
			mcp: mcpConfig(config.links),
			experimental: { schedules: true },
		},
		plugins,
	});

	// Every provider is connected the same way: the integration the guild
	// chose and the key it gave us. The credential is supplied as an
	// integration credential, not as `providers.<id>.settings.apiKey`,
	// because only the integration store reaches provider activation.
	//
	// Connecting is idempotent: the provider records the host persists are
	// bound to a credential id, so minting a fresh credential on every host
	// build would leave every known model unreachable (`provider.no-route`)
	// after each restart. Reuse the credential for this key, and clear out
	// the duplicates earlier builds left behind.
	const credentials = await host.credential.list().catch(() => []);
	for (const connection of config.connections) {
		if (!connection.key) continue;
		const owned = credentials.filter((entry) => entry.integrationID === connection.integrationID);
		const existing = owned.find((entry) => entry.value.type === "key" && entry.value.key === connection.key);
		try {
			if (!existing) {
				await host.integration.connect.key({
					integrationID: connection.integrationID,
					key: connection.key,
					location,
				});
				continue;
			}
			if (!existing.active) await host.credential.activate({ credentialID: existing.id });
			for (const stale of owned) {
				if (stale.id === existing.id) continue;
				if (stale.value.type !== "key" || stale.value.key !== connection.key) continue;
				await host.credential.remove({ credentialID: stale.id }).catch(() => undefined);
			}
		} catch (error) {
			log("session", `could not connect ${connection.integrationID}: ${describeError(error)}`);
		}
	}
	return host;
}
