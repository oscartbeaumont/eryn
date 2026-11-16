/**
 * A message's text is what the model reads, so stripping the bot's ping must
 * not destroy the structure of the request. A code block or a list is content.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { DiscordMessage } from "../discord/socket.ts";
import { attachmentsOf, isReplyTo, stripMention, threadName } from "./message.ts";

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

function message(overrides: Partial<DiscordMessage>): DiscordMessage {
	return { id: "m1", channel_id: "c1", ...overrides };
}

test("a message's own attachments are carried", () => {
	const files = attachmentsOf(
		message({
			attachments: [
				{ url: "https://cdn.discordapp.com/a.png", filename: "a.png", content_type: "image/png", size: 10 },
			],
		}),
	);
	assert.deepEqual(files, [
		{ url: "https://cdn.discordapp.com/a.png", name: "a.png", contentType: "image/png", size: 10 },
	]);
});

test("a reply carries the attachments of the message it answers", () => {
	const files = attachmentsOf(
		message({
			referenced_message: message({
				id: "m0",
				attachments: [{ url: "https://cdn.discordapp.com/ticket.png", filename: "ticket.png" }],
			}),
		}),
	);
	assert.deepEqual(files, [{ url: "https://cdn.discordapp.com/ticket.png", name: "ticket.png" }]);
});

test("an attachment present on both messages is sent once", () => {
	const attachment = { url: "https://cdn.discordapp.com/same.png", filename: "same.png" };
	const files = attachmentsOf(
		message({
			attachments: [attachment],
			referenced_message: message({ id: "m0", attachments: [attachment] }),
		}),
	);
	assert.equal(files.length, 1);
});

test("an attachment without a URL is ignored", () => {
	const files = attachmentsOf(message({ attachments: [{ filename: "broken.png" }] }));
	assert.deepEqual(files, []);
});

test("a reply to one of Eryn's messages addresses it", () => {
	const reply = message({
		referenced_message: message({ id: "m0", author: { id: "eryn" } }),
	});
	assert.equal(isReplyTo(reply, "eryn"), true);
});

test("a reply to someone else does not address Eryn", () => {
	const reply = message({
		referenced_message: message({ id: "m0", author: { id: "oscar" } }),
	});
	assert.equal(isReplyTo(reply, "eryn"), false);
});

test("a message that is not a reply does not address Eryn", () => {
	assert.equal(isReplyTo(message({}), "eryn"), false);
});
