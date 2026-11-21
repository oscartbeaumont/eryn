/**
 * Turn Discord attachments into prompt files.
 *
 * The model sees pixels only when they are part of the prompt, so the file is
 * fetched from Discord's CDN and embedded as a data URL. Anything too large or
 * not an image is left out and reported, because silently dropping an image is
 * indistinguishable from the model ignoring it.
 */

import { Base64 } from "effect/encoding";

import { describeError } from "../errors.ts";
import { fetchWithRedirects } from "../http.ts";
import type { PromptAttachment } from "./models";

/** A Discord attachment larger than this is skipped rather than decoded in the isolate. */
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Image types the providers accept as prompt files. */
const ATTACHMENT_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Discord's CDN hosts, so an attachment URL cannot point anywhere else. */
const ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export interface AttachmentFile {
	readonly uri: string;
	/** The media type the file was served as, so a tool can label it. */
	readonly mime: string;
	readonly name?: string;
}

export interface AttachmentFiles {
	readonly files: AttachmentFile[];
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
		const { done, value }: { done: boolean; value?: Uint8Array } = await reader.read();

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
	const outcomes = await Promise.all((attachments ?? []).map((attachment) => fetchAttachment(attachment)));

	return {
		files: outcomes.flatMap((outcome) => (outcome.file ? [outcome.file] : [])),
		notes: outcomes.flatMap((outcome) => (outcome.note ? [outcome.note] : [])),
	};
}

/** One attachment's outcome: the file that was read, or why it was left out. */
interface AttachmentOutcome {
	readonly file?: AttachmentFile;
	readonly note?: string;
}

/** Read one attachment, or report the single reason it was left out. */
async function fetchAttachment(attachment: PromptAttachment): Promise<AttachmentOutcome> {
	const name = attachment.name?.trim() || "attachment";
	const url = parseAttachmentUrl(attachment.url);

	if (!url) return { note: `${name}: invalid link` };

	if (url.protocol !== "https:" || !ATTACHMENT_HOSTS.has(url.hostname)) {
		return { note: `${name}: unsupported link` };
	}

	const declared = attachment.contentType?.split(";")[0]?.trim().toLowerCase();

	if (declared && !ATTACHMENT_TYPES.has(declared)) {
		return { note: `${name}: only images can be attached` };
	}

	if (attachment.size !== undefined && attachment.size > MAX_ATTACHMENT_BYTES) {
		return { note: `${name}: larger than 5 MB` };
	}

	try {
		return await downloadAttachment(url, name, declared);
	} catch (error) {
		return { note: `${name}: ${describeError(error)}` };
	}
}

/** The attachment's link, or undefined when it does not parse. */
function parseAttachmentUrl(value: string): URL | undefined {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
}

/** Download one image and encode it as a prompt file, or say why it was skipped. */
async function downloadAttachment(
	url: URL,
	name: string,
	declared: string | undefined,
): Promise<AttachmentOutcome> {
	const response = await fetchWithRedirects(url, {
		headers: { accept: "image/*" },
		// A slow CDN must not hold a turn (or a tool call) open forever.
		signal: AbortSignal.timeout(20_000),
	});

	if (!response.ok) return { note: `${name}: download failed (HTTP ${response.status})` };

	const served = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
	const type = served && ATTACHMENT_TYPES.has(served) ? served : declared;

	if (!type || !ATTACHMENT_TYPES.has(type)) {
		return { note: `${name}: unsupported type ${served ?? declared ?? "unknown"}` };
	}

	const declaredLength = Number(response.headers.get("content-length") ?? "");

	if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
		await response.body?.cancel().catch(() => undefined);

		return { note: `${name}: larger than 5 MB` };
	}

	const bytes = await readCapped(response, MAX_ATTACHMENT_BYTES);

	if (!bytes) return { note: `${name}: larger than 5 MB` };

	return { file: { uri: `data:${type};base64,${Base64.encode(bytes)}`, name, mime: type } };
}
