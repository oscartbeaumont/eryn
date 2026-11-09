/**
 * Public values shared by the Worker and the prerendered landing page.
 *
 * The landing page is built outside the Worker, so anything both sides need
 * lives here rather than behind a Worker-only module.
 */

/** Eryn's public Discord application id (equal to the bot user id). */
export const CLIENT_ID = "1561290858668494959";

/**
 * View Audit Log (so the install message can find who added the bot), View
 * Channels, Send Messages, Read Message History, Create Public Threads, and
 * Send Messages in Threads.
 */
const BOT_PERMISSIONS =
	(1n << 7n) | (1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 35n) | (1n << 38n);

/** The Discord authorization screen that installs the bot into a server. */
export function installUrl(): string {
	const params = new URLSearchParams({
		client_id: CLIENT_ID,
		scope: "bot applications.commands",
		permissions: BOT_PERMISSIONS.toString(),
	});
	return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

/** Brand image paths, served from `assets/brand/` by the Worker. */
export const BRAND = {
	banner: "/brand/banner.webp",
	mark: "/brand/mark.webp",
	icon: "/brand/icon-64.png",
	appleIcon: "/brand/apple-touch-icon.png",
	favicon: "/favicon.ico",
} as const;
