/**
 * The install → setup conversation.
 *
 * When the bot is added to a guild, Discord records a `BOT_ADD` audit entry
 * naming who did it. That person is mentioned in the guild with a button that
 * opens the setup menu.
 *
 * The greeting stays in the server because setup is guild-scoped: a DM has no
 * guild context, so every button raised from one has to carry the guild id and
 * the guild-only screens have to be hidden. A message in the server keeps the
 * button plain and the menu complete. Discord only allows an ephemeral message
 * as the response to an interaction, so this greeting is visible to the
 * channel; the menu it opens is ephemeral, so the configuration stays private,
 * and the greeting is deleted once a provider is connected.
 */

import type { Analytics } from "../analytics";
import { actionButton, buttonRow } from "../discord/components";
import { DiscordError, type DiscordAuditEntry, type DiscordRest } from "../discord/api";
import { log } from "../config";
import { SETUP_MENU_ID } from "./ids";

/** Only a very recent install is announced; a READY replay of old guilds is not. */
const RECENT_MS = 10 * 60_000;

/** Discord's epoch, which every snowflake counts milliseconds from. */
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

/**
 * When an audit entry was created, from its snowflake id.
 *
 * Audit log entries carry no `created_at` field, so anything that reads one is
 * judging the entry by a timestamp Discord never sends. The id is a snowflake,
 * and its top 42 bits are milliseconds since Discord's epoch.
 */
function createdAtOf(entry: DiscordAuditEntry): number | undefined {
	try {
		return Number((BigInt(entry.id) >> 22n) + DISCORD_EPOCH_MS);
	} catch {
		return undefined;
	}
}

/** Guild channel types the greeting may be posted in: text and announcement. */
const WRITABLE_TYPES = new Set([0, 5]);

/** Where the guild's install greeting is recorded, so it is sent once and can be removed later. */
function marker(guildId: string): string {
	return `install:${guildId}`;
}

/**
 * The channel and message of a guild's install greeting.
 *
 * Setup finishes in an ephemeral menu, so this record is how that flow finds
 * the public greeting again and deletes it.
 */
export interface InstallGreeting {
	readonly channelId: string;
	readonly messageId: string;
	readonly sentAt: number;
	/**
	 * Set once the greeting has been removed. The record stays so a READY replay
	 * in the same ten minutes cannot post the greeting a second time.
	 */
	readonly dismissed?: boolean;
}

export interface InstallAnnouncement {
	readonly id: string;
	readonly name?: string;
	readonly owner_id?: string;
	readonly system_channel_id?: string;
	readonly unavailable?: boolean;
}

/**
 * Announce a fresh install, once. Returns without doing anything when the guild
 * is not newly installed, when the audit log cannot be read, or when the
 * announcement has already been sent.
 */
export async function maybeAnnounceInstall(
	rest: DiscordRest,
	storage: DurableObjectStorage,
	guild: InstallAnnouncement,
	botUserId: string | undefined,
	analytics: Analytics,
): Promise<void> {
	if (guild.unavailable) return;
	if (await storage.get(marker(guild.id))) return;

	// Reads require the View Audit Log permission; a failure just means no
	// announcement, and the marker is left unset so a later replay can retry.
	const entry = await rest.botAddEntry(guild.id).catch(() => undefined);
	if (!entry) return;
	// `target_id` is the bot that was added. Without a positive match we cannot
	// know this entry is about us, so another bot joining must not be greeted as
	// Eryn's install.
	if (!botUserId || entry.target_id !== botUserId) return;

	// A READY replay lists every guild the bot is already in; only a join that
	// happened just now is worth announcing. An entry whose age cannot be read is
	// left unmarked so a later replay can retry rather than guessed at.
	const createdAt = createdAtOf(entry);
	if (createdAt === undefined) return;
	if (Date.now() - createdAt > RECENT_MS) {
		await storage.put(marker(guild.id), Date.now());
		return;
	}

	const installer = entry.user_id ?? guild.owner_id;
	if (!installer) return;

	// A confirmed fresh install is the top of the funnel. Whether the greeting
	// finds a writable channel does not change that the bot was added.
	await analytics.capture("install_started");

	const name = guild.name ?? "this server";
	const body = [
		`Thanks for adding **Eryn** to **${name}**! Connect an inference provider and I will be ready to answer.`,
		`<@${installer}>`,
	].join("\n");
	const components = [buttonRow([actionButton("Start setup", SETUP_MENU_ID, 1)])];

	// The system channel is the guild's own welcome channel, so prefer it. A
	// guild can have none (or the bot cannot post there), so fall back to the
	// first text channel and let Discord's permissions decide.
	const channels = await rest.guildChannels(guild.id).catch(() => []);
	const targets = new Set<string>([
		...(guild.system_channel_id ? [guild.system_channel_id] : []),
		...channels.filter((channel) => WRITABLE_TYPES.has(channel.type)).map((channel) => channel.id),
	]);

	// A guild where the bot can post nowhere should fail fast rather than try
	// every channel it can see.
	for (const channelId of [...targets].slice(0, 5)) {
		try {
			const message = await rest.sendMessage(channelId, body, { components, users: [installer] });
			await storage.put(marker(guild.id), {
				channelId,
				messageId: message.id,
				sentAt: Date.now(),
			} satisfies InstallGreeting);
			log("gateway", `welcomed ${installer} about guild ${guild.id} in ${channelId}`);
			return;
		} catch (error) {
			log("gateway", `could not post the install message in ${channelId}: ${String(error)}`);
		}
	}
	log("gateway", `could not post the install message for guild ${guild.id}: no writable channel`);
}

/**
 * Delete the guild's install greeting, once setup has finished.
 *
 * The greeting exists to lead an admin into the ephemeral setup menu, so it is
 * noise once a provider is connected. A greeting from an older build may have
 * been a DM (recorded as a bare timestamp) or already deleted by hand, in which
 * case there is nothing to remove.
 */
export async function dismissInstallGreeting(
	rest: DiscordRest,
	storage: DurableObjectStorage,
	guildId: string,
): Promise<void> {
	const key = marker(guildId);
	const greeting = await storage.get<InstallGreeting>(key);
	if (!greeting || typeof greeting !== "object") return;
	if (greeting.dismissed === true) return;
	if (typeof greeting.channelId !== "string" || typeof greeting.messageId !== "string") return;
	try {
		await rest.deleteMessage(greeting.channelId, greeting.messageId);
	} catch (error) {
		// A message a human already removed is as good as deleted. Anything else is
		// worth retrying, which the next setup screen does because the record is
		// left undismissed.
		if (!(error instanceof DiscordError && error.status === 404)) {
			log("gateway", `could not delete the install message in ${greeting.channelId}: ${String(error)}`);
			return;
		}
	}
	// Keep the record as a dismissed marker: a READY replay re-reads the audit log
	// for a recent install, and without it the greeting would be posted again
	// right after the admin finished setting up.
	await storage.put(key, { ...greeting, dismissed: true } satisfies InstallGreeting);
}
