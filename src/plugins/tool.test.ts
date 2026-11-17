/**
 * A tool result is what the model reads, so an image a tool fetched has to
 * survive the adapter as a file part rather than being JSON-encoded into text.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { objectSchema, toolExecute, ToolOutput } from "./tool.ts";

const call = { sessionID: "session-1" };

test("a tool output carries text and files side by side", async () => {
	const execute = toolExecute({
		name: "read",
		description: "read",
		input: objectSchema({}),
		run: async () =>
			new ToolOutput("a screenshot", [
				{ uri: "data:image/png;base64,AQID", mime: "image/png", name: "ticket.png" },
			]),
	});

	assert.deepEqual(await execute({}, call), {
		content: [
			{ type: "text", text: "a screenshot" },
			{ type: "file", uri: "data:image/png;base64,AQID", mime: "image/png", name: "ticket.png" },
		],
	});
});

test("a text-only tool output stays plain text", async () => {
	const execute = toolExecute({
		name: "read",
		description: "read",
		input: objectSchema({}),
		run: async () => new ToolOutput("no pictures here"),
	});

	assert.deepEqual(await execute({}, call), { content: "no pictures here" });
});

test("a plain value is still JSON-encoded", async () => {
	const execute = toolExecute({
		name: "plain",
		description: "plain",
		input: objectSchema({}),
		run: async () => ({ ok: true }),
	});

	assert.deepEqual(await execute({}, call), { content: '{\n  "ok": true\n}' });
});
