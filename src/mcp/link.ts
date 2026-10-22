/**
 * The accounts a user has connected to the MCP endpoint.
 *
 * Both are deliberate acts rather than side effects of signing in. The Discord
 * tools act as the bot, so they are as visible as the bot is — not scoped to one
 * server the way a provider key is — and GitHub can act either as the user, with
 * a personal token, or as Eryn's app installed on their account. Turning either
 * on should be a decision someone made on purpose, and one they can reverse.
 *
 * They are stored per user beside their MCP servers, sealed the same way.
 */


export interface DiscordLink {
	/** The Discord user who connected it. */
	id: string;
	name: string;
	connectedAt: number;
}

/**
 * A GitHub credential a user connected.
 *
 * A personal token acts as them; an app installation acts as Eryn's app on their
 * behalf. The only difference downstream is where the bearer token comes from.
 */
export type GitHubConnection =
	| { kind: "pat"; token: string; login?: string; connectedAt: number }
	| { kind: "app"; installationId: string; account?: string; connectedAt: number };

function registry(env: Env) {
	return env.REGISTRY.get(env.REGISTRY.idFromName("registry"));
}

async function read<T>(env: Env, kind: "discord" | "github", userId: string): Promise<T | undefined> {
	const response = await registry(env)
		.fetch(`https://eryn/registry/${kind}/${encodeURIComponent(userId)}`)
		.catch(() => undefined);
	if (!response?.ok) return undefined;
	const body = (await response.json().catch(() => ({}))) as { link?: unknown };
	return (body.link as T | undefined) ?? undefined;
}

async function write(env: Env, kind: "discord" | "github", userId: string, link: unknown): Promise<void> {
	const response = await registry(env).fetch(`https://eryn/registry/${kind}/${encodeURIComponent(userId)}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ link: link ?? null }),
	});
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { error?: string };
		throw new Error(body.error ?? `the registry refused the change (HTTP ${response.status})`);
	}
}

/** The Discord link for a user, or `undefined` when they have not connected one. */
export async function readDiscordLink(env: Env, userId: string): Promise<DiscordLink | undefined> {
	const link = await read<DiscordLink>(env, "discord", userId);
	return link && typeof link.id === "string" ? link : undefined;
}

/** Connect or clear a user's Discord link. */
export function writeDiscordLink(env: Env, userId: string, link: DiscordLink | undefined): Promise<void> {
	return write(env, "discord", userId, link);
}

/** The GitHub connection for a user, if they have made one. */
export async function readGitHubConnection(env: Env, userId: string): Promise<GitHubConnection | undefined> {
	const connection = await read<GitHubConnection>(env, "github", userId);
	if (!connection || (connection.kind !== "pat" && connection.kind !== "app")) return undefined;
	return connection;
}

/** Connect or clear a user's GitHub credential. */
export function writeGitHubConnection(env: Env, userId: string, connection: GitHubConnection | undefined): Promise<void> {
	return write(env, "github", userId, connection);
}
