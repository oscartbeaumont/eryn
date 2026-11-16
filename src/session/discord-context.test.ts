/**
 * The Discord context block is how the agent learns which channel and thread a
 * turn belongs to, so the prompt hook has to be able to tell it apart from the
 * prose that mentions `<discord ... />` in the seeded instructions and skills.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { describeDiscordContext, DISCORD_MARKER } from "../plugins/discord/context.ts";

const context = {
	guild: { id: "guild-1", name: "A Server" },
	channel: { id: "channel-1", name: "general" },
	thread: { id: "thread-1", name: "a thread" },
	kind: "thread" as const,
};

test("the rendered context carries the marker the prompt hook looks for", () => {
	const rendered = describeDiscordContext(context);
	assert.ok(rendered.includes(DISCORD_MARKER));
	assert.ok(rendered.includes('threadId="thread-1"'));
	assert.ok(rendered.includes('channelId="channel-1"'));
});

test("prose that mentions the element cannot be mistaken for the context block", () => {
	// Both the seeded AGENTS.md and the fixed core instructions use this form.
	const prose = "The system prompt carries a `<discord ... />` element with the ids.";
	assert.equal(prose.includes(DISCORD_MARKER), false);
});

test("a subscribed channel names only the channel, not a thread", () => {
	const rendered = describeDiscordContext({ ...context, kind: "channel" });
	assert.ok(rendered.includes('channelId="channel-1"'));
	assert.equal(rendered.includes("threadId="), false);
});
