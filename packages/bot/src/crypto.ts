/**
 * Credential sealing for the bot.
 *
 * A guild's provider keys and MCP tokens are sealed with AES-GCM under the
 * worker's `ENCRYPTION_KEY`, so storage alone never yields a secret. This is a
 * deliberate duplicate of the gateway's copy: the contract forbids one package
 * importing another, and the shared surface is a dozen lines.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function fromBase64url(value: string): Uint8Array {
	const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** A fresh random token, base64url encoded. */
export function randomToken(bytes = 32): string {
	return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function aesKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", fromBase64url(secret), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export interface Sealed {
	readonly iv: string;
	readonly data: string;
}

/** Encrypt a secret string with the worker's encryption key. */
export async function encryptSecret(secret: string, plaintext: string): Promise<Sealed> {
	const key = await aesKey(secret);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
	return { iv: base64url(iv), data: base64url(new Uint8Array(ciphertext)) };
}

/** Decrypt a value produced by `encryptSecret`. Throws if it was tampered with. */
export async function decryptSecret(secret: string, sealed: Sealed): Promise<string> {
	const key = await aesKey(secret);
	const plaintext = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: fromBase64url(sealed.iv) },
		key,
		fromBase64url(sealed.data),
	);
	return decoder.decode(plaintext);
}
