/**
 * Credential sealing for the bot.
 *
 * A guild's provider keys and MCP tokens are sealed with AES-GCM under the
 * worker's `ENCRYPTION_KEY`, so storage alone never yields a secret. It is kept
 * here as the one shared sealing primitive the bot needs.
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

async function hmacKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
		"verify",
	]);
}

/** Sign a JSON payload into a compact, URL-safe token. */
export async function sign(payload: unknown, secret: string): Promise<string> {
	const body = base64url(encoder.encode(JSON.stringify(payload)));
	const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
	return `${body}.${base64url(new Uint8Array(signature))}`;
}

/** Verify and decode a token from `sign`, or `undefined` when invalid. */
export async function verify<T>(token: string | undefined, secret: string): Promise<T | undefined> {
	if (!token) return undefined;
	const [body, signature] = token.split(".");
	if (!body || !signature) return undefined;
	const valid = await crypto.subtle.verify(
		"HMAC",
		await hmacKey(secret),
		fromBase64url(signature),
		encoder.encode(body),
	);
	if (!valid) return undefined;
	try {
		return JSON.parse(decoder.decode(fromBase64url(body))) as T;
	} catch {
		return undefined;
	}
}
