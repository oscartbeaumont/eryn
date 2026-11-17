/**
 * `DiscordAuthority` caches channel metadata, so listing threads must not fetch
 * the same parent once per thread: a burst of identical requests burns the
 * Discord rate limit and a failed lookup drops the thread from the result.
 *
 * Run with: `pnpm test` (Node's built-in runner with type stripping).
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DiscordAuthority } from "./authority.ts";
import type { DiscordChannelRef, DiscordRest } from "./api.ts";

const guildId = "guild";

type ReadMethods = Pick<DiscordRest, "guildRoles" | "guildInfo" | "guildMember" | "channel">;

function createAuthority(rest: ReadMethods): DiscordAuthority {
	// SAFETY: `filterVisible` only reaches these four read methods; authorization
	// still runs through the real permission resolver.
	return new DiscordAuthority(rest as DiscordRest, guildId);
}

function ownerRest(channelCalls: string[]): ReadMethods {
	return {
		guildRoles: async () => [{ id: guildId, name: "@everyone", managed: false, permissions: "0" }],
		guildInfo: async () => ({ ownerId: "owner" }),
		guildMember: async () => ({ roles: [] }),
		channel: async (channelId: string) => {
			channelCalls.push(channelId);

			return { id: channelId, type: 0, name: `channel ${channelId}` };
		},
	};
}

function thread(id: string, parentId: string): DiscordChannelRef {
	return { id, type: 11, parent_id: parentId, name: id };
}

test("filterVisible fetches a shared parent once for every thread under it", async () => {
	const channelCalls: string[] = [];
	const authority = createAuthority(ownerRest(channelCalls));
	const threads = [thread("t1", "parent"), thread("t2", "parent"), thread("t3", "parent")];

	const visible = await authority.filterVisible("owner", threads);

	assert.deepEqual(channelCalls, ["parent"]);
	assert.deepEqual(
		visible.map((item) => item.id),
		["t1", "t2", "t3"],
	);
});

test("filterVisible fetches each distinct parent exactly once", async () => {
	const channelCalls: string[] = [];
	const authority = createAuthority(ownerRest(channelCalls));
	const threads = [thread("t1", "a"), thread("t2", "b"), thread("t3", "a")];

	await authority.filterVisible("owner", threads);

	assert.deepEqual([...channelCalls].sort(), ["a", "b"]);
});
