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
 * Every permission the bot's tools use, with the label shown to an admin when
 * one is missing. The mask and the labels come from this one list, so a tool
 * cannot be added without its permission appearing in the setup warning.
 */
export const BOT_PERMISSION_LABELS: readonly (readonly [bigint, string])[] = [
	[1n << 7n, "View Audit Log"],
	[1n << 6n, "Add Reactions"],
	[1n << 10n, "View Channels"],
	[1n << 11n, "Send Messages"],
	[1n << 13n, "Manage Messages"],
	[1n << 14n, "Embed Links"],
	[1n << 15n, "Attach Files"],
	[1n << 16n, "Read Message History"],
	[1n << 34n, "Manage Threads"],
	[1n << 35n, "Create Public Threads"],
	[1n << 38n, "Send Messages in Threads"],
];

/** The permissions the bot needs, combined into one mask. */
export const BOT_PERMISSIONS = BOT_PERMISSION_LABELS.reduce((mask, [bit]) => mask | bit, 0n);

/**
 * The Discord authorization screen for the bot.
 *
 * With a `guildId`, Discord preselects that server and applies `permissions` to
 * the bot's existing managed role, so an installed bot can be granted a
 * permission it did not ask for originally without being removed. The caller
 * passes the union of the role's current permissions and the required set, so
 * a permission an admin granted by hand is preserved.
 */
export function installUrl(
	clientId: string,
	options: { guildId?: string; permissions?: bigint } = {},
): string {
	const params = new URLSearchParams({
		client_id: clientId,
		scope: "bot applications.commands",
		permissions: (options.permissions ?? BOT_PERMISSIONS).toString(),
	});
	if (options.guildId) {
		params.set("guild_id", options.guildId);
		params.set("disable_guild_select", "true");
	}
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
