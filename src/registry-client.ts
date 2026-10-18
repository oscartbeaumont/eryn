/**
 * Typed access to the guild registry for the Worker and the gateway object.
 * Everything funnels through the single `ErynRegistry` instance.
 */

import type { GuildSummary } from "./registry";

export interface GuildKey {
	apiKey: string;
	model: string;
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
	input: { apiKey?: string; model: string; configuredBy: string },
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
