/**
 * Short-lived links to a shared workspace file.
 *
 * The token names the R2 object and expires; the file route verifies it before
 * reading. A link is therefore safe to hand to a messaging provider without
 * making the bucket public.
 */

import { Schema } from "effect";

import { sessionSecret } from "../config.ts";
import { sign, verify } from "../crypto.ts";

const TTL_MS = 24 * 60 * 60 * 1000;

const FileTokenSchema = Schema.Struct({
	key: Schema.String,
	expiresAt: Schema.Finite,
});

export async function mintFileToken(env: Env, key: string): Promise<string | undefined> {
	const secret = sessionSecret(env);

	if (!secret) return undefined;

	return await sign({ key, expiresAt: Date.now() + TTL_MS }, secret);
}

export async function readFileToken(env: Env, token: string | null): Promise<string | undefined> {
	const secret = sessionSecret(env);

	if (!secret || !token) return undefined;
	const payload = await verify<Schema.Json>(token, secret);

	if (!payload) return undefined;
	const decoded = Schema.decodeUnknownOption(FileTokenSchema)(payload);

	if (decoded._tag !== "Some" || decoded.value.expiresAt < Date.now()) return undefined;

	return decoded.value.key;
}
