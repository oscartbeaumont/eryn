/**
 * The guild registry.
 *
 * A single Durable Object that maps a Discord guild id to the OpenCode Go
 * credential its admins configured. The key is stored encrypted (AES-GCM under
 * the worker's `ENCRYPTION_KEY`) so it is never readable from the object's
 * storage alone. Only the gateway asks for the plaintext, and only over the
 * internal Durable Object binding.
 *
 * Routes (internal, never exposed publicly):
 *   PUT    /registry/guild/:id       { apiKey, model?, configuredBy? }
 *   GET    /registry/guild/:id       summary without the key
 *   GET    /registry/guild/:id/key   { apiKey, model } for the gateway
 *   DELETE /registry/guild/:id
 */

import { DurableObject } from "cloudflare:workers";
import { DEFAULT_MODEL, isValidModel } from "./config";
import { decryptSecret, encryptSecret, type Sealed } from "./crypto";

interface StoredGuild extends Sealed {
	model: string;
	configuredBy?: string;
	updatedAt: number;
}

export interface GuildSummary {
	configured: boolean;
	model?: string;
	configuredBy?: string;
	updatedAt?: number;
}

function json(body: unknown, status = 200): Response {
	return Response.json(body, { status });
}

export class ErynRegistry extends DurableObject<Env> {
	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname.split("/").filter(Boolean);
		if (path[0] !== "registry" || path[1] !== "guild" || !path[2]) return json({ error: "not found" }, 404);
		const guildId = path[2];
		const storageKey = `guild:${guildId}`;
		const wantsKey = path[3] === "key";
		const secret = this.env.ENCRYPTION_KEY;

		if (request.method === "PUT" && !wantsKey) {
			if (!secret) return json({ error: "registry is not configured" }, 500);
			const body = (await request.json()) as { apiKey?: string; model?: string; configuredBy?: string };
			const model = body.model?.trim() || DEFAULT_MODEL;
			if (!isValidModel(model)) return json({ error: "model must be an opencode-go/* reference" }, 400);
			const apiKey = body.apiKey?.trim();
			const existing = await this.ctx.storage.get<StoredGuild>(storageKey);
			// An empty key updates only the model, keeping the stored credential.
			if (!apiKey) {
				if (!existing) return json({ error: "an API key is required" }, 400);
				await this.ctx.storage.put<StoredGuild>(storageKey, {
					...existing,
					model,
					configuredBy: body.configuredBy ?? existing.configuredBy,
					updatedAt: Date.now(),
				});
				return json({ ok: true });
			}
			const sealed = await encryptSecret(secret, apiKey);
			await this.ctx.storage.put<StoredGuild>(storageKey, {
				...sealed,
				model,
				configuredBy: body.configuredBy,
				updatedAt: Date.now(),
			});
			return json({ ok: true });
		}

		const stored = await this.ctx.storage.get<StoredGuild>(storageKey);

		if (request.method === "DELETE" && !wantsKey) {
			await this.ctx.storage.delete(storageKey);
			return json({ ok: true });
		}

		if (request.method === "GET" && wantsKey) {
			if (!stored || !secret) return json({ error: "not configured" }, 404);
			const apiKey = await decryptSecret(secret, stored).catch(() => undefined);
			if (!apiKey) return json({ error: "stored key could not be read" }, 500);
			return json({ apiKey, model: stored.model });
		}

		if (request.method === "GET" && !wantsKey) {
			const summary: GuildSummary = stored
				? { configured: true, model: stored.model, configuredBy: stored.configuredBy, updatedAt: stored.updatedAt }
				: { configured: false };
			return json(summary);
		}

		return json({ error: "not found" }, 404);
	}
}
