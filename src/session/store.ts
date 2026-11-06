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

/** The Durable Object storage layout, one method per concern. */
export interface GuildStoreShape {
	settings(): Promise<GuildSettings>;
	putSettings(settings: GuildSettings): Promise<void>;
	providers(): Promise<ProviderConnection[]>;
	putProvider(connection: ProviderConnection): Promise<void>;
	removeProvider(integrationID: string): Promise<void>;
	links(): Promise<McpLink[]>;
	getLink(id: string): Promise<McpLink | undefined>;
	putLink(link: McpLink): Promise<void>;
	removeLink(id: string): Promise<void>;
	authAttempts(): Promise<PendingMcpAuth[]>;
	getAuthAttempt(id: string): Promise<PendingMcpAuth | undefined>;
	putAuthAttempt(attempt: PendingMcpAuth): Promise<void>;
	removeAuthAttempt(id: string): Promise<void>;
	putPendingOAuth(pending: PendingOAuth): Promise<void>;
	pendingOAuth(): Promise<PendingOAuth | undefined>;
	clearPendingOAuth(): Promise<void>;
}

class GuildStoreImpl implements GuildStoreShape {
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
		let value: unknown;
		try {
			value = JSON.parse(plaintext) as unknown;
		} catch {
			return undefined;
		}
		return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));
	}

	private async sealedList<S extends Schema.ConstraintDecoder<unknown>>(prefix: string, schema: S): Promise<S["Type"][]> {
		const entries = await this.storage.list<Sealed>({ prefix });
		const values = await Promise.all([...entries].map(([, sealed]) => this.open(sealed, schema)));
		const found: S["Type"][] = [];
		for (const value of values) if (value !== undefined) found.push(value);
		return found;
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
	private async readLink(key: string): Promise<McpLink | undefined> {
		const link = await this.sealedGet(key, McpLinkSchema);
		if (link?.kind !== "eryn") return link;
		await this.storage.delete(key);
		return undefined;
	}

	async links(): Promise<McpLink[]> {
		const entries = await this.storage.list<Sealed>({ prefix: KEYS.link });
		const links: McpLink[] = [];
		for (const [key] of entries) {
			const link = await this.readLink(key);
			if (link) links.push(link);
		}
		return links.sort((a, b) => a.createdAt - b.createdAt);
	}

	async getLink(id: string): Promise<McpLink | undefined> {
		return await this.readLink(KEYS.link + id);
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
export function guildStore(storage: DurableObjectStorage, secret: string | undefined): GuildStoreShape {
	return new GuildStoreImpl(storage, secret);
}
