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

import { Context, Layer, Option, Schema } from "effect";
import { DEFAULT_MODEL, KEYS, log } from "../config";
import { decryptSecret, encryptSecret, type Sealed } from "../crypto";
import { botError } from "../errors";
import {
	GuildSettingsSchema,
	McpLinkSchema,
	PendingOAuthSchema,
	ProviderConnectionSchema,
	type GuildSettings,
	type McpLink,
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
	sessionFor(threadId: string): Promise<string | undefined>;
	putSession(threadId: string, sessionID: string): Promise<void>;
	clearSession(threadId: string): Promise<void>;
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
		const parsed = Schema.decodeUnknownOption(schema)(value);
		return Option.isSome(parsed) ? parsed.value : undefined;
	}

	async settings(): Promise<GuildSettings> {
		const stored = await this.storage.get<unknown>(KEYS.guild);
		const parsed = Schema.decodeUnknownOption(GuildSettingsSchema)(stored);
		return Option.isSome(parsed) ? parsed.value : { model: DEFAULT_MODEL, updatedAt: 0 };
	}

	async putSettings(settings: GuildSettings): Promise<void> {
		await this.storage.put(KEYS.guild, Schema.encodeSync(GuildSettingsSchema)(settings));
	}

	async providers(): Promise<ProviderConnection[]> {
		const entries = await this.storage.list<Sealed>({ prefix: KEYS.provider });
		const connections: ProviderConnection[] = [];
		for (const [, sealed] of entries) {
			const connection = await this.open(sealed, ProviderConnectionSchema);
			if (connection) connections.push(connection);
		}
		return connections.sort((a, b) => a.integrationID.localeCompare(b.integrationID));
	}

	async putProvider(connection: ProviderConnection): Promise<void> {
		await this.storage.put(KEYS.provider + connection.integrationID, await this.seal(connection));
	}

	async removeProvider(integrationID: string): Promise<void> {
		await this.storage.delete(KEYS.provider + integrationID);
	}

	async links(): Promise<McpLink[]> {
		const entries = await this.storage.list<Sealed>({ prefix: KEYS.link });
		const links: McpLink[] = [];
		for (const [key, sealed] of entries) {
			const link = await this.open(sealed, McpLinkSchema);
			if (link) links.push(link);
			else log("session", `could not read link ${key}, ignoring it`);
		}
		return links.sort((a, b) => a.createdAt - b.createdAt);
	}

	async getLink(id: string): Promise<McpLink | undefined> {
		const sealed = await this.storage.get<Sealed>(KEYS.link + id);
		return await this.open(sealed, McpLinkSchema);
	}

	async putLink(link: McpLink): Promise<void> {
		await this.storage.put(KEYS.link + link.id, await this.seal(link));
	}

	async removeLink(id: string): Promise<void> {
		await this.storage.delete(KEYS.link + id);
	}

	async sessionFor(threadId: string): Promise<string | undefined> {
		const stored = await this.storage.get<unknown>(KEYS.session + threadId);
		return typeof stored === "string" ? stored : undefined;
	}

	async putSession(threadId: string, sessionID: string): Promise<void> {
		await this.storage.put(KEYS.session + threadId, sessionID);
	}

	async clearSession(threadId: string): Promise<void> {
		await this.storage.delete(KEYS.session + threadId);
	}

	async putPendingOAuth(pending: PendingOAuth): Promise<void> {
		await this.storage.put(KEYS.pendingOAuth, Schema.encodeSync(PendingOAuthSchema)(pending));
	}

	async pendingOAuth(): Promise<PendingOAuth | undefined> {
		const stored = await this.storage.get<unknown>(KEYS.pendingOAuth);
		const parsed = Schema.decodeUnknownOption(PendingOAuthSchema)(stored);
		return Option.isSome(parsed) ? parsed.value : undefined;
	}

	async clearPendingOAuth(): Promise<void> {
		await this.storage.delete(KEYS.pendingOAuth);
	}
}

/**
 * The guild's durable state as a service. `storage` is the Durable Object's own
 * store and `secret` is the worker's `ENCRYPTION_KEY`.
 */
export class GuildStore extends Context.Service<GuildStore, GuildStoreShape>()("eryn/bot/GuildStore") {
	static layer(storage: DurableObjectStorage, secret: string | undefined): Layer.Layer<GuildStore> {
		return Layer.succeed(this)(new GuildStoreImpl(storage, secret));
	}
}
