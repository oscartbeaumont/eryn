/**
 * A message with files is not JSON: Discord only accepts an upload as
 * multipart/form-data with the message in `payload_json` and one part per file.
 * These tests pin down that shape, because a JSON body would still look like a
 * valid send until Discord rejects it.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { discordRest } from "./api.ts";

interface Captured {
	url?: string;
	init?: RequestInit;
}

/** Replace fetch for one test, returning a function that restores it. */
function captureFetch(captured: Captured): () => void {
	const original = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		captured.url = String(input);
		captured.init = init;
		return new Response(JSON.stringify({ id: "42" }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	return () => {
		globalThis.fetch = original;
	};
}

test("a message without files is sent as JSON", async () => {
	const captured: Captured = {};
	const restore = captureFetch(captured);
	try {
		const rest = discordRest("token");
		const sent = await rest.sendMessage("123", "hello");
		assert.deepEqual(sent, { id: "42" });
		assert.match(captured.url ?? "", /\/channels\/123\/messages$/);
		const headers = new Headers(captured.init?.headers);
		assert.equal(headers.get("content-type"), "application/json");
		assert.equal(typeof captured.init?.body, "string");
	} finally {
		restore();
	}
});

test("a message with files is uploaded as multipart form data", async () => {
	const captured: Captured = {};
	const restore = captureFetch(captured);
	try {
		const rest = discordRest("token");
		await rest.sendMessage("123", "the breakdown", {
			files: [
				{ filename: "breakdown.md", data: new TextEncoder().encode("# Breakdown") },
				{ filename: "notes.txt", data: new TextEncoder().encode("extra") },
			],
		});

		const body = captured.init?.body;
		assert.ok(body instanceof FormData);
		const payload = JSON.parse(String(body.get("payload_json")));
		assert.equal(payload.content, "the breakdown");
		assert.deepEqual(payload.allowed_mentions, { parse: [], users: [] });
		assert.deepEqual(payload.attachments, [
			{ id: "0", filename: "breakdown.md" },
			{ id: "1", filename: "notes.txt" },
		]);

		const first = body.get("files[0]");
		assert.ok(first instanceof Blob);
		assert.equal(first.type, "");
		assert.equal(await first.text(), "# Breakdown");
		assert.equal(await (body.get("files[1]") as Blob).text(), "extra");

		// fetch has to set the multipart boundary itself; a JSON content type
		// here would make the body unreadable to Discord.
		const headers = new Headers(captured.init?.headers);
		assert.equal(headers.get("content-type"), null);
		assert.match(headers.get("authorization") ?? "", /^Bot token$/);
	} finally {
		restore();
	}
});
