/**
 * A schedule's Discord reach, stored on the conversation's context.
 *
 * Schedules run without a person, so they cannot borrow someone's permissions.
 * Instead they carry a capability scope: the channels they may read, send in,
 * and manage. The scope is deliberately separate from the conversation policy;
 * MCP, workspace, web, and subagents remain governed by that policy.
 */

import { Permission } from "../discord/permissions.ts";

/** What one channel in a schedule scope allows. */
export interface ScopeChannelCapabilities {
	readonly read: boolean;
	readonly send: boolean;
	readonly manage: boolean;
}

/** A schedule scope as it is stored in session metadata. */
export interface ScheduleScopeShape {
	readonly ownerId: string;
	readonly scheduleIds: readonly string[];
	readonly channels: Readonly<Record<string, ScopeChannelCapabilities>>;
	readonly createdAt: number;
	readonly updatedAt: number;
}

/** The permissions a participant has in one channel, used to cover a scope. */
export type ChannelCapabilities = ScopeChannelCapabilities;

/**
 * The scope a new schedule starts with: only the conversation itself, with
 * read and send. Managing messages or reaching other channels is an explicit
 * later decision on a human turn.
 */
export const DEFAULT_SCOPE = { read: true, send: true, manage: false } as const;

export function defaultScheduleScope(input: {
	ownerId: string;
	conversationId: string;
	scheduleId: string;
	now?: number;
}): ScheduleScopeShape {
	const now = input.now ?? Date.now();
	return {
		ownerId: input.ownerId,
		scheduleIds: [input.scheduleId],
		channels: { [input.conversationId]: { ...DEFAULT_SCOPE } },
		createdAt: now,
		updatedAt: now,
	};
}

/**
 * Whether a schedule may perform an action in one channel.
 *
 * `required` is the same permission mask the Discord tools use. Every action
 * also needs the channel to be in the scope at all; ViewChannel is implied by
 * that membership. Unknown bits deny, so a new tool requirement cannot silently
 * pass through a scope written before it existed.
 */
export function scopeAllows(
	scope: ScheduleScopeShape,
	channelId: string,
	required: bigint,
): boolean {
	const allowed = scope.channels[channelId];
	if (!allowed) return false;
	const known =
		Permission.ViewChannel |
		Permission.ReadMessageHistory |
		Permission.SendMessages |
		Permission.SendMessagesInThreads |
		Permission.ManageMessages |
		Permission.ManageThreads;
	if ((required & ~known) !== 0n) return false;
	if ((required & Permission.ReadMessageHistory) !== 0n && !allowed.read) return false;
	if (
		(required & (Permission.SendMessages | Permission.SendMessagesInThreads)) !== 0n &&
		!allowed.send
	) {
		return false;
	}
	if ((required & (Permission.ManageMessages | Permission.ManageThreads)) !== 0n && !allowed.manage) {
		return false;
	}
	return true;
}

/**
 * Whether a person can do everything the schedule can.
 *
 * The comparison is a superset check: having more permissions than the
 * schedule is fine, and having fewer in any one channel is not.
 */
export function scopeCoveredBy(
	scope: ScheduleScopeShape,
	actual: Record<string, ChannelCapabilities | undefined>,
): boolean {
	return Object.entries(scope.channels).every(([channelId, required]) => {
		const have = actual[channelId];
		if (!have) return false;
		return (
			(!required.read || have.read) &&
			(!required.send || have.send) &&
			(!required.manage || have.manage)
		);
	});
}

/** Whether this person may change the scope: its owner or a server manager. */
export function canEditScheduleScope(
	scope: ScheduleScopeShape,
	userId: string,
	manager: boolean,
): boolean {
	return manager || scope.ownerId === userId;
}

/**
 * Whether this person may create a schedule in a conversation.
 *
 * Only one author may create schedules in one conversation, so a second person
 * cannot attach their schedule to someone else's reach.
 */
export function canCreateSchedule(
	scope: ScheduleScopeShape | undefined,
	authorId: string | undefined,
): boolean {
	if (!authorId) return false;
	return scope === undefined || scope.ownerId === authorId;
}

/** Add a channel to a scope, leaving an existing entry unchanged. */
export function addChannelToScope(
	scope: ScheduleScopeShape,
	channelId: string,
	now = Date.now(),
): ScheduleScopeShape {
	if (scope.channels[channelId]) return scope;
	return {
		...scope,
		channels: { ...scope.channels, [channelId]: { ...DEFAULT_SCOPE } },
		updatedAt: now,
	};
}

/** Remove a channel from a scope, but never the conversation itself. */
export function removeChannelFromScope(
	scope: ScheduleScopeShape,
	channelId: string,
	conversationId: string,
	now = Date.now(),
): ScheduleScopeShape {
	if (channelId === conversationId || !scope.channels[channelId]) return scope;
	const channels = { ...scope.channels };
	delete channels[channelId];
	return { ...scope, channels, updatedAt: now };
}

/** Add a schedule id to a scope. */
export function addScheduleToScope(
	scope: ScheduleScopeShape,
	scheduleId: string,
	now = Date.now(),
): ScheduleScopeShape {
	if (scope.scheduleIds.includes(scheduleId)) return scope;
	return { ...scope, scheduleIds: [...scope.scheduleIds, scheduleId], updatedAt: now };
}

/** Remove a schedule id from a scope. The caller clears the scope when empty. */
export function removeScheduleFromScope(
	scope: ScheduleScopeShape,
	scheduleId: string,
	now = Date.now(),
): ScheduleScopeShape {
	return {
		...scope,
		scheduleIds: scope.scheduleIds.filter((id) => id !== scheduleId),
		updatedAt: now,
	};
}
