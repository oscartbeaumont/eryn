/**
 * A failed turn has to tell the reader what actually went wrong. The provider's
 * message is quoted verbatim, and the hint has to match the failure: an empty
 * account, a rejected key, and a missing model need different actions.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { renderFailure } from "./render.ts";

test("an exhausted provider account gets the usage hint", () => {
	const rendered = renderFailure(
		"OpenCode Go weekly usage limit reached. Switch to a free model, or turn on Extra Usage on the Go page in OpenCode Console to keep going.",
	);
	assert.match(rendered, /out of credit or usage/);
	assert.match(rendered, /Extra Usage/);
	assert.match(rendered, /weekly usage limit reached/);
});

test("a rejected credential gets the key hint", () => {
	assert.match(renderFailure("401 Unauthorized"), /key for this server was rejected/);
});

test("a removed model gets the model hint", () => {
	assert.match(renderFailure("model unavailable"), /model for this server is no longer available/);
});

test("a long provider body is trimmed below Discord's message limit", () => {
	const rendered = renderFailure("x".repeat(5_000));
	assert.ok(rendered.length < 2_000, `rendered failure was ${rendered.length} characters`);
	assert.match(rendered, /…/);
});
