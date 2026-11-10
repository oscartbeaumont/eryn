/**
 * The schedule scope is the authority for a turn with no speaker, so its
 * default and its comparisons are tested without Discord or a session.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Permission } from "../discord/permissions.ts";
import {
	addChannelToScope,
	addScheduleToScope,
	canCreateSchedule,
	canEditScheduleScope,
	defaultScheduleScope,
	removeChannelFromScope,
	removeScheduleFromScope,
	scopeAllows,
	scopeCoveredBy,
	type ScheduleScopeShape,
} from "./schedule-scope.ts";

const CAPABILITIES = {
	read: true,
	send: true,
	sendInThreads: true,
	manage: false,
	createThread: true,
	react: true,
};

const scope = (): ScheduleScopeShape =>
	defaultScheduleScope({
		ownerId: "owner",
		conversationId: "conversation",
		scheduleId: "schedule-1",
		capabilities: CAPABILITIES,
		now: 1,
	});

test("a new scope covers only the conversation, with the creator's capabilities", () => {
	const created = scope();
	assert.deepEqual(created.channels, {
		conversation: {
			read: true,
			send: true,
			sendInThreads: true,
			manage: false,
			createThread: true,
			react: true,
		},
	});
	assert.equal(created.ownerId, "owner");
	assert.deepEqual(created.scheduleIds, ["schedule-1"]);
	assert.equal(created.createdAt, 1);
	assert.equal(created.updatedAt, 1);
});

test("the default scope stores every capability instead of forcing any off", () => {
	const created = defaultScheduleScope({
		ownerId: "owner",
		conversationId: "conversation",
		scheduleId: "schedule-1",
		capabilities: { read: true, send: false, manage: true, createThread: false, react: true },
		now: 1,
	});
	assert.deepEqual(created.channels.conversation, {
		read: true,
		send: false,
		manage: true,
		createThread: false,
		react: true,
	});
});

test("read, send, manage, thread creation and reactions map to scope booleans", () => {
	const created = scope();
	assert.equal(
		scopeAllows(created, "conversation", Permission.ViewChannel | Permission.ReadMessageHistory),
		true,
	);
	assert.equal(scopeAllows(created, "conversation", Permission.ViewChannel | Permission.SendMessages), true);
	assert.equal(
		scopeAllows(created, "conversation", Permission.ViewChannel | Permission.SendMessagesInThreads),
		true,
	);
	assert.equal(scopeAllows(created, "conversation", Permission.ViewChannel | Permission.ManageMessages), false);
	assert.equal(scopeAllows(created, "conversation", Permission.ViewChannel | Permission.ManageThreads), false);
	assert.equal(
		scopeAllows(created, "conversation", Permission.ViewChannel | Permission.CreatePublicThreads),
		true,
	);
	assert.equal(scopeAllows(created, "conversation", Permission.ViewChannel | Permission.AddReactions), true);
	const limited = defaultScheduleScope({
		ownerId: "owner",
		conversationId: "conversation",
		scheduleId: "schedule-1",
		capabilities: { read: true, send: true, manage: false, createThread: false, react: false },
		now: 1,
	});
	assert.equal(
		scopeAllows(limited, "conversation", Permission.ViewChannel | Permission.CreatePublicThreads),
		false,
	);
	assert.equal(scopeAllows(limited, "conversation", Permission.ViewChannel | Permission.AddReactions), false);
});

test("adding a channel stores the editor's capabilities", () => {
	const created = addChannelToScope(scope(), "other", {
		read: true,
		send: false,
		sendInThreads: false,
		manage: true,
		createThread: false,
		react: true,
	});
	assert.deepEqual(created.channels.other, {
		read: true,
		send: false,
		sendInThreads: false,
		manage: true,
		createThread: false,
		react: true,
	});
});

test("a channel outside the scope is always denied", () => {
	assert.equal(scopeAllows(scope(), "elsewhere", Permission.ViewChannel), false);
});

test("an unknown permission bit fails closed", () => {
	assert.equal(scopeAllows(scope(), "conversation", Permission.ViewChannel | Permission.ManageGuild), false);
});

test("a participant must cover the scope, with extra permission allowed", () => {
	const created = addChannelToScope(scope(), "other", CAPABILITIES);
	const equal = {
		conversation: { read: true, send: true, sendInThreads: true, manage: false, createThread: true, react: true },
		other: { read: true, send: true, sendInThreads: true, manage: false, createThread: true, react: true },
	};
	const higher = {
		conversation: { read: true, send: true, sendInThreads: true, manage: true, createThread: true, react: true },
		other: { read: true, send: true, sendInThreads: true, manage: true, createThread: true, react: true },
	};
	const lower = {
		conversation: { read: true, send: false, sendInThreads: true, manage: false, createThread: true, react: true },
		other: { read: true, send: true, sendInThreads: true, manage: false, createThread: true, react: true },
	};
	const noThreads = {
		conversation: { read: true, send: true, sendInThreads: true, manage: false, createThread: false, react: true },
		other: { read: true, send: true, sendInThreads: true, manage: false, createThread: true, react: true },
	};
	const noReactions = {
		conversation: { read: true, send: true, sendInThreads: true, manage: false, createThread: true, react: false },
		other: { read: true, send: true, sendInThreads: true, manage: false, createThread: true, react: true },
	};
	const noThreadSend = {
		conversation: { read: true, send: true, sendInThreads: false, manage: false, createThread: true, react: true },
		other: { read: true, send: true, sendInThreads: true, manage: false, createThread: true, react: true },
	};
	assert.equal(scopeCoveredBy(created, equal), true);
	assert.equal(scopeCoveredBy(created, higher), true);
	assert.equal(scopeCoveredBy(created, lower), false);
	assert.equal(scopeCoveredBy(created, noThreads), false);
	assert.equal(scopeCoveredBy(created, noReactions), false);
	assert.equal(scopeCoveredBy(created, noThreadSend), false);
});

test("a scope stored before newer capabilities does not require them", () => {
	const old = defaultScheduleScope({
		ownerId: "owner",
		conversationId: "conversation",
		scheduleId: "schedule-1",
		capabilities: { read: true, send: true, manage: false },
		now: 1,
	});
	assert.equal(
		scopeCoveredBy(old, {
			conversation: { read: true, send: true, manage: false },
		}),
		true,
	);
});

test("a missing channel does not cover the scope", () => {
	const created = addChannelToScope(scope(), "other", CAPABILITIES);
	assert.equal(
		scopeCoveredBy(created, {
			conversation: { read: true, send: true, manage: false, createThread: true, react: true },
		}),
		false,
	);
});

test("only the owner or a server manager may edit the scope", () => {
	const created = scope();
	assert.equal(canEditScheduleScope(created, "owner", false), true);
	assert.equal(canEditScheduleScope(created, "someone-else", true), true);
	assert.equal(canEditScheduleScope(created, "someone-else", false), false);
});

test("only the original author may create another schedule", () => {
	const created = scope();
	assert.equal(canCreateSchedule(created, "owner"), true);
	assert.equal(canCreateSchedule(created, "someone-else"), false);
	assert.equal(canCreateSchedule(created, undefined), false);
	assert.equal(canCreateSchedule(undefined, "owner"), true);
	assert.equal(canCreateSchedule(undefined, undefined), false);
});

test("removing the last schedule leaves an empty id list for the caller to clear", () => {
	const created = removeScheduleFromScope(scope(), "schedule-1", 2);
	assert.deepEqual(created.scheduleIds, []);
});

test("the conversation channel is never removed from the scope", () => {
	const created = addChannelToScope(scope(), "other", CAPABILITIES);
	assert.deepEqual(removeChannelFromScope(created, "conversation", "conversation", 2).channels, created.channels);
	const without = removeChannelFromScope(created, "other", "conversation", 2);
	assert.equal(without.channels.other, undefined);
});

test("adding a schedule does not duplicate its id", () => {
	assert.deepEqual(addScheduleToScope(scope(), "schedule-1", 2).scheduleIds, ["schedule-1"]);
});
