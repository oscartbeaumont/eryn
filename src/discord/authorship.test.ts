/**
 * The bot-author guard keeps a watched message from becoming an internal
 * thread→prompt loop, so its cases are tested directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isBotAuthored } from "./authorship.ts";

test("a bot-authored message is refused", () => {
	assert.equal(isBotAuthored({ author: { id: "other-bot", bot: true } }, "eryn"), true);
});

test("the bot's own message is refused even without the bot flag", () => {
	assert.equal(isBotAuthored({ author: { id: "eryn" } }, "eryn"), true);
});

test("a webhook message is refused", () => {
	assert.equal(
		isBotAuthored({ author: { id: "webhook" }, webhook_id: "webhook-1" }, "eryn"),
		true,
	);
});

test("a human message is allowed", () => {
	assert.equal(isBotAuthored({ author: { id: "user-1", bot: false } }, "eryn"), false);
});
