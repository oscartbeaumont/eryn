/**
 * The guild session's durable state.
 *
 * One object per guild owns a model choice, a set of provider credentials, a
 * set of MCP links, and the mapping from a Discord thread to an OpenCode
 * session. Credentials and tokens are sealed with `ENCRYPTION_KEY`; the model
 * choice is plain, because it is not a secret.
 *
 * Every stored record is parsed on read, so a record written by an older build
 * is a value that fails to decode rather than a runtime surprise.
 */

import { Option, Schema } from "effect";
import { DEFAULT_MODEL, KEYS } from "../config";
import { decryptSecret, encryptSecret, type Sealed } from "../crypto";
import { botError } from "../errors";
import {
	GuildSettingsSchema,
	McpLinkSchema,
	PendingMcpAuthSchema,
	PendingOAuthSchema,
	ProviderConnectionSchema,
	type GuildSettings,
	type McpLink,
	type PendingMcpAuth,
	type PendingOAuth,
	type ProviderConnection,
} from "./models";

class GuildStoreImpl {
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly secret: string | undefined,
	) {}

	private requireSecret(): string {
		if (!this.secret?.trim()) throw botError("ENCRYPTION_KEY is not configured, so credentials cannot be stored");
		return this.secret;
	}

	private async seal(value: unknown): Promise<Sealed> {
		return await encryptSecret(this.requireSecret(), JSON.stringify(value));
	}

	private async open<S extends Schema.ConstraintDecoder<unknown>>(
		sealed: Sealed | undefined,
		schema: S,
	): Promise<S["Type"] | undefined> {
		if (!sealed) return undefined;
		const plaintext = await decryptSecret(this.requireSecret(), sealed).catch(() => undefined);
		if (plaintext === undefined) return undefined;
		return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(schema))(plaintext));
	}

	/**
	 * Read every sealed entry under a prefix, mapping its key and value.
	 *
	 * A listing already carries the sealed values, so a mapper that has to act
	 * on a record's key — such as deleting a legacy link — needs no second read.
	 */
	private async readSealed<T>(
		prefix: string,
		read: (key: string, sealed: Sealed) => Promise<T | undefined>,
	): Promise<T[]> {
		const entries = await this.storage.list<Sealed>({ prefix });
		const values = await Promise.all([...entries].map(([key, sealed]) => read(key, sealed)));
		const found: T[] = [];
		for (const value of values) if (value !== undefined) found.push(value);
		return found;
	}

	private async sealedList<S extends Schema.ConstraintDecoder<unknown>>(prefix: string, schema: S): Promise<S["Type"][]> {
		return await this.readSealed(prefix, (_key, sealed) => this.open(sealed, schema));
	}

	private async sealedGet<S extends Schema.ConstraintDecoder<unknown>>(
		key: string,
		schema: S,
	): Promise<S["Type"] | undefined> {
		return await this.open(await this.storage.get<Sealed>(key), schema);
	}

	private async plain<S extends Schema.ConstraintDecoder<unknown>>(key: string, schema: S): Promise<S["Type"] | undefined> {
		return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(await this.storage.get<unknown>(key)));
	}

	async settings(): Promise<GuildSettings> {
		return (await this.plain(KEYS.guild, GuildSettingsSchema)) ?? { model: DEFAULT_MODEL, updatedAt: 0 };
	}

	async putSettings(settings: GuildSettings): Promise<void> {
		await this.storage.put(KEYS.guild, Schema.encodeSync(GuildSettingsSchema)(settings));
	}

	async providers(): Promise<ProviderConnection[]> {
		const connections = await this.sealedList(KEYS.provider, ProviderConnectionSchema);
		return connections.sort((a, b) => a.integrationID.localeCompare(b.integrationID));
	}

	async putProvider(connection: ProviderConnection): Promise<void> {
		await this.storage.put(KEYS.provider + connection.integrationID, await this.seal(connection));
	}

	async removeProvider(integrationID: string): Promise<void> {
		await this.storage.delete(KEYS.provider + integrationID);
	}

	/**
	 * A link, dropping the legacy shape that pointed at the MCP gateway Eryn no
	 * longer hosts. Such a link names an endpoint that does not exist, so it is
	 * deleted rather than carried forward.
	 */
	private async readLink(key: string, sealed: Sealed): Promise<McpLink | undefined> {
		const link = await this.open(sealed, McpLinkSchema);
		if (link?.kind !== "eryn") return link;
		await this.storage.delete(key);
		return undefined;
	}

	async links(): Promise<McpLink[]> {
		const links = await this.readSealed(KEYS.link, (key, sealed) => this.readLink(key, sealed));
		return links.sort((a, b) => a.createdAt - b.createdAt);
	}

	async getLink(id: string): Promise<McpLink | undefined> {
		const key = KEYS.link + id;
		const sealed = await this.storage.get<Sealed>(key);
		return sealed ? await this.readLink(key, sealed) : undefined;
	}

	async putLink(link: McpLink): Promise<void> {
		await this.storage.put(KEYS.link + link.id, await this.seal(link));
	}

	async removeLink(id: string): Promise<void> {
		await this.storage.delete(KEYS.link + id);
	}

	async authAttempts(): Promise<PendingMcpAuth[]> {
		const attempts = await this.sealedList(KEYS.mcpAuth, PendingMcpAuthSchema);
		return attempts.sort((a, b) => a.createdAt - b.createdAt);
	}

	async getAuthAttempt(id: string): Promise<PendingMcpAuth | undefined> {
		return await this.sealedGet(KEYS.mcpAuth + id, PendingMcpAuthSchema);
	}

	async putAuthAttempt(attempt: PendingMcpAuth): Promise<void> {
		await this.storage.put(KEYS.mcpAuth + attempt.attemptId, await this.seal(attempt));
	}

	async removeAuthAttempt(id: string): Promise<void> {
		await this.storage.delete(KEYS.mcpAuth + id);
	}

	async putPendingOAuth(pending: PendingOAuth): Promise<void> {
		await this.storage.put(KEYS.pendingOAuth, Schema.encodeSync(PendingOAuthSchema)(pending));
	}

	async pendingOAuth(): Promise<PendingOAuth | undefined> {
		return await this.plain(KEYS.pendingOAuth, PendingOAuthSchema);
	}

	async clearPendingOAuth(): Promise<void> {
		await this.storage.delete(KEYS.pendingOAuth);
	}
}

/** Build the guild's durable state over a Durable Object's storage. */
export function guildStore(storage: DurableObjectStorage, secret: string | undefined) {
	return new GuildStoreImpl(storage, secret);
}

/** The guild's durable state, as the routes and the object see it. */
export type GuildStoreShape = ReturnType<typeof guildStore>;
