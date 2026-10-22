/**
 * The Discord account a user has connected to the MCP endpoint.
 *
 * Connecting is a deliberate act rather than a side effect of signing in. The
 * Discord tools act as the bot, so they are as visible as the bot is — they are
 * not scoped to one server the way a provider key is — and turning that on
 * should be a decision someone made on purpose, and one they can reverse.
 *
 * It is stored per user beside their MCP servers, sealed the same way, though
 * what it records is only that a decision was made and by which account.
 */


export interface DiscordLink {
	/** The Discord user who connected it. */
	id: string;
	name: string;
	connectedAt: number;
}

function registry(env: Env) {
	return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

/** The link for a user, or `undefined` when they have not connected one. */
export async function readDiscordLink(env: Env, userId: string): Promise<DiscordLink | undefined> {
	const response = await registry(env)
		.fetch(`https://eryn/registry/discord/${encodeURIComponent(userId)}`)
		.catch(() => undefined);
	if (!response?.ok) return undefined;
	const body = (await response.json().catch(() => ({}))) as { link?: unknown };
	const link = body.link as DiscordLink | undefined;
	return link && typeof link.id === "string" ? link : undefined;
}

/** Connect or clear a user's link. */
export async function writeDiscordLink(env: Env, userId: string, link: DiscordLink | undefined): Promise<void> {
	const response = await registry(env).fetch(`https://eryn/registry/discord/${encodeURIComponent(userId)}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ link: link ?? null }),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `the registry refused the change (HTTP ${response.status})`);
	}
}
