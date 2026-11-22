/** Small hashing helpers for the email login flow. */

const encoder = new TextEncoder();

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Normalise and hash an email for storage keys and rate limits. */
export function normaliseEmail(email: string): string {
	return email.trim().toLowerCase();
}

export async function emailKey(email: string): Promise<string> {
	return await sha256(normaliseEmail(email));
}

/** Hash a login code with its email, so a code cannot be replayed elsewhere. */
export async function codeHash(email: string, code: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(`${normaliseEmail(email)}:${code}`));

	return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A six-digit numeric code, generated from a uniform random integer. */
export function loginCode(): string {
	const value = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
	return String(value % 1_000_000).padStart(6, "0");
}
