/**
 * Project locations are path input derived from Discord ids, so the fallback
 * and the numeric check are tested without a host.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { channelProjectDirectory, LOCATION } from "./locations.ts";

test("a channel gets its own project directory under the deployment root", () => {
	assert.equal(channelProjectDirectory("123456789012345678"), `${LOCATION}/channels/123456789012345678`);
});

test("a missing channel id falls back to the shared deployment root", () => {
	assert.equal(channelProjectDirectory(undefined), LOCATION);
	assert.equal(channelProjectDirectory(""), LOCATION);
});

test("a non-numeric id cannot become a path segment", () => {
	assert.equal(channelProjectDirectory("../other"), LOCATION);
	assert.equal(channelProjectDirectory("123/456"), LOCATION);
	assert.equal(channelProjectDirectory("/etc/passwd"), LOCATION);
});
