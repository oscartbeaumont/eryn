/**
 * Sealed storage for one Eryn user's object.
 *
 * Everything a user owns — accounts, hosted servers, grants — is written as one
 * AES-GCM sealed JSON blob per key, so storage alone never reveals a credential,
 * and every read is parsed back through the same `Schema` that wrote it.
 */

import { Schema } from "effect";
import { decryptSecret, encryptSecret, type Sealed } from "./crypto";
import {
	Account,
	Grant,
	McpServer,
	type Account as AccountT,
	type Grant as GrantT,
	type McpServer as McpServerT,
} from "./model";

/** Parse a stored value, or `undefined` when it does not match the schema. */
export function decode<S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): Schema.Schema.Type<S> | undefined {
	try {
		return Schema.decodeSync(schema)(value) as Schema.Schema.Type<S>;
	} catch {
		return undefined;
	}
}

/** Decode a batched source, dropping the entries that do not parse. */
export function decodeMany<S extends Schema.ConstraintDecoder<unknown>>(schema: S, values: readonly unknown[]): Schema.Schema.Type<S>[] {
	const out: Schema.Schema.Type<S>[] = [];
	for (const value of values) {
		const parsed = decode(schema, value);
		if (parsed !== undefined) out.push(parsed);
	}
	return out;
}

async function readSealed<S extends Schema.ConstraintDecoder<unknown>>(
	storage: DurableObjectStorage,
	key: string,
	secret: string,
	schema: S,
): Promise<Schema.Schema.Type<S> | undefined> {
	const stored = await storage.get<Sealed>(key);
	if (!stored?.data) return undefined;
	const plaintext = await decryptSecret(secret, stored).catch(() => undefined);
	if (!plaintext) return undefined;
	try {
		return decode(schema, JSON.parse(plaintext));
	} catch {
		return undefined;
	}
}

async function writeSealed(storage: DurableObjectStorage, key: string, secret: string, value: unknown): Promise<void> {
	await storage.put<Sealed>(key, await encryptSecret(secret, JSON.stringify(value)));
}

// --- Accounts ------------------------------------------------------------------

export const accountKey = (id: string) => `account:${id}`;

export function listAccounts(storage: DurableObjectStorage, secret: string): Promise<AccountT[]> {
	return listSealed(storage, "account:", secret, Account);
}

export async function getAccount(storage: DurableObjectStorage, secret: string, id: string): Promise<AccountT | undefined> {
	return await readSealed(storage, accountKey(id), secret, Account);
}

export function putAccount(storage: DurableObjectStorage, secret: string, account: AccountT): Promise<void> {
	return writeSealed(storage, accountKey(account.id), secret, account);
}

export async function deleteAccount(storage: DurableObjectStorage, id: string): Promise<void> {
	await storage.delete(accountKey(id));
}

// --- Hosted MCP servers --------------------------------------------------------

export const serverKey = (id: string) => `server:${id}`;
export const serverNameKey = (slug: string) => `server-name:${slug}`;

export function listServers(storage: DurableObjectStorage, secret: string): Promise<McpServerT[]> {
	return listSealed(storage, "server:", secret, McpServer);
}

export async function getServer(storage: DurableObjectStorage, secret: string, id: string): Promise<McpServerT | undefined> {
	return await readSealed(storage, serverKey(id), secret, McpServer);
}

export async function getServerByName(
	storage: DurableObjectStorage,
	secret: string,
	slug: string,
): Promise<McpServerT | undefined> {
	const id = await storage.get<string>(serverNameKey(slug));
	return id ? await getServer(storage, secret, id) : undefined;
}

export async function putServer(storage: DurableObjectStorage, secret: string, server: McpServerT): Promise<void> {
	await writeSealed(storage, serverKey(server.id), secret, server);
	await storage.put(serverNameKey(server.name), server.id);
}

export async function deleteServer(storage: DurableObjectStorage, secret: string, id: string): Promise<void> {
	const server = await getServer(storage, secret, id);
	if (server) {
		await storage.delete(serverNameKey(server.name));
		// Grants are keyed by the server's slug, so they go with it.
		for (const [key] of await storage.list({ prefix: `grant:${server.name}:` })) await storage.delete(key);
	}
	await storage.delete(serverKey(id));
}

// --- Grants --------------------------------------------------------------------

export const grantKey = (slug: string, guildId: string) => `grant:${slug}:${guildId}`;

export function listGrants(storage: DurableObjectStorage, secret: string): Promise<GrantT[]> {
	return listSealed(storage, "grant:", secret, Grant);
}

export async function getGrant(storage: DurableObjectStorage, secret: string, slug: string, guildId: string): Promise<GrantT | undefined> {
	return await readSealed(storage, grantKey(slug, guildId), secret, Grant);
}

export function putGrant(storage: DurableObjectStorage, secret: string, grant: GrantT, slug: string): Promise<void> {
	return writeSealed(storage, grantKey(slug, grant.guildId), secret, grant);
}

export async function deleteGrant(storage: DurableObjectStorage, slug: string, guildId: string): Promise<void> {
	await storage.delete(grantKey(slug, guildId));
}

// --- Generic -------------------------------------------------------------------

async function listSealed<S extends Schema.ConstraintDecoder<unknown>>(
	storage: DurableObjectStorage,
	prefix: string,
	secret: string,
	schema: S,
): Promise<Schema.Schema.Type<S>[]> {
	const out: Schema.Schema.Type<S>[] = [];
	for (const [key] of await storage.list({ prefix })) {
		const value = await readSealed(storage, key, secret, schema);
		if (value !== undefined) out.push(value);
	}
	return out;
}
