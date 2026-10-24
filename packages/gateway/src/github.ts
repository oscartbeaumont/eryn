/**
 * The GitHub App half of the gateway.
 *
 * The tools authenticate either as a personal token (the user's own name on
 * every action) or as Eryn's App installed on their account (the app's name,
 * acting on their behalf). Only the App half is here: it signs a short-lived
 * RS256 JWT with the App's private key, which is what mints an installation
 * token. `tools/github.ts` owns everything else.
 */

const encoder = new TextEncoder();

export interface GitHubConfig {
	readonly appId: string;
	readonly privateKey: string;
	readonly installationId: string;
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function pemToDer(pem: string): Uint8Array {
	const base64 = pem
		.replace(/-----BEGIN [^-]+-----/g, "")
		.replace(/-----END [^-]+-----/g, "")
		.replace(/\s+/g, "");
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

/** A JWT for the App itself, which is what mints an installation token. */
export async function appJwt(appId: string, privateKey: string): Promise<string> {
	const key = await crypto.subtle.importKey("pkcs8", pemToDer(privateKey), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, [
		"sign",
	]);
	const now = Math.floor(Date.now() / 1_000);
	const encode = (value: unknown) => base64url(encoder.encode(JSON.stringify(value)));
	const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, encoder.encode(signingInput));
	return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}
