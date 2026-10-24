/**
 * Discord ids and permission bits shared by the Worker and the browser bundle.
 * Dependency-free on purpose, so it is safe to import from client code.
 */

/** Eryn's public Discord application id (equal to the bot user id). */
export const CLIENT_ID = "1561290858668494959";

/** Bot permissions requested on install: View Channels, Send Messages, Read
 * Message History, Create Public Threads, Send Messages in Threads. */
export const BOT_PERMISSIONS = [
	1n << 10n,
	1n << 11n,
	1n << 16n,
	1n << 34n,
	1n << 38n,
].reduce((all, permission) => all | permission, 0n);
