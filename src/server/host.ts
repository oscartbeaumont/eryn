/**
 * Build the embedded OpenCode host for a server.
 *
 * The host is assembled from persistent state — inference credentials, MCP
 * links, plugins, and the server files — so a rebuild is reproducible. Channel
 * context and the channel project directory are resolved per session, which is
 * what gives every channel its own OpenCode project without a host per channel.
 */

import { CATALOGUE_PATH } from "../catalogue.ts";
import { configuredOrigin, log } from "../config.ts";
import { SERVER_ROOT } from "../core/paths.ts";
import type { McpLink, PluginRecord, ProviderConnection } from "../core/schema.ts";
import { describeError } from "../errors.ts";
import { mintMcpToken } from "../mcp/token.ts";
import { commandShellPlugin } from "../plugins/commands/index.ts";
import { dynamicPluginsPlugin } from "../plugins/dynamic/index.ts";
import { agentInstructionsPlugin } from "../plugins/instructions/index.ts";
import { policyPlugin } from "../plugins/policy/index.ts";
import type { PermissionSet, SessionGrants } from "../core/policy.ts";
import { workspaceSkillsPlugin } from "../plugins/skills/index.ts";
import { workspacePlugin } from "../plugins/workspace/index.ts";
import { createHost } from "../agent/host.ts";
import type { HostInterface } from "../agent/host.ts";
import { seedServer } from "./seed.ts";
import { channelInstructions, readWorkspaceConfig, workspaceSignature } from "./workspace.ts";
import type { WorkspaceConfig } from "./workspace.ts";

export interface HostConfig {
	readonly connections: readonly ProviderConnection[];
	readonly model: string;
	readonly links: readonly McpLink[];
	readonly plugins: readonly PluginRecord[];
	readonly workspace: string;
}

export interface HostOptions {
	readonly env: Env;
	readonly storage: DurableObjectStorage;
	readonly serverId: string;
	readonly origin: string;
	/** The channel project root for a session, resolved at tool-call time. */
	readonly rootForSession: (sessionID: string) => string;
	/** The conversation and resolved permissions for a session. */
	readonly contextFor: (
		sessionID: string,
	) => Promise<{ readonly channel: string; readonly permissions: PermissionSet } | undefined>;
	/** Grants written by an `always` approval in this session. */
	readonly grantFor: (sessionID: string) => SessionGrants | undefined;
}

interface McpConfigEntry {
	type: "remote";
	url: string;
	oauth: false;
	codemode?: boolean;
	headers?: { Authorization: string };
}

/** Provider ids an integration also exposes models under. */
const INTEGRATION_PROVIDERS = {
	opencode: ["opencode-go"],
} as const;

function catalogueProviderIds(connections: readonly ProviderConnection[]): Set<string> {
	const connected = new Set(connections.map((connection) => connection.integrationID));
	const aliases = Object.entries(INTEGRATION_PROVIDERS).flatMap(([integrationID, ids]) =>
		connected.has(integrationID) ? [...ids] : [],
	);

	return new Set([...connected, ...aliases]);
}

/** Replay each stored key as an integration credential, reusing one per key. */
async function connectCredentials(
	host: HostInterface,
	connections: readonly ProviderConnection[],
): Promise<void> {
	const credentials = await host.credential.list().catch(() => []);

	for (const connection of connections) {
		if (!connection.key) continue;
		const owned = credentials.filter((entry) => entry.integrationID === connection.integrationID);
		const existing = owned.find(
			(entry) => entry.value.type === "key" && entry.value.key === connection.key,
		);

		try {
			if (!existing) {
				await host.integration.connect.key({
					integrationID: connection.integrationID,
					key: connection.key,
					location: { directory: SERVER_ROOT },
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
			log("server", "could not connect " + connection.integrationID + ": " + describeError(error));
		}
	}
}

/** Build a host for this config; the returned promise rejects if it cannot start. */
export async function buildHost(config: HostConfig, options: HostOptions): Promise<HostInterface> {
	const { env, storage, serverId, origin, rootForSession } = options;

	await seedServer(storage, serverId);
	const workspace: WorkspaceConfig = await readWorkspaceConfig(storage);
	const activeSkills = new Map<string, string>();
	const token = await mintMcpToken(env, serverId);

	if (!token) throw new Error("SESSION_SECRET and ENCRYPTION_KEY are not configured.");

	const plugins = [
		workspacePlugin({ storage, serverRoot: SERVER_ROOT, rootForSession, activeSkills }),
		commandShellPlugin(storage, rootForSession),
		policyPlugin({
			contextFor: options.contextFor,
			grantFor: options.grantFor,
			mcpServers: config.links.map((link) => link.name),
		}),
		agentInstructionsPlugin(
			() => workspace.instructions,
			async (sessionID) => {
				const root = rootForSession(sessionID);

				if (root === SERVER_ROOT) return undefined;
				const channelId = root.slice(root.lastIndexOf("/") + 1);

				return await channelInstructions(storage, channelId);
			},
		),
	];
	const skills = workspaceSkillsPlugin(workspace.skills, activeSkills);

	if (skills) plugins.push(skills);

	const internal: McpLink = {
		id: "eryn",
		name: "eryn",
		url: origin + "/mcp/" + serverId,
		token,
		createdAt: Date.now(),
	};
	const mcp = new Map<string, McpConfigEntry>();

	for (const link of [...config.links, internal]) {
		const entry: McpConfigEntry = { type: "remote", url: link.url, oauth: false };

		if (link.token) entry.headers = { Authorization: "Bearer " + link.token };
		if (link.name === "eryn") entry.codemode = false;
		mcp.set(link.name, entry);
	}

	const custom = dynamicPluginsPlugin(env, config.plugins);

	if (custom) plugins.push(custom);

	const connected = catalogueProviderIds(config.connections);
	const host = await createHost({
		storage,
		models: {
			snapshot: false,
			fetch: true,
			url: origin + CATALOGUE_PATH + "/" + [...connected].join(","),
		},
		config: {
			...workspace.config,
			mcp: Object.fromEntries(mcp),
		},
		plugins,
	});

	await connectCredentials(host, config.connections);
	await connectInternalMcp(host);

	return host;
}

/** Connect the messaging MCP server before the agent needs its first event. */
async function connectInternalMcp(host: HostInterface): Promise<void> {
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			await host.mcp.connect({ server: "eryn" });

			return;
		} catch (error) {
			if (attempt === 4) {
				log("server", "could not connect the internal MCP server: " + describeError(error));

				return;
			}

			await new Promise<void>((resolve) => {
				setTimeout(resolve, 250);
			});
		}
	}
}

/** Re-read the workspace signature. */
export async function hostSignature(storage: DurableObjectStorage): Promise<string> {
	return await workspaceSignature(storage);
}

/** The public origin, learned from a request when the deployment has none. */
export function originOf(env: Env, served: string | undefined): string | undefined {
	return configuredOrigin(env) ?? served?.replace(/\/$/, "");
}
