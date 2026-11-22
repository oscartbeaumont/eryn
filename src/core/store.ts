/**
 * Sealed and plain record helpers over Durable Object storage.
 *
 * Every object used to grow its own read/write/decrypt loop. This is that loop
 * once: a record is parsed on the way out, so a value written by an older build
 * is a decodable value or nothing, never a half-shaped object.
 */

import { Option, Schema } from "effect";

import { encryptSecret, decryptSecret } from "../crypto.ts";
import type { Sealed } from "../crypto.ts";
import { botError } from "../errors.ts";

interface ListOptions {
	prefix: string;
	readonly limit: number;
	startAfter?: string;
}

export interface RecordStore {
	/** A plain record, decoded on read. */
	plain<S extends Schema.ConstraintDecoder<unknown>>(key: string, schema: S): Promise<S["Type"] | undefined>;
	putPlain<S extends Schema.ConstraintDecoder<unknown>>(key: string, schema: S, value: S["Type"]): Promise<void>;
	/** A sealed record, decrypted and decoded on read. */
	sealed<S extends Schema.ConstraintDecoder<unknown>>(key: string, schema: S): Promise<S["Type"] | undefined>;
	putSealed<S extends Schema.ConstraintDecoder<unknown>>(key: string, schema: S, value: S["Type"]): Promise<void>;
	listSealed<S extends Schema.ConstraintDecoder<unknown>>(prefix: string, schema: S): Promise<S["Type"][]>;
	listPlain<S extends Schema.ConstraintDecoder<unknown>>(prefix: string, schema: S): Promise<S["Type"][]>;
	remove(key: string): Promise<void>;
	removePrefix(prefix: string): Promise<number>;
}

class StoreImpl implements RecordStore {
	constructor(
		private readonly storage: DurableObjectStorage,
		private readonly secret: string | undefined,
	) {}

	private requireSecret(): string {
		if (!this.secret?.trim()) {
			throw botError("ENCRYPTION_KEY is not configured, so credentials cannot be stored");
		}

		return this.secret;
	}

	private async open<S extends Schema.ConstraintDecoder<unknown>>(
		sealed: Sealed | undefined,
		schema: S,
	): Promise<S["Type"] | undefined> {
		if (!sealed) return undefined;
		const plaintext = await decryptSecret(this.requireSecret(), sealed).catch(() => undefined);

		if (plaintext === undefined) return undefined;

		return Option.getOrUndefined(Schema.decodeOption(Schema.fromJsonString(schema))(plaintext));
	}

	async plain<S extends Schema.ConstraintDecoder<unknown>>(key: string, schema: S) {
		return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(await this.storage.get<unknown>(key)));
	}

	async putPlain<S extends Schema.ConstraintDecoder<unknown>>(key: string, schema: S, value: S["Type"]) {
		await this.storage.put(key, Schema.encodeSync(schema as never)(value as never));
	}

	async sealed<S extends Schema.ConstraintDecoder<unknown>>(key: string, schema: S) {
		return await this.open(await this.storage.get<Sealed>(key), schema);
	}

	async putSealed<S extends Schema.ConstraintDecoder<unknown>>(key: string, schema: S, value: S["Type"]) {
		const sealed = await encryptSecret(
			this.requireSecret(),
			JSON.stringify(Schema.encodeSync(schema as never)(value as never)),
		);
		await this.storage.put(key, sealed);
	}

	async listSealed<S extends Schema.ConstraintDecoder<unknown>>(prefix: string, schema: S) {
		const entries = await this.storage.list<Sealed>({ prefix });
		const values = await Promise.all([...entries.values()].map((sealed) => this.open(sealed, schema)));

		return values.flatMap((value) => (value === undefined ? [] : [value]));
	}

	async listPlain<S extends Schema.ConstraintDecoder<unknown>>(prefix: string, schema: S) {
		const entries = await this.storage.list<unknown>({ prefix });

		return [...entries.values()].flatMap((value) => {
			const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));

			return decoded === undefined ? [] : [decoded];
		});
	}

	async remove(key: string) {
		await this.storage.delete(key);
	}

	async removePrefix(prefix: string) {
		let removed = 0;
		let startAfter: string | undefined;

		for (;;) {
			const options: ListOptions = { prefix, limit: 1_000 };

			if (startAfter) options.startAfter = startAfter;
			const entries = await this.storage.list<unknown>(options);
			const keys = [...entries.keys()];

			if (keys.length === 0) break;
			for (let index = 0; index < keys.length; index += 128) {
				await this.storage.delete(keys.slice(index, index + 128));
			}

			removed += keys.length;

			if (keys.length < 1_000) break;
			startAfter = keys.at(-1);
		}

		return removed;
	}
}

/** Build a record store over a Durable Object's storage. */
export function recordStore(storage: DurableObjectStorage, secret: string | undefined): RecordStore {
	return new StoreImpl(storage, secret);
}
