/** Discord outbound, using the deployment's single bot token. */

import { optional } from "../config.ts";
import { MAX_CONTENT, MAX_FILE_BYTES, MAX_FILES, discordRest } from "../discord/api.ts";
import type { DiscordUpload } from "../discord/api.ts";
import type { DiscordComponent } from "../discord/components.ts";
import { externalFetch } from "../http.ts";
import { toJsonObject, stringField } from "../json.ts";
import type { MessagingProvider, SendInput, SendResult } from "./types.ts";

const fetchExternal = externalFetch(30_000);

/** What a send may attach, and what had to be left out. */
interface OutboundFiles {
	files: DiscordUpload[];
	/** Files over {@link MAX_FILE_BYTES}, which Discord would reject outright. */
	tooLarge: number;
	/** Files past {@link MAX_FILES}, which a single message cannot carry. */
	tooMany: number;
}

/**
 * Download the files a send carries, within what one Discord message allows.
 *
 * Discord rejects the whole upload when one part is too large, so a file is
 * dropped — and counted, so the caller can say so — rather than failing the
 * text message with it.
 */
async function filesOf(input: SendInput): Promise<OutboundFiles> {
	const files: DiscordUpload[] = [];
	let tooLarge = 0;
	let tooMany = 0;

	for (const attachment of input.attachments ?? []) {
		if (files.length >= MAX_FILES) {
			tooMany += 1;
			continue;
		}

		try {
			const response = await fetchExternal(attachment.url);

			if (!response.ok) continue;

			const declared = Number(response.headers.get("content-length"));

			if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
				await response.body?.cancel().catch(() => undefined);
				tooLarge += 1;
				continue;
			}

			const data = new Uint8Array(await response.arrayBuffer());

			if (data.byteLength > MAX_FILE_BYTES) {
				tooLarge += 1;
				continue;
			}

			files.push({
				filename: attachment.name ?? `attachment-${files.length + 1}`,
				data,
			});
		} catch {
			// A file that cannot be fetched is omitted; the text still sends.
		}
	}

	return { files, tooLarge, tooMany };
}

/**
 * Split text into messages Discord will accept.
 *
 * A break is taken at a paragraph, then a line, and only mid-content when one
 * run has no break inside the limit at all.
 */
function chunkText(text: string, limit = MAX_CONTENT): string[] {
	if (text.length <= limit) return [text];

	const chunks: string[] = [];
	let rest = text;

	while (rest.length > limit) {
		const window = rest.slice(0, limit);
		const paragraph = window.lastIndexOf("\n\n");
		const line = window.lastIndexOf("\n");
		const cut = paragraph > 0 ? paragraph : line > 0 ? line : limit;

		chunks.push(rest.slice(0, cut).trimEnd());
		rest = rest.slice(cut).trimStart();
	}

	if (rest) chunks.push(rest);

	return chunks.length ? chunks : [""];
}

/** A note for the text when part of an upload was left out. */
function note(count: number, reason: string): string | undefined {
	if (count === 0) return undefined;

	return `(${count} file${count === 1 ? "" : "s"} ${reason})`;
}

export function discordProvider(env: Env): MessagingProvider {
	const token = optional(env, "DISCORD_BOT_TOKEN") ?? "";
	const rest = discordRest(token);

	return {
		kind: "discord",
		async send(input): Promise<SendResult> {
			if (!token) throw new Error("DISCORD_BOT_TOKEN is not configured");

			const { files, tooLarge, tooMany } = await filesOf(input);
			// A skipped file is explained in the text, because the reply itself
			// is what the reader is looking at.
			const text = [
				input.text,
				note(tooLarge, "too large to send"),
				note(tooMany, `not sent: a message carries at most ${MAX_FILES}`),
			]
				.filter((part): part is string => part !== undefined && part.length > 0)
				.join("\n\n");

			let id: string | undefined;

			// The first chunk carries the reply reference, the components, and the
			// files; the rest continue the same reply as plain messages.
			for (const [index, chunk] of chunkText(text).entries()) {
				const message = await rest.sendMessage(input.channel, chunk, {
					replyTo: index === 0 ? input.replyTo : undefined,
					components: index === 0 ? (input.components as readonly DiscordComponent[] | undefined) : undefined,
					files: index === 0 ? files : undefined,
				});

				id ??= message.id;
			}

			return id === undefined ? {} : { id };
		},
	};
}

/** The Discord user behind an interaction token, when a route needs it. */
export function applicationIdOf(payload: unknown): string | undefined {
	return stringField(toJsonObject(payload as never), "application_id");
}
