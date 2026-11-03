/**
 * The install → setup conversation.
 *
 * When the bot is added to a guild, Discord records a `BOT_ADD` audit entry
 * naming who did it. That person is DMed a short welcome with a button that
 * starts `/eryn setup provider`; if the DM cannot be delivered (a user can
 * close their DMs) the guild's system channel is used instead, mentioning the
 * owner.
 *
 * The button carries the guild id, because a DM has no guild context: clicking
 * it runs the same setup flow against the guild the bot was added to.
 */

import { actionButton, buttonRow } from "../discord/components";
import type { DiscordRest } from "../discord/api";
import { log } from "../config";

/** The audit-log action type for a bot being added to a guild. */
const ACTION_BOT_ADD = 28;
/** Only a very recent install is announced; a READY replay of old guilds is not. */
const RECENT_MS = 10 * 60_000;

/** The custom id on the "Start setup" button: `install:setup:<guildId>`. */
export function installSetupId(guildId: string): string {
	return `install:setup:${guildId}`;
}

/** Where the guild's install announcement is recorded, so it is sent once. */
function marker(guildId: string): string {
	return `install:${guildId}`;
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
): Promise<void> {
	if (guild.unavailable) return;
	if (await storage.get(marker(guild.id))) return;

	// Reads require the View Audit Log permission; a failure just means no DM.
	const entry = await rest.botAddEntry(guild.id).catch(() => undefined);
	if (!entry || entry.action_type !== ACTION_BOT_ADD) return;
	if (entry.target_id && botUserId && entry.target_id !== botUserId) return;

	// The audit log has been read, so remember the guild: an old install should
	// not be re-checked on every READY replay.
	await storage.put(marker(guild.id), Date.now());

	// A READY replay lists every guild the bot is already in; only a join that
	// happened just now is worth announcing.
	const createdAt = entry.created_at ? Date.parse(entry.created_at) : Number.NaN;
	if (Number.isFinite(createdAt) && Date.now() - createdAt > RECENT_MS) return;

	const installer = entry.user_id;
	if (!installer) return;

	const components = [buttonRow([actionButton("Start setup", installSetupId(guild.id), 1)])];
	const name = guild.name ?? "this server";
	const body = `Thanks for adding **Eryn** to **${name}**! Connect an inference provider and I will be ready to answer.`;

	try {
		const dm = await rest.openDm(installer);
		await rest.sendMessage(dm.id, body, { components });
		log("gateway", `welcomed ${installer} about guild ${guild.id}`);
		return;
	} catch (error) {
		log("gateway", `could not DM the installer (${String(error)}); falling back to the system channel`);
	}

	const owner = guild.owner_id ?? installer;
	const channel = guild.system_channel_id;
	if (!channel) return;
	await rest
		.sendMessage(channel, `${body}\n<@${owner}>`, { components, users: [owner] })
		.catch((error) => log("gateway", `could not post the install message: ${String(error)}`));
}
