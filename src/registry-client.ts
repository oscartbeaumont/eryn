/**
 * Typed access to the guild registry for the Worker and the gateway object.
 * Everything funnels through the single `ErynRegistry` instance.
 */

import type { DiscordGuild } from "./oauth";
import { USER_GUILDS_TTL_MS, type GitHubBinding, type GuildSummary } from "./registry";

export interface GuildKey {
	apiKey: string;
	model: string;
	github?: GitHubBinding;
}

function stub(env: Env) {
	return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

/** The plaintext credential for a guild, or `undefined` when unconfigured. */
export async function getGuildKey(env: Env, guildId: string): Promise<GuildKey | undefined> {
	const response = await stub(env).fetch(`https://eryn/registry/guild/${guildId}/key`);
	if (!response.ok) return undefined;
	return await response.json<GuildKey>();
}

/** Configuration status for the setup UI, without the key. */
export async function getGuildSummary(env: Env, guildId: string): Promise<GuildSummary> {
	const response = await stub(env).fetch(`https://eryn/registry/guild/${guildId}`);
	if (!response.ok) return { configured: false };
	return await response.json<GuildSummary>();
}

export async function putGuild(
	env: Env,
	guildId: string,
	input: { apiKey?: string; model: string; configuredBy: string; githubRepo?: string; githubInstallationId?: string },
): Promise<void> {
	const response = await stub(env).fetch(`https://eryn/registry/guild/${guildId}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `registry rejected the key (HTTP ${response.status})`);
	}
}

export async function removeGuild(env: Env, guildId: string): Promise<void> {
	await stub(env).fetch(`https://eryn/registry/guild/${guildId}`, { method: "DELETE" });
}

/** Record a GitHub App installation id captured from the install callback. */
export async function setGuildInstallation(env: Env, guildId: string, installationId: string): Promise<void> {
	await stub(env).fetch(`https://eryn/registry/guild/${guildId}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ githubInstallationId: installationId }),
	});
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
