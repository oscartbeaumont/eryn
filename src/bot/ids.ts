/**
 * The custom-id codec for Eryn's components and modals.
 *
 * A custom id is the only state a Discord button or modal carries, so each one
 * is a short base plus the values its handler needs. Discord caps an id at 100
 * characters. Install messages now live in the server, but older builds sent
 * them as DMs, and a DM has no guild context, so those ids also carry the guild
 * they configure.
 */

/** Discord's own id limit; our encoded ids must stay under it. */
const MAX_CUSTOM_ID = 100;

/**
 * The setup menu. It is the root of the flow, and the install message's first
 * button opens it with no id of its own.
 */
export const SETUP_MENU_ID = "setup:menu";

/** Dismiss the ephemeral setup message; shared by every screen. */
export const SETUP_CLOSE_ID = "setup:close";

/** A DM has no guild context, so every id raised from an install DM carries the guild id. */
const INSTALL_PREFIX = "install:setup:";

/** Keep an id inside Discord's limit rather than letting the send fail. */
function clip(value: string): string {
	return value.length > MAX_CUSTOM_ID ? value.slice(0, MAX_CUSTOM_ID) : value;
}

/**
 * A base id, scoped to the install DM's guild when there is one. The same
 * builder is used everywhere, which lets one dispatcher serve both a guild and
 * an install DM sent by an older build.
 */
export function scopedId(base: string, dmGuildId?: string): string {
	return clip(dmGuildId ? `${INSTALL_PREFIX}${dmGuildId}:${base}` : base);
}

/** Split an install-flow id back into its base and the guild it belongs to. */
export function unmarshalId(customId: string): { id: string; dmGuildId?: string } {
	if (!customId.startsWith(INSTALL_PREFIX)) return { id: customId };
	const rest = customId.slice(INSTALL_PREFIX.length);
	const separator = rest.indexOf(":");
	// The install DM's "Start setup" button is `install:setup:<guildId>` with no
	// base; it opens the menu.
	if (separator < 0) return { id: SETUP_MENU_ID, dmGuildId: rest || undefined };
	return { id: rest.slice(separator + 1) || SETUP_MENU_ID, dmGuildId: rest.slice(0, separator) || undefined };
}

/** An id family whose payload follows a fixed prefix, e.g. `setup:method:<id>:<method>`. */
export function payloadId(prefix: string) {
	return {
		/** The id for a payload, scoped to the install DM's guild when there is one. */
		of: (payload: string, dmGuildId?: string): string => scopedId(prefix + payload, dmGuildId),
		/** The payload of one of these ids, or undefined when the id belongs to another flow. */
		read: (customId: string): string | undefined =>
			customId.startsWith(prefix) ? customId.slice(prefix.length) : undefined,
	};
}
