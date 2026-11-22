/** Identifiers that are safe in URLs, storage keys, and database columns. */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A random, lowercase, sortable-enough id such as `srv_7k3n9f2a`. */
export function newId(prefix: string, length = 12): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let value = "";

	for (const byte of bytes) value += ALPHABET[byte % ALPHABET.length] ?? "0";

	return `${prefix}_${value}`;
}

/** A cursor that sorts in creation order: millis first, then randomness. */
export function cursor(): string {
	const time = Date.now().toString(36).padStart(9, "0");
	const bytes = crypto.getRandomValues(new Uint8Array(4));
	let suffix = "";

	for (const byte of bytes) suffix += ALPHABET[byte % ALPHABET.length] ?? "0";

	return `${time}${suffix}`;
}

/** Whether a value looks like an id this program minted with `prefix`. */
export function isId(prefix: string, value: string): boolean {
	return new RegExp(`^${prefix}_[a-z0-9]+$`).test(value);
}
