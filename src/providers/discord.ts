/** Discord outbound, using the deployment's single bot token. */

import { optional } from "../config.ts";
import { toJsonObject, stringField } from "../json.ts";
import { discordRest } from "../discord/api.ts";
import type { DiscordUpload } from "../discord/api.ts";
import type { MessagingProvider, SendInput, SendResult } from "./types.ts";

async function filesOf(input: SendInput): Promise<DiscordUpload[]> {
	const files: DiscordUpload[] = [];

	for (const attachment of input.attachments ?? []) {
		try {
			const response = await fetch(attachment.url, { signal: AbortSignal.timeout(30_000) });

			if (!response.ok) continue;
			files.push({
				filename: attachment.name ?? `attachment-${files.length + 1}`,
				data: new Uint8Array(await response.arrayBuffer()),
			});
		} catch {
			// A file that cannot be fetched is omitted; the text still sends.
		}
	}

	return files;
}

export function discordProvider(env: Env): MessagingProvider {
	const token = optional(env, "DISCORD_BOT_TOKEN") ?? "";
	const rest = discordRest(token);

	return {
		kind: "discord",
		async send(input): Promise<SendResult> {
			if (!token) throw new Error("DISCORD_BOT_TOKEN is not configured");

			const message = await rest.sendMessage(input.channel, input.text, {
				replyTo: input.replyTo,
				files: await filesOf(input),
			});

			return { id: message.id };
		},
	};
}

/** The Discord user behind an interaction token, when a route needs it. */
export function applicationIdOf(payload: unknown): string | undefined {
	return stringField(toJsonObject(payload as never), "application_id");
}
