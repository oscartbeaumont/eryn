/**
 * The registry's connection bookkeeping, kept apart from the Durable Object.
 *
 * It is a plain function of its inputs, which is the point: several providers
 * can be connected to one guild at once, and the rules that decide how a save
 * merges into that list are worth being able to exercise without a Worker.
 */

/**
 * One provider credential a guild has connected.
 *
 * `integrationID` is an OpenCode integration id — `opencode`, `opencode-go`,
 * `openrouter`, and every other provider models.dev describes. Nothing here is
 * specific to a provider: which ones exist and how they authenticate is the
 * host's business, so a new provider needs no change in this object.
 */
export interface GuildConnection {
	integrationID: string;
	/** The flow it was connected with: `key` or `oauth`. */
	method: string;
	/**
	 * The secret, for a `key` connection. A sign-in leaves its credential in the
	 * guild's own object instead, so this is empty and only the fact that the
	 * connection exists is recorded here.
	 */
	key: string;
}

/** What the console is told about a connection: never the secret. */
export interface GuildConnectionSummary {
	integrationID: string;
	/** The start of the key, so the console can show which one is configured. */
	prefix?: string;
}

/** How much of a key to show when identifying which one is configured. */
export const KEY_PREFIX_LENGTH = 18;

/** The integration the one-key era used, so an old record can be migrated. */
export const LEGACY_INTEGRATION = "opencode-go";

/**
 * The OpenCode Console, which is a different provider from OpenCode Go.
 *
 * They have separate keys and separate catalogues — the Console's is the larger
 * one, covering models from several upstreams — but share an environment
 * variable name, so a key filed under the wrong one looks fine and simply
 * offers, and reaches, the wrong models.
 */
export const CONSOLE_INTEGRATION = "opencode";

/**
 * Apply a save's connect and disconnect lists to a guild's connections.
 *
 * A guild can hold several providers at once — an OpenCode key and an OpenRouter
 * one, say — so this merges rather than replaces. That also means a save which
 * only changes the model cannot drop a provider by omission, which is the bug
 * this shape exists to prevent.
 */
export function mergeConnections(
	current: readonly GuildConnection[],
	connect: readonly GuildConnection[] | undefined,
	disconnect: readonly string[] | undefined,
): { connections: GuildConnection[]; error?: string } {
	const byIntegration = new Map(current.map((connection) => [connection.integrationID, connection]));
	for (const connection of connect ?? []) {
		const integrationID = connection?.integrationID?.trim();
		const method = connection?.method?.trim() || "key";
		const key = connection?.key?.trim() ?? "";
		if (!integrationID) return { connections: [...current], error: "a connection needs an integration" };
		// Only the key flow carries material. A sign-in leaves its credential in
		// the guild's own object, so recording the connection is enough.
		if (method === "key" && !key) return { connections: [...current], error: "a key connection needs a key" };
		byIntegration.set(integrationID, { integrationID, method, key });
	}
	for (const integrationID of disconnect ?? []) byIntegration.delete(integrationID);
	return { connections: [...byIntegration.values()] };
}

/** The prefixes to show for a connection list, given what is already known. */
export function prefixesFor(
	connections: readonly GuildConnection[],
	provided: readonly GuildConnection[] | undefined,
	existing: Record<string, string> | undefined,
): Record<string, string> {
	const prefixes: Record<string, string> = {};
	for (const connection of connections) {
		const supplied = provided?.find((entry) => entry?.integrationID === connection.integrationID)?.key?.trim();
		const prefix = supplied?.slice(0, KEY_PREFIX_LENGTH) || existing?.[connection.integrationID];
		if (prefix) prefixes[connection.integrationID] = prefix;
	}
	return prefixes;
}

/**
 * Move a key filed under OpenCode Go to the Console provider.
 *
 * Every key was filed as Go for as long as Go was the only choice, so a key
 * issued by the Console ended up under the wrong provider. Only the name
 * changes: the secret is carried across untouched, because the point is that
 * nobody should have to paste it again. A Console connection already present
 * wins, since two entries cannot share one integration.
 */
export function refileConsoleKey(
	connections: readonly GuildConnection[],
	prefixes: Record<string, string> | undefined,
): { connections: GuildConnection[]; prefixes: Record<string, string>; moved: number } | undefined {
	if (!connections.some((connection) => connection.integrationID === LEGACY_INTEGRATION)) return undefined;
	const alreadyConsole = connections.some((connection) => connection.integrationID === CONSOLE_INTEGRATION);
	const next: GuildConnection[] = [];
	const kept: Record<string, string> = {};
	let moved = 0;
	for (const connection of connections) {
		if (connection.integrationID !== LEGACY_INTEGRATION) {
			next.push(connection);
			const prefix = prefixes?.[connection.integrationID];
			if (prefix) kept[connection.integrationID] = prefix;
			continue;
		}
		moved += 1;
		if (alreadyConsole) continue;
		next.push({ ...connection, integrationID: CONSOLE_INTEGRATION });
		kept[CONSOLE_INTEGRATION] = prefixes?.[LEGACY_INTEGRATION] ?? connection.key.slice(0, KEY_PREFIX_LENGTH);
	}
	return { connections: next, prefixes: kept, moved };
}

/**
 * Move a model reference that named OpenCode Go to the Console.
 *
 * The key and the model have to agree: a model naming a provider this deployment
 * holds no key for resolves to nothing, so a record whose key moves and whose
 * model does not is left worse than it started.
 */
export function refileModel(model: string | undefined): string | undefined {
	if (!model) return undefined;
	const at = model.indexOf("/");
	if (at <= 0 || model.slice(0, at) !== LEGACY_INTEGRATION) return undefined;
	return `${CONSOLE_INTEGRATION}${model.slice(at)}`;
}
