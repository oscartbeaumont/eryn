/**
 * The picker hint is what keeps a single-key provider's modal inside Discord's
 * three-second window, so its encoding is tested without a guild or a host.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { IntegrationMethodOption } from "../session/models.ts";
import { decodeProviderChoice, encodeProviderChoice, providerChoice } from "./provider-choice.ts";

function method(type: string, supported = true): IntegrationMethodOption {
	return { type, label: type, supported };
}

test("one supported key method is a key pick", () => {
	assert.equal(providerChoice([method("key")]), "key");
	assert.equal(encodeProviderChoice("opencode", [method("key")]), "opencode|k");
});

test("one supported non-key method is an oauth pick", () => {
	assert.equal(providerChoice([method("oauth")]), "oauth");
	assert.equal(encodeProviderChoice("github-copilot", [method("oauth")]), "github-copilot|o");
});

test("several supported methods need the fresh list", () => {
	assert.equal(providerChoice([method("key"), method("oauth")]), "many");
});

test("unsupported methods are ignored", () => {
	assert.equal(providerChoice([method("env", false)]), "none");
	assert.equal(providerChoice([method("key"), method("command", false)]), "key");
	assert.equal(providerChoice([]), "none");
});

test("a pick round-trips to its provider and hint", () => {
	assert.deepEqual(decodeProviderChoice("opencode|k"), { providerId: "opencode", choice: "key" });
	assert.deepEqual(decodeProviderChoice("opencode|o"), { providerId: "opencode", choice: "oauth" });
	assert.deepEqual(decodeProviderChoice("opencode|m"), { providerId: "opencode", choice: "many" });
	assert.deepEqual(decodeProviderChoice("opencode|n"), { providerId: "opencode", choice: "none" });
});

test("a value from an older screen has no hint and still names the provider", () => {
	assert.deepEqual(decodeProviderChoice("opencode"), { providerId: "opencode" });
	assert.deepEqual(decodeProviderChoice("opencode|?"), { providerId: "opencode|?" });
	assert.deepEqual(decodeProviderChoice("|k"), { providerId: "|k" });
	// A prototype key must not be mistaken for a hint.
	assert.deepEqual(decodeProviderChoice("opencode|toString"), { providerId: "opencode|toString" });
});
