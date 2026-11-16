/**
 * The setup screen's permission check is what lets an existing install catch up
 * with a permission a new tool needs, so its mask and link are tested directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { BOT_PERMISSIONS, installUrl } from "../public.ts";
import { grantPermissionsUrl, missingPermissionNames, missingPermissions } from "./permissions.ts";

test("a role with no permissions is missing every required permission", () => {
	assert.equal(missingPermissions(0n), BOT_PERMISSIONS);
	assert.equal(missingPermissionNames(0n).length, 11);
});

test("a role with every required permission is missing nothing", () => {
	assert.equal(missingPermissions(BOT_PERMISSIONS), 0n);
	assert.deepEqual(missingPermissionNames(BOT_PERMISSIONS), []);
});

test("only the absent bits are named", () => {
	const withoutAttach = BOT_PERMISSIONS & ~(1n << 15n);
	assert.deepEqual(missingPermissionNames(withoutAttach), ["Attach Files"]);
	// The other way around: a permission the bot does not need is irrelevant.
	assert.deepEqual(missingPermissionNames(BOT_PERMISSIONS | (1n << 40n)), []);
});

test("an administrator role is treated as holding every permission", () => {
	const administrator = (1n << 64n) - 1n;
	assert.deepEqual(missingPermissionNames(administrator), []);
});

test("the re-authorisation link preselects the guild and removes nothing", () => {
	const extra = 1n << 40n;
	const current = extra | (1n << 15n);
	const url = new URL(grantPermissionsUrl("client-1", "guild-1", current));

	assert.equal(url.searchParams.get("guild_id"), "guild-1");
	assert.equal(url.searchParams.get("disable_guild_select"), "true");
	const requested = BigInt(url.searchParams.get("permissions") ?? "0");
	assert.equal((requested & current) === current, true, "an existing permission must survive");
	assert.equal((requested & BOT_PERMISSIONS) === BOT_PERMISSIONS, true, "every required bit must be asked for");
});

test("a plain install link still asks for the required permissions", () => {
	const url = new URL(installUrl("client-1"));
	assert.equal(url.searchParams.get("permissions"), BOT_PERMISSIONS.toString());
	assert.equal(url.searchParams.get("guild_id"), null);
	assert.equal(url.searchParams.get("disable_guild_select"), null);
});
