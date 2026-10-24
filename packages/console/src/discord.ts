/** The OAuth2 install link that adds the bot to a Discord server. */

import { BOT_PERMISSIONS, CLIENT_ID } from "./discord-ids";

export function installUrl(): string {
	const params = new URLSearchParams({
		client_id: CLIENT_ID,
		scope: "bot applications.commands",
		permissions: BOT_PERMISSIONS.toString(),
	});
	return `https://discord.com/oauth2/authorize?${params.toString()}`;
}
