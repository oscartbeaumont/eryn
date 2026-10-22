/**
 * Typed access to the guild registry for the Worker and the gateway object.
 * Everything funnels through the single `ErynRegistry` instance.
 */

import type { DiscordGuild } from "./oauth";
import {
	USER_GUILDS_TTL_MS,
	type GitHubBinding,
	type GuildConnection,
	type GuildSummary,
} from "./registry";

/** Everything a turn needs from a guild: its providers, its model, its GitHub. */
export interface GuildConfig {
	connections: GuildConnection[];
	model: string;
	github?: GitHubBinding;
}

/** What a save may change. Connect and disconnect are applied, not replaced. */
export interface GuildUpdate {
	model?: string;
	configuredBy?: string;
	githubRepo?: string;
	githubInstallationId?: string;
	connect?: GuildConnection[];
	disconnect?: string[];
}

function stub(env: Env) {
	return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

/** The plaintext credentials for a guild, or `undefined` when unconfigured. */
export async function getGuildConfig(env: Env, guildId: string): Promise<GuildConfig | undefined> {
	const response = await stub(env).fetch(`https://eryn/registry/guild/${guildId}/key`);
	if (!response.ok) return undefined;
	const body = await response.json<GuildConfig>();
	return Array.isArray(body?.connections) && body.connections.length > 0 ? body : undefined;
}

/** Configuration status for the console, without any credential. */
export async function getGuildSummary(env: Env, guildId: string): Promise<GuildSummary> {
	const response = await stub(env).fetch(`https://eryn/registry/guild/${guildId}`);
	if (!response.ok) return { configured: false, connections: [] };
	const summary = await response.json<GuildSummary>();
	return { ...summary, connections: summary.connections ?? [] };
}

export async function putGuild(env: Env, guildId: string, input: GuildUpdate): Promise<void> {
	const response = await stub(env).fetch(`https://eryn/registry/guild/${guildId}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `registry rejected the change (HTTP ${response.status})`);
	}
}

export async function removeGuild(env: Env, guildId: string): Promise<void> {
	await stub(env).fetch(`https://eryn/registry/guild/${guildId}`, { method: "DELETE" });
}

/** Record a GitHub App installation id captured from the install callback. */
export async function setGuildInstallation(env: Env, guildId: string, installationId: string): Promise<void> {
	await putGuild(env, guildId, { githubInstallationId: installationId });
}

/** The cached guild list for a signed-in user, or `undefined` when stale. */
export async function getUserGuilds(env: Env, userId: string): Promise<DiscordGuild[] | undefined> {
	const response = await stub(env).fetch(`https://eryn/registry/user/${userId}/guilds`);
	if (!response.ok) return undefined;
	const body = (await response.json()) as { guilds?: unknown };
	return Array.isArray(body.guilds) ? (body.guilds as DiscordGuild[]) : undefined;
}

/** Cache a user's guild list so `/console` does not call Discord on every load. */
export async function putUserGuilds(env: Env, userId: string, guilds: DiscordGuild[]): Promise<void> {
	await stub(env).fetch(`https://eryn/registry/user/${userId}/guilds`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ guilds, expiresAt: Date.now() + USER_GUILDS_TTL_MS }),
	});
}
