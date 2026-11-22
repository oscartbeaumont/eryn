import assert from "node:assert/strict";
import { test } from "node:test";

import {
	canInvoke,
	defaultPolicy,
	permissionsFor,
	toolDecision,
} from "./policy.ts";
import type { RoleMapping, ServerPolicy } from "./policy.ts";

interface TestPolicy extends Omit<ServerPolicy, "roles"> {
	roles: RoleMapping[];
}

function policyWithRoles(roles: RoleMapping[] = []): TestPolicy {
	return { ...defaultPolicy("owner-1"), roles };
}

test("a fresh policy blocks everyone except the guild owner", () => {
	const policy = policyWithRoles();
	const guest = permissionsFor(policy, { id: "guest-1", roles: ["everyone"] });

	assert.equal(guest.invoke, false);
	assert.equal(toolDecision(guest, "send_message"), "block");
	assert.equal(canInvoke(policy, { id: "guest-1", roles: ["everyone"] }, "c1"), false);
	assert.equal(canInvoke(policy, { id: "owner-1" }, "c1"), true);
});

test("a role maps to a profile and can be overridden", () => {
	const policy = policyWithRoles();

	policy.roles.push({
		roleId: "member-role",
		roleName: "Member",
		profileId: "guest",
		overrides: { invoke: false },
	});

	const principal = { id: "member-1", roles: ["member-role"] };

	assert.equal(permissionsFor(policy, principal).invoke, false);
	policy.roles[0] = { ...policy.roles[0], overrides: { invoke: true, tools: { bash: "allow" } } };
	assert.equal(permissionsFor(policy, principal).invoke, true);
	assert.equal(toolDecision(permissionsFor(policy, principal), "bash"), "allow");
});

test("multiple roles are additive and a block wins", () => {
	const policy = policyWithRoles();

	policy.roles.push(
		{ roleId: "a", roleName: "A", profileId: "guest" },
		{ roleId: "b", roleName: "B", profileId: "member" },
		{ roleId: "c", roleName: "C", profileId: "guest", overrides: { tools: { bash: "block" } } },
	);

	const permissions = permissionsFor(policy, { id: "u", roles: ["a", "b", "c"] });

	assert.equal(permissions.invoke, true);
	assert.equal(toolDecision(permissions, "bash"), "block");
});

test("a wildcard block beats another role's exact allow", () => {
	const allow: RoleMapping = {
		roleId: "allow",
		roleName: "Allow",
		profileId: "member",
		overrides: { tools: { bash: "allow" } },
	};
	const block: RoleMapping = {
		roleId: "block",
		roleName: "Block",
		profileId: "guest",
		overrides: { tools: { "*": "block" } },
	};
	const principal = { id: "u", roles: ["allow", "block"] };

	const merged = permissionsFor(policyWithRoles([allow, block]), principal);

	assert.equal(toolDecision(merged, "bash"), "block");
	assert.equal(toolDecision(merged, "write"), "block");
	// The blocking role keeps its own explicit allowlist.
	assert.equal(toolDecision(merged, "send_message"), "allow");

	const reversed = permissionsFor(policyWithRoles([block, allow]), principal);

	assert.equal(toolDecision(reversed, "bash"), "block");
});

test("role overrides merge tool maps key by key", () => {
	const policy = policyWithRoles([
		{ roleId: "m", roleName: "M", profileId: "member", overrides: { tools: { bash: "allow" } } },
	]);
	const permissions = permissionsFor(policy, { id: "u", roles: ["m"] });

	assert.equal(toolDecision(permissions, "bash"), "allow");
	assert.equal(permissions.tools["*"], "allow");
	assert.equal(toolDecision(permissions, "write"), "allow");
	assert.equal(permissions.mcp["*"], "ask");
});

test("a channel override still applies after the role merge", () => {
	const policy: TestPolicy = {
		...policyWithRoles([{ roleId: "m", roleName: "M", profileId: "member" }]),
		channelOverrides: { c1: { tools: { bash: "block" } } },
	};

	const principal = { id: "u", roles: ["m"] };

	assert.equal(toolDecision(permissionsFor(policy, principal, "c1"), "bash"), "block");
	assert.equal(toolDecision(permissionsFor(policy, principal, "c1"), "write"), "allow");
	assert.equal(toolDecision(permissionsFor(policy, principal, "c2"), "bash"), "ask");
});

test("channel access and cross-channel sends use the permission set", () => {
	const policy = policyWithRoles();

	policy.roles.push({
		roleId: "limited",
		roleName: "Limited",
		profileId: "member",
		overrides: { channels: ["c1"], crossChannel: "block" },
	});

	const principal = { id: "u", roles: ["limited"] };

	assert.equal(canInvoke(policy, principal, "c1"), true);
	assert.equal(canInvoke(policy, principal, "c2"), false);
	assert.equal(
		toolDecision(permissionsFor(policy, principal), "send_message", {
			currentChannel: "c1",
			requestedChannel: "c2",
		}),
		"block",
	);
});

test("MCP tools match a server prefix or an exact tool", () => {
	const policy = policyWithRoles();

	policy.roles.push({
		roleId: "dev",
		roleName: "Dev",
		profileId: "guest",
		overrides: {
			mcp: { github: "ask", "github_create_issue": "allow" },
		},
	});

	const permissions = permissionsFor(policy, { id: "u", roles: ["dev"] });

	assert.equal(toolDecision(permissions, "github_create_issue", { mcpServers: ["github"] }), "allow");
	assert.equal(toolDecision(permissions, "github_list_issues", { mcpServers: ["github"] }), "ask");
});
