/**
 * Which of the bot's required permissions a guild is missing, and the link that
 * grants them in place.
 *
 * Discord applies the `permissions` parameter of a bot authorization to the
 * bot's existing managed role, so an admin can grant a permission added after
 * their install without removing the bot. Nothing in the guild's Durable
 * Object — config, workspace, history, links — is touched.
 */

import { BOT_PERMISSIONS, BOT_PERMISSION_LABELS, installUrl } from "../public.ts";

/** The permissions the bot lacks in a guild. */
export function missingPermissions(current: bigint): bigint {
	return BOT_PERMISSIONS & ~current;
}

/** The human names of the permissions the bot lacks. */
export function missingPermissionNames(current: bigint): string[] {
	const missing = missingPermissions(current);
	return BOT_PERMISSION_LABELS.filter(([bit]) => (missing & bit) !== 0n).map(([, label]) => label);
}

/**
 * A re-authorisation link for one guild.
 *
 * The requested permission mask is the union of what the role currently has and
 * what the bot needs, so granting one missing permission cannot remove a
 * permission an admin granted by hand.
 */
export function grantPermissionsUrl(clientId: string, guildId: string, current: bigint): string {
	return installUrl(clientId, { guildId, permissions: current | BOT_PERMISSIONS });
}
