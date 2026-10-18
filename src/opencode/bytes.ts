/** Byte <-> base64 and text helpers, kept separate so every module shares one implementation. */

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export function textToBytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

export function bytesToText(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}
