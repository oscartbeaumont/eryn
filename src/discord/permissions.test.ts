/**
 * The permission resolver is the security boundary for every Discord tool, so
 * its cases are tested directly instead of through a live guild.
 *
 * Run with: `pnpm test` (Node's built-in runner with type stripping).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
	ALL_PERMISSIONS,
	effectivePermissions,
	guildPermissions,
	hasPermission,
	Permission,
	type PermissionChannel,
	type PermissionOverwriteLike,
	type PermissionRole,
} from "./permissions.ts";

const GUILD = "guild-1";

const EVERYONE_VIEW = { id: GUILD, type: 0, allow: Permission.ViewChannel.toString(), deny: "0" };

function role(id: string, position: number, permissions: bigint | undefined): PermissionRole {
	return {
		id,
		position,
		...(permissions === undefined ? {} : { permissions: permissions.toString() }),
	};
}

function channel(
	type: number,
	overwrites?: readonly PermissionOverwriteLike[],
	parentId?: string,
): PermissionChannel {
	return {
		id: "channel-1",
		type,
		...(parentId ? { parent_id: parentId } : {}),
		...(overwrites ? { permission_overwrites: overwrites } : {}),
	};
}

const base = {
	guildId: GUILD,
	userId: "user-1",
	roles: [role(GUILD, 0, 0n)],
	memberRoleIds: [] as string[],
};

test("the guild owner has every permission", () => {
	const permissions = guildPermissions({ ...base, ownerId: "user-1" });
	assert.equal(permissions, ALL_PERMISSIONS);
});

test("a role with Administrator implies every permission", () => {
	const permissions = guildPermissions({
		...base,
		roles: [role(GUILD, 0, 0n), role("admin", 1, Permission.Administrator)],
		memberRoleIds: ["admin"],
	});
	assert.equal(permissions, ALL_PERMISSIONS);
});

test("an @everyone ViewChannel deny removes the bit", () => {
	const permissions = effectivePermissions({
		...base,
		channel: channel(0, [{ id: GUILD, type: 0, allow: "0", deny: Permission.ViewChannel.toString() }]),
	});
	assert.equal(hasPermission(permissions, Permission.ViewChannel), false);
});

test("a role allow overrides an @everyone deny", () => {
	const permissions = effectivePermissions({
		...base,
		roles: [role(GUILD, 0, 0n), role("viewer", 1, 0n)],
		memberRoleIds: ["viewer"],
		channel: channel(0, [
			{ id: GUILD, type: 0, allow: "0", deny: Permission.ViewChannel.toString() },
			{ id: "viewer", type: 0, allow: Permission.ViewChannel.toString(), deny: "0" },
		]),
	});
	assert.equal(hasPermission(permissions, Permission.ViewChannel), true);
});

test("a member overwrite deny overrides a role allow", () => {
	const permissions = effectivePermissions({
		...base,
		roles: [role(GUILD, 0, 0n), role("viewer", 1, Permission.ViewChannel)],
		memberRoleIds: ["viewer"],
		channel: channel(0, [
			{ id: "viewer", type: 0, allow: Permission.ViewChannel.toString(), deny: "0" },
			{ id: "user-1", type: 1, allow: "0", deny: Permission.ViewChannel.toString() },
		]),
	});
	assert.equal(hasPermission(permissions, Permission.ViewChannel), false);
});

test("a higher role allow beats a lower role deny", () => {
	const permissions = effectivePermissions({
		...base,
		roles: [role(GUILD, 0, 0n), role("lower", 1, 0n), role("higher", 5, 0n)],
		memberRoleIds: ["lower", "higher"],
		channel: channel(0, [
			{ id: "lower", type: 0, allow: "0", deny: Permission.ViewChannel.toString() },
			{ id: "higher", type: 0, allow: Permission.ViewChannel.toString(), deny: "0" },
			EVERYONE_VIEW,
		]),
	});
	assert.equal(hasPermission(permissions, Permission.ViewChannel), true);
});

test("a higher role deny beats a lower role allow", () => {
	const permissions = effectivePermissions({
		...base,
		roles: [role(GUILD, 0, 0n), role("lower", 1, 0n), role("higher", 5, 0n)],
		memberRoleIds: ["lower", "higher"],
		channel: channel(0, [
			{ id: "lower", type: 0, allow: Permission.ViewChannel.toString(), deny: "0" },
			{ id: "higher", type: 0, allow: "0", deny: Permission.ViewChannel.toString() },
			EVERYONE_VIEW,
		]),
	});
	assert.equal(hasPermission(permissions, Permission.ViewChannel), false);
});

test("a thread without its own overwrites uses its parent's", () => {
	const permissions = effectivePermissions({
		...base,
		channel: channel(11, undefined, "parent-1"),
		parent: {
			id: "parent-1",
			type: 0,
			permission_overwrites: [
				{ id: GUILD, type: 0, allow: "0", deny: Permission.ViewChannel.toString() },
			],
		},
	});
	assert.equal(hasPermission(permissions, Permission.ViewChannel), false);
});

test("a thread's own overwrites take precedence over its parent's", () => {
	const permissions = effectivePermissions({
		...base,
		channel: channel(11, [EVERYONE_VIEW], "parent-1"),
		parent: {
			id: "parent-1",
			type: 0,
			permission_overwrites: [
				{ id: GUILD, type: 0, allow: "0", deny: Permission.ViewChannel.toString() },
			],
		},
	});
	assert.equal(hasPermission(permissions, Permission.ViewChannel), true);
});

test("an empty thread overwrite list still inherits the parent's deny", () => {
	const permissions = effectivePermissions({
		...base,
		channel: channel(11, [], "parent-1"),
		parent: {
			id: "parent-1",
			type: 0,
			permission_overwrites: [
				{ id: GUILD, type: 0, allow: "0", deny: Permission.ViewChannel.toString() },
			],
		},
	});
	assert.equal(hasPermission(permissions, Permission.ViewChannel), false);
});

test("a non-member cannot view a private thread", () => {
	const permissions = effectivePermissions({
		...base,
		roles: [role(GUILD, 0, Permission.ViewChannel)],
		channel: channel(12, undefined, "parent-1"),
		parent: { id: "parent-1", type: 0 },
		isThreadMember: false,
	});
	assert.equal(hasPermission(permissions, Permission.ViewChannel), false);
});

test("a private thread member can view it", () => {
	const permissions = effectivePermissions({
		...base,
		roles: [role(GUILD, 0, Permission.ViewChannel)],
		channel: channel(12, undefined, "parent-1"),
		parent: { id: "parent-1", type: 0 },
		isThreadMember: true,
	});
	assert.equal(hasPermission(permissions, Permission.ViewChannel), true);
});

test("a member whose role permissions are missing gets no permission", () => {
	const permissions = effectivePermissions({
		...base,
		roles: [role(GUILD, 0, 0n), role("broken", 1, undefined)],
		memberRoleIds: ["broken"],
		channel: channel(0),
	});
	assert.equal(permissions, 0n);
	assert.equal(hasPermission(permissions, Permission.ViewChannel), false);
});

test("a member whose role was not returned gets no permission", () => {
	const permissions = effectivePermissions({
		...base,
		roles: [role(GUILD, 0, 0n)],
		memberRoleIds: ["gone"],
		channel: channel(0),
	});
	assert.equal(permissions, 0n);
});
