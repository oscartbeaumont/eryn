/**
 * The registry.
 *
 * A single Durable Object that holds two pieces of setup state:
 *
 * - Each guild's provider credentials, encrypted (AES-GCM under the worker's
 *   `ENCRYPTION_KEY`) so they are never readable from storage alone. Only the
 *   gateway asks for the plaintext, over the internal Durable Object binding.
 *   A guild can connect more than one provider, so this is a list keyed by the
 *   OpenCode integration each credential belongs to rather than a single key.
 * - A short-lived cache of each signed-in user's guild list, so `/console` does
 *   not call Discord on every page load. Discord rate-limits those bearer-token
 *   routes hard.
 *
 * Routes (internal, never exposed publicly):
 *   PUT    /registry/guild/:id          { model?, connect?, disconnect?, configuredBy?, github* }
 *   GET    /registry/guild/:id          summary without any credential
 *   GET    /registry/guild/:id/key      { connections, model, github } for the gateway
 *   DELETE /registry/guild/:id
 *   GET    /registry/user/:id/guilds    cached guild list
 *   PUT    /registry/user/:id/guilds    { guilds, expiresAt }
 */

import { DurableObject } from "cloudflare:workers";
import { DEFAULT_MODEL, isValidModel } from "./config";
import { decryptSecret, encryptSecret, type Sealed } from "./crypto";

/** How long a user's guild list stays cached. */
export const USER_GUILDS_TTL_MS = 5 * 60_000;

/**
 * One provider credential a guild has connected.
 *
 * `integrationID` is an OpenCode integration id — `opencode-go`, `openrouter`,
 * and every other provider models.dev describes. Nothing here is specific to a
 * provider: which ones exist and how they authenticate is the host's business,
 * so a new provider needs no change in this object.
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

interface StoredGuild {
	model: string;
	configuredBy?: string;
	updatedAt: number;
	github?: GitHubBinding;
	/** Sealed JSON: {@link GuildConnection}[], one entry per connected provider. */
	credentials?: Sealed;
	/** Integration id to the first characters of its key, for display only. */
	prefixes?: Record<string, string>;
	/**
	 * The single `opencode-go` key a guild had before providers were
	 * configurable. Read once and folded into `credentials`.
	 */
	iv?: string;
	data?: string;
	keyPrefix?: string;
}

/** Per-guild GitHub App installation and default repository. */
export interface GitHubBinding {
	installationId?: string;
	repo?: string;
}

export interface GuildSummary {
	configured: boolean;
	model?: string;
	configuredBy?: string;
	updatedAt?: number;
	github?: GitHubBinding;
	connections: GuildConnectionSummary[];
}

/** How much of a key to show when identifying which one is configured. */
const KEY_PREFIX_LENGTH = 18;

/** The integration the one-key era used, so an old record can be migrated. */
const LEGACY_INTEGRATION = "opencode-go";

export interface CachedGuilds {
	guilds: unknown[];
	expiresAt: number;
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

export class ErynRegistry extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname.split("/").filter(Boolean);
		if (path[0] !== "registry") return json({ error: "not found" }, 404);
		if (path[1] === "guild" && path[2]) return this.guild(request, path[2], path[3] === "key");
		if (path[1] === "mcp" && path[2]) return this.mcpServers(request, decodeURIComponent(path[2]));
		if (path[1] === "user" && path[2] && path[3] === "guilds") return this.userGuilds(request, path[2]);
		return json({ error: "not found" }, 404);
	}

	/**
	 * A user's connected MCP servers.
	 *
	 * Sealed as one blob, like a guild's provider keys, because the whole list is
	 * always read and written together. Unlike a guild's, these belong to a
	 * person: they follow the user across every server they run Eryn in.
	 */
	private async mcpServers(request: Request, userId: string): Promise<Response> {
		const storageKey = `mcp:${userId}`;
		const secret = this.env.ENCRYPTION_KEY;

		if (request.method === "PUT") {
			if (!secret) return json({ error: "registry is not configured" }, 500);
			const body = (await request.json().catch(() => ({}))) as { servers?: unknown };
			if (!Array.isArray(body.servers)) return json({ error: "servers is required" }, 400);
			await this.ctx.storage.put<Sealed>(storageKey, await encryptSecret(secret, JSON.stringify(body.servers)));
			return json({ ok: true });
		}

		if (request.method === "GET") {
			const stored = await this.ctx.storage.get<Sealed>(storageKey);
			if (!stored?.data || !secret) return json({ servers: [] });
			const plaintext = await decryptSecret(secret, stored).catch(() => undefined);
			if (!plaintext) return json({ servers: [] });
			try {
				const parsed = JSON.parse(plaintext) as unknown;
				return json({ servers: Array.isArray(parsed) ? parsed : [] });
			} catch {
				return json({ servers: [] });
			}
		}

		return json({ error: "not found" }, 404);
	}

	/**
	 * Read a guild's record, folding a pre-providers key into the connection
	 * list on the way through. The migration is written back, so it happens once
	 * per guild rather than on every read.
	 */
	private async load(storageKey: string): Promise<StoredGuild | undefined> {
		const stored = await this.ctx.storage.get<StoredGuild>(storageKey);
		if (!stored) return undefined;
		if (stored.credentials || !stored.data) return stored;

		const secret = this.env.ENCRYPTION_KEY;
		const legacy = secret ? await decryptSecret(secret, { iv: stored.iv ?? "", data: stored.data }).catch(() => undefined) : undefined;
		const migrated: StoredGuild = { ...stored };
		delete migrated.iv;
		delete migrated.data;
		delete migrated.keyPrefix;
		if (!legacy) return migrated;

		migrated.credentials = await encryptSecret(secret!, JSON.stringify([{ integrationID: LEGACY_INTEGRATION, method: "key", key: legacy }]));
		migrated.prefixes = { [LEGACY_INTEGRATION]: stored.keyPrefix ?? legacy.slice(0, KEY_PREFIX_LENGTH) };
		await this.ctx.storage.put(storageKey, migrated);
		return migrated;
	}

	/** The connections in a record, decrypted. */
	private async connections(stored: StoredGuild | undefined): Promise<GuildConnection[]> {
		const secret = this.env.ENCRYPTION_KEY;
		if (!stored?.credentials || !secret) return [];
		const plaintext = await decryptSecret(secret, stored.credentials).catch(() => undefined);
		if (!plaintext) return [];
		try {
			const parsed = JSON.parse(plaintext) as unknown;
			if (!Array.isArray(parsed)) return [];
			return parsed.filter(
				(entry): entry is GuildConnection =>
					Boolean(entry) &&
					typeof entry === "object" &&
					typeof (entry as GuildConnection).integrationID === "string" &&
					typeof (entry as GuildConnection).key === "string",
			);
		} catch {
			return [];
		}
	}

	private async guild(request: Request, guildId: string, wantsKey: boolean): Promise<Response> {
		const storageKey = `guild:${guildId}`;
		const secret = this.env.ENCRYPTION_KEY;

		if (request.method === "PUT" && !wantsKey) {
			if (!secret) return json({ error: "registry is not configured" }, 500);
			const body = (await request.json()) as {
				model?: string;
				configuredBy?: string;
				githubRepo?: string;
				githubInstallationId?: string;
				connect?: GuildConnection[];
				disconnect?: string[];
			};
			const existing = await this.load(storageKey);
			const model = body.model?.trim() || existing?.model || DEFAULT_MODEL;
			if (!isValidModel(model)) return json({ error: "model must be a provider/model reference" }, 400);

			// Connect and disconnect are applied to the stored list, so a save
			// that only changes the model cannot drop a provider by omission.
			const current = await this.connections(existing);
			const byIntegration = new Map(current.map((connection) => [connection.integrationID, connection]));
			for (const connection of body.connect ?? []) {
				const integrationID = connection?.integrationID?.trim();
				const method = connection?.method?.trim() || "key";
				const key = connection?.key?.trim() ?? "";
				if (!integrationID) return json({ error: "a connection needs an integration" }, 400);
				// Only the key flow carries material. A sign-in leaves its credential
				// in the guild's own object, so recording the connection is enough.
				if (method === "key" && !key) return json({ error: "a key connection needs a key" }, 400);
				byIntegration.set(integrationID, { integrationID, method, key });
			}
			for (const integrationID of body.disconnect ?? []) byIntegration.delete(integrationID);
			const connections = [...byIntegration.values()];

			const prefixes: Record<string, string> = {};
			for (const connection of connections) {
				const provided = body.connect?.find((entry) => entry?.integrationID === connection.integrationID)?.key?.trim();
				const prefix = provided?.slice(0, KEY_PREFIX_LENGTH) || existing?.prefixes?.[connection.integrationID];
				if (prefix) prefixes[connection.integrationID] = prefix;
			}

			const github: GitHubBinding = {
				installationId: body.githubInstallationId ?? existing?.github?.installationId,
				repo: body.githubRepo !== undefined ? body.githubRepo.trim() || undefined : existing?.github?.repo,
			};

			await this.ctx.storage.put<StoredGuild>(storageKey, {
				model,
				configuredBy: body.configuredBy ?? existing?.configuredBy,
				updatedAt: Date.now(),
				credentials: connections.length
					? await encryptSecret(secret, JSON.stringify(connections))
					: undefined,
				prefixes: connections.length ? prefixes : undefined,
				...(github.installationId || github.repo ? { github } : {}),
			});
			return json({ ok: true });
		}

		const stored = await this.load(storageKey);

		if (request.method === "DELETE" && !wantsKey) {
			await this.ctx.storage.delete(storageKey);
			return json({ ok: true });
		}

		if (request.method === "GET" && wantsKey) {
			const connections = await this.connections(stored);
			if (!connections.length) return json({ error: "not configured" }, 404);
			return json({ connections, model: stored?.model ?? DEFAULT_MODEL, github: stored?.github });
		}

		if (request.method === "GET" && !wantsKey) {
			const connections = await this.connections(stored);
			const summary: GuildSummary = {
				configured: connections.length > 0,
				model: stored?.model ?? DEFAULT_MODEL,
				configuredBy: stored?.configuredBy,
				updatedAt: stored?.updatedAt,
				github: stored?.github,
				connections: connections.map((connection) => ({
					integrationID: connection.integrationID,
					prefix: stored?.prefixes?.[connection.integrationID],
				})),
			};
			return json(summary);
		}

		return json({ error: "not found" }, 404);
	}

	private async userGuilds(request: Request, userId: string): Promise<Response> {
		const storageKey = `user:${userId}:guilds`;

		if (request.method === "PUT") {
			const body = (await request.json()) as { guilds?: unknown; expiresAt?: unknown };
			if (!Array.isArray(body.guilds)) return json({ error: "guilds is required" }, 400);
			const expiresAt =
				typeof body.expiresAt === "number" && Number.isFinite(body.expiresAt)
					? body.expiresAt
					: Date.now() + USER_GUILDS_TTL_MS;
			await this.ctx.storage.put<CachedGuilds>(storageKey, { guilds: body.guilds, expiresAt });
			return json({ ok: true });
		}

		if (request.method === "GET") {
			const cached = await this.ctx.storage.get<CachedGuilds>(storageKey);
			if (!cached || cached.expiresAt < Date.now()) return json({ error: "not cached" }, 404);
			return json(cached);
		}

		if (request.method === "DELETE") {
			await this.ctx.storage.delete(storageKey);
			return json({ ok: true });
		}

		return json({ error: "not found" }, 404);
	}
}
