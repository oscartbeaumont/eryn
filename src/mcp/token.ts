/**
 * The bearer the embedded agent presents to the Worker's MCP endpoint.
 *
 * It is an HMAC-signed pointer, not a database row: the Worker verifies it and
 * routes to the server named inside. A short expiry keeps a leaked token from
 * outliving the host that minted it.
 */

import { Schema } from "effect";

import { sessionSecret } from "../config.ts";
import { sign, verify } from "../crypto.ts";

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const TokenSchema = Schema.Struct({
	serverId: Schema.String,
	expiresAt: Schema.Finite,
});

export type McpToken = typeof TokenSchema.Type;

/** Mint a bearer for one server. */
export async function mintMcpToken(env: Env, serverId: string): Promise<string | undefined> {
	const secret = sessionSecret(env);

	if (!secret) return undefined;

	return await sign({ serverId, expiresAt: Date.now() + TOKEN_TTL_MS }, secret);
}

/** Verify a bearer and return the server it names. */
export async function readMcpToken(env: Env, request: Request): Promise<string | undefined> {
	const header = request.headers.get("authorization") ?? "";
	const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
	const secret = sessionSecret(env);

	if (!secret || !token) return undefined;
	const payload = await verify<Schema.Json>(token, secret);

	if (!payload) return undefined;
	const decoded = Schema.decodeUnknownOption(TokenSchema)(payload);

	if (decoded._tag !== "Some" || decoded.value.expiresAt < Date.now()) return undefined;

	return decoded.value.serverId;
}
