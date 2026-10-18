/** The OAuth2 install link for the bot, optionally pinned to one guild. */

import { BOT_PERMISSIONS, CLIENT_ID } from "../discord-ids";

export function installUrl(guildId?: string): string {
	const params = new URLSearchParams({
		client_id: CLIENT_ID,
		scope: "bot applications.commands",
		permissions: BOT_PERMISSIONS.toString(),
	});
	if (guildId) {
		params.set("guild_id", guildId);
		params.set("disable_guild_select", "true");
	}
	return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
