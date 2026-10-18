/**
 * The registry.
 *
 * A single Durable Object that holds two pieces of setup state:
 *
 * - Each guild's OpenCode Go credential, encrypted (AES-GCM under the worker's
 *   `ENCRYPTION_KEY`) so it is never readable from storage alone. Only the
 *   gateway asks for the plaintext, over the internal Durable Object binding.
 * - A short-lived cache of each signed-in user's guild list, so `/console` does
 *   not call Discord on every page load. Discord rate-limits those bearer-token
 *   routes hard.
 *
 * Routes (internal, never exposed publicly):
 *   PUT    /registry/guild/:id          { apiKey?, model?, configuredBy? }
 *   GET    /registry/guild/:id          summary without the key
 *   GET    /registry/guild/:id/key      { apiKey, model } for the gateway
 *   DELETE /registry/guild/:id
 *   GET    /registry/user/:id/guilds    cached guild list
 *   PUT    /registry/user/:id/guilds    { guilds, expiresAt }
 */

import { DurableObject } from "cloudflare:workers";
import { DEFAULT_MODEL, isValidModel } from "./config";
import { decryptSecret, encryptSecret, type Sealed } from "./crypto";

/** How long a user's guild list stays cached. */
export const USER_GUILDS_TTL_MS = 5 * 60_000;

interface StoredGuild extends Sealed {
	model: string;
	configuredBy?: string;
	updatedAt: number;
	github?: GitHubBinding;
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
}

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
		if (path[1] === "user" && path[2] && path[3] === "guilds") return this.userGuilds(request, path[2]);
		return json({ error: "not found" }, 404);
	}

	private async guild(request: Request, guildId: string, wantsKey: boolean): Promise<Response> {
		const storageKey = `guild:${guildId}`;
		const secret = this.env.ENCRYPTION_KEY;

		if (request.method === "PUT" && !wantsKey) {
			if (!secret) return json({ error: "registry is not configured" }, 500);
			const body = (await request.json()) as {
				apiKey?: string;
				model?: string;
				configuredBy?: string;
				githubRepo?: string;
				githubInstallationId?: string;
			};
			const existing = await this.ctx.storage.get<StoredGuild>(storageKey);
			const model = body.model?.trim() || existing?.model || DEFAULT_MODEL;
			if (!isValidModel(model)) return json({ error: "model must be an opencode-go/* reference" }, 400);
			const apiKey = body.apiKey?.trim();

			// An empty key keeps the stored credential, or records a GitHub-only
			// binding until a key is added.
			const sealed: Sealed = apiKey
				? await encryptSecret(secret, apiKey)
				: { iv: existing?.iv ?? "", data: existing?.data ?? "" };

			const github: GitHubBinding = {
				installationId: body.githubInstallationId ?? existing?.github?.installationId,
				repo: body.githubRepo !== undefined ? body.githubRepo.trim() || undefined : existing?.github?.repo,
			};

			await this.ctx.storage.put<StoredGuild>(storageKey, {
				...sealed,
				model,
				configuredBy: body.configuredBy ?? existing?.configuredBy,
				updatedAt: Date.now(),
				...(github.installationId || github.repo ? { github } : {}),
			});
			return json({ ok: true });
		}

		const stored = await this.ctx.storage.get<StoredGuild>(storageKey);

		if (request.method === "DELETE" && !wantsKey) {
			await this.ctx.storage.delete(storageKey);
			return json({ ok: true });
		}

		if (request.method === "GET" && wantsKey) {
			if (!stored || !secret || !stored.data) return json({ error: "not configured" }, 404);
			const apiKey = await decryptSecret(secret, stored).catch(() => undefined);
			if (!apiKey) return json({ error: "stored key could not be read" }, 500);
			return json({ apiKey, model: stored.model, github: stored.github });
		}

		if (request.method === "GET" && !wantsKey) {
			const summary: GuildSummary =
				stored && stored.data
					? {
							configured: true,
							model: stored.model,
							configuredBy: stored.configuredBy,
							updatedAt: stored.updatedAt,
							github: stored.github,
						}
					: { configured: false, github: stored?.github };
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
