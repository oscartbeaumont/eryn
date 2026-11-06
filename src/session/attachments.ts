/**
 * Turn Discord attachments into prompt files.
 *
 * The model sees pixels only when they are part of the prompt, so the file is
 * fetched from Discord's CDN and embedded as a data URL. Anything too large or
 * not an image is left out and reported, because silently dropping an image is
 * indistinguishable from the model ignoring it.
 */

import { Base64 } from "effect/encoding";

import { describeError } from "../errors";
import { fetchWithRedirects } from "../http";
import type { PromptAttachment } from "./models";

/** A Discord attachment larger than this is skipped rather than decoded in the isolate. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Image types the providers accept as prompt files. */
const ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Discord's CDN hosts, so an attachment URL cannot point anywhere else. */
const ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export interface AttachmentFiles {
	readonly files: { uri: string; name?: string }[];
	/** Why an attachment was left out, in the order they were seen. */
	readonly notes: string[];
}

/** Read at most `limit` bytes; `undefined` means the body exceeded it. */
async function readCapped(response: Response, limit: number): Promise<Uint8Array | undefined> {
	const reader = response.body?.getReader();
	if (!reader) return new Uint8Array(0);
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (!value) continue;
		total += value.byteLength;
		if (total > limit) {
			await reader.cancel().catch(() => undefined);
			return undefined;
		}
		chunks.push(value);
	}
	return new Uint8Array(await new Blob(chunks).arrayBuffer());
}

export async function fetchAttachmentFiles(
	attachments: readonly PromptAttachment[] | undefined,
): Promise<AttachmentFiles> {
	const files: { uri: string; name?: string }[] = [];
	const notes: string[] = [];
	for (const attachment of attachments ?? []) {
		const name = attachment.name?.trim() || "attachment";
		let url: URL;
		try {
			url = new URL(attachment.url);
		} catch {
			notes.push(`${name}: invalid link`);
			continue;
		}
		if (url.protocol !== "https:" || !ATTACHMENT_HOSTS.has(url.hostname)) {
			notes.push(`${name}: unsupported link`);
			continue;
		}
		const declared = attachment.contentType?.split(";")[0]?.trim().toLowerCase();
		if (declared && !ATTACHMENT_TYPES.has(declared)) {
			notes.push(`${name}: only images can be attached`);
			continue;
		}
		if (typeof attachment.size === "number" && attachment.size > MAX_ATTACHMENT_BYTES) {
			notes.push(`${name}: larger than 5 MB`);
			continue;
		}
		try {
			const response = await fetchWithRedirects(url, { headers: { accept: "image/*" } });
			if (!response.ok) {
				notes.push(`${name}: download failed (HTTP ${response.status})`);
				continue;
			}
			const served = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
			const type = served && ATTACHMENT_TYPES.has(served) ? served : declared;
			if (!type || !ATTACHMENT_TYPES.has(type)) {
				notes.push(`${name}: unsupported type ${served ?? declared ?? "unknown"}`);
				continue;
			}
			const declaredLength = Number(response.headers.get("content-length") ?? "");
			if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
				await response.body?.cancel().catch(() => undefined);
				notes.push(`${name}: larger than 5 MB`);
				continue;
			}
			const bytes = await readCapped(response, MAX_ATTACHMENT_BYTES);
			if (!bytes) {
				notes.push(`${name}: larger than 5 MB`);
				continue;
			}
			files.push({ uri: `data:${type};base64,${Base64.encode(bytes)}`, name });
		} catch (error) {
			notes.push(`${name}: ${describeError(error)}`);
		}
	}
	return { files, notes };
}
