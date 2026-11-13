/**
 * Public values shared by the Worker and the server-rendered landing page.
 *
 * The landing page is built outside the Worker, so anything both sides need
 * lives here rather than behind a Worker-only module.
 */

/** Eryn's public Discord application id (equal to the bot user id). */
export const CLIENT_ID = "1561290858668494959";

/** The public origin used in absolute links when no binding overrides it. */
export const DEFAULT_PUBLIC_ORIGIN = "https://eryn.otbeaumont.me";

/**
 * The website's PostHog project. A project token is write-only and safe to
 * ship in a page; the server-side capture key is a secret and is not this.
 */
export const POSTHOG_PROJECT_TOKEN = "phc_oQtUDRPaAeG4gutXrPA4R4eyWCY99mjWpMF8KZfjHgt2";

/**
 * The Worker path that proxies PostHog, so a blocker does not mistake the
 * ingestion request for analytics. It is deliberately not named `posthog`.
 */
export const POSTHOG_PROXY_PATH = "/ph_7Qm2";

/**
 * View Audit Log (so the install message can find who added the bot), View
 * Channels, Send Messages, Read Message History, Manage Threads (so mentions in
 * threads Eryn did not create are delivered), Create Public Threads, and Send
 * Messages in Threads.
 */
const BOT_PERMISSIONS =
	(1n << 7n) | (1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 34n) | (1n << 35n) | (1n << 38n);

/** The Discord authorization screen that installs the bot into a server. */
export function installUrl(clientId: string): string {
	const params = new URLSearchParams({
		client_id: clientId,
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
