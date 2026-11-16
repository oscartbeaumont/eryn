/**
 * A message's text is what the model reads, so stripping the bot's ping must
 * not destroy the structure of the request. A code block or a list is content.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { stripMention, threadName } from "./message.ts";

const BOT = "bot-1";
const ROLE = "role-1";

test("a ping becomes Eryn's name", () => {
	assert.equal(stripMention(`<@${BOT}> what time is it`, BOT), "Eryn what time is it");
	assert.equal(stripMention(`what time is it <@!${BOT}>`, BOT), "what time is it Eryn");
});

test("a message that is only a ping stays empty", () => {
	assert.equal(stripMention(`<@${BOT}>`, BOT), "");
	assert.equal(stripMention(`  <@${BOT}>  `, BOT), "");
	assert.equal(stripMention(`<@&${ROLE}>`, BOT, ROLE), "");
});

test("a managed-role ping is stripped like a user ping", () => {
	assert.equal(stripMention(`<@&${ROLE}> fix this`, BOT, ROLE), "Eryn fix this");
});

test("line structure survives, so a fenced block reaches the model intact", () => {
	const message = [
		`<@${BOT}> fix this:`,
		"```js",
		"const x = 1;",
		"```",
	].join("\n");
	assert.equal(stripMention(message, BOT), ["Eryn fix this:", "```js", "const x = 1;", "```"].join("\n"));
});

test("indented code keeps its indentation", () => {
	const message = [`<@${BOT}> look:`, "    indented()"].join("\n");
	assert.equal(stripMention(message, BOT), ["Eryn look:", "    indented()"].join("\n"));
});

test("a thread name is still flattened to one line", () => {
	assert.equal(threadName("first\nsecond\tthird"), "first second third");
});
