/**
 * Byte helpers for the virtual workspace.
 *
 * Files are stored as base64 so binary content round-trips exactly; Effect's
 * encoder is used rather than a hand-written alphabet.
 */

import { Result } from "effect";
import { Base64 } from "effect/encoding";

export const bytesToBase64 = Base64.encode;

export function base64ToBytes(value: string): Uint8Array {
	return Result.getOrThrow(Base64.decode(value));
}

export function textToBytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

export function bytesToText(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}
