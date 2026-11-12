/**
 * The policy layer decides what the agent may do in a conversation. These
 * tests pin the profile defaults, inheritance, and the permission rules they
 * compile to, so a profile cannot silently widen what a channel allows.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { PolicyProfile } from "./models.ts";
import {
	compilePermissions,
	isDefaultPolicy,
	matchProfile,
	policyTitle,
	profileDefinition,
	profileList,
	resolvePolicy,
} from "./policy.ts";

const custom: PolicyProfile = {
	id: "research-abc",
	name: "Research",
	tools: {
		workspace: "allow",
		edit: "block",
		shell: "allow",
		"discord-reply": "allow",
		"discord-thread": "allow",
		"discord-channel": "block",
		"discord-manage": "block",
		"cross-channel": "block",
		web: "allow",
		subagent: "block",
	},
	mcp: { "*": "block" },
	createdAt: 1,
	updatedAt: 1,
};

test("a channel with no override gets Standard", () => {
	const policy = resolvePolicy([]);
	assert.equal(policy.profile, "standard");
	assert.equal(policy.tools?.web, "allow");
	assert.equal(policy.tools?.shell, "allow");
	assert.equal(policy.tools?.["cross-channel"], "block");
	assert.equal(policy.tools?.["discord-channel"], "block");
	assert.equal(policy.mcp?.["*"], "allow");
});

test("a channel can override the server default with Full or None", () => {
	const full = resolvePolicy([{ profile: "standard" }, { profile: "full" }]);
	assert.equal(full.profile, "full");
	assert.equal(full.tools?.["cross-channel"], "allow");

	const none = resolvePolicy([{ profile: "full" }, { profile: "none" }]);
	assert.equal(none.profile, "none");
	assert.equal(none.tools?.["discord-reply"], "block");
	assert.equal(none.mcp?.["*"], "block");
});

test("a server default is inherited until a channel names another profile", () => {
	const server = { profile: "full" };
	assert.equal(resolvePolicy([server]).profile, "full");
	assert.equal(resolvePolicy([server, { profile: "none" }]).profile, "none");
});

test("group overrides apply on top of the selected profile", () => {
	const policy = resolvePolicy([{ profile: "standard" }, { tools: { shell: "ask" } }]);
	assert.equal(policy.profile, "standard");
	assert.equal(policy.tools?.shell, "ask");
	assert.equal(policy.tools?.web, "allow");
});

test("a custom profile is selectable and can be overridden per channel", () => {
	const selected = resolvePolicy([{ profile: custom.id }], [custom]);
	assert.equal(selected.profile, custom.id);
	assert.equal(selected.tools?.edit, "block");
	assert.equal(selected.tools?.web, "allow");

	const overridden = resolvePolicy([{ profile: custom.id }, { tools: { edit: "allow" } }], [custom]);
	assert.equal(overridden.tools?.edit, "allow");
});

test("an unknown profile falls back to Standard instead of widening access", () => {
	const policy = resolvePolicy([{ profile: "removed-profile" }]);
	assert.equal(policy.profile, "standard");
	assert.equal(policy.tools?.["cross-channel"], "block");
	const channel = resolvePolicy([{ profile: "full" }, { profile: "removed-profile" }]);
	assert.equal(channel.profile, "standard");
	assert.equal(channel.tools?.["cross-channel"], "block");
});

test("legacy stored presets still resolve", () => {
	const locked = resolvePolicy([{ preset: "locked" }]);
	assert.equal(locked.profile, "locked");
	assert.equal(locked.tools?.["discord-reply"], "allow");
	assert.equal(locked.tools?.web, "block");
});

test("Standard is the default policy and Full is not", () => {
	assert.equal(isDefaultPolicy(resolvePolicy([])), true);
	assert.equal(isDefaultPolicy(resolvePolicy([{ profile: "full" }])), false);
	assert.equal(isDefaultPolicy(resolvePolicy([{ profile: custom.id }], [custom])), false);
});

test("Standard compiles denies for other-channel reach but not web or shell", () => {
	const rules = compilePermissions(resolvePolicy([]), []);
	const effect = (action: string) => rules.find((rule) => rule.action === action)?.effect;

	assert.equal(effect("bash"), undefined);
	assert.equal(effect("websearch"), undefined);
	assert.equal(effect("discord_send_message"), undefined);
	assert.equal(effect("discord_join_channel"), "deny");
	assert.equal(effect("discord.cross-channel"), "deny");
});

test("None hides every tool, including the reply tool", () => {
	const rules = compilePermissions(resolvePolicy([{ profile: "none" }]), []);
	const effect = (action: string) => rules.find((rule) => rule.action === action)?.effect;

	assert.equal(effect("discord_send_message"), "deny");
	assert.equal(effect("bash"), "deny");
	assert.equal(effect("websearch"), "deny");
	assert.equal(effect("read"), "deny");
});

test("a custom profile is named in the title and matched by its id", () => {
	const policy = resolvePolicy([{ profile: custom.id }], [custom]);
	assert.equal(matchProfile(policy, [custom]), custom.id);
	assert.equal(policyTitle(policy, [custom]), "Research");
	assert.equal(profileList([custom]).at(-1)?.name, "Research");
	assert.equal(profileDefinition(custom.id, [custom])?.tools.web, "allow");
});
