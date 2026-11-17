/**
 * The model sees pixels only when an attachment becomes part of the prompt, so
 * a fetched image has to carry the type the provider needs. Anything left out
 * has to say why, because a silently missing screenshot looks ignored.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { fetchAttachmentFiles } from "./attachments.ts";

function stubFetch(response: () => Response): () => void {
	const original = globalThis.fetch;

	// SAFETY: the stub answers like `fetch` for the single URL each test reads.
	globalThis.fetch = (async () => response()) as typeof fetch;

	return () => {
		globalThis.fetch = original;
	};
}

test("an image becomes a data URL with its served type", async () => {
	const restore = stubFetch(
		() =>
			new Response(new Uint8Array([1, 2, 3]), {
				status: 200,
				headers: { "content-type": "image/png" },
			}),
	);

	try {
		const result = await fetchAttachmentFiles([
			{ url: "https://cdn.discordapp.com/attachments/1/2/ticket.png", name: "ticket.png" },
		]);

		assert.deepEqual(result.notes, []);
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0].name, "ticket.png");
		assert.equal(result.files[0].mime, "image/png");
		assert.equal(result.files[0].uri, "data:image/png;base64,AQID");
	} finally {
		restore();
	}
});

test("the type Discord declares is kept when the CDN does not send one", async () => {
	const restore = stubFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));

	try {
		const result = await fetchAttachmentFiles([
			{
				url: "https://cdn.discordapp.com/attachments/1/2/photo",
				name: "photo",
				contentType: "image/jpeg",
			},
		]);

		assert.equal(result.files[0].mime, "image/jpeg");
		assert.match(result.files[0].uri, /^data:image\/jpeg;base64,/);
	} finally {
		restore();
	}
});

test("a file that is not an image is reported and never fetched", async () => {
	let called = false;

	const restore = stubFetch(() => {
		called = true;

		return new Response(new Uint8Array([1]), { status: 200 });
	});

	try {
		const result = await fetchAttachmentFiles([
			{ url: "https://cdn.discordapp.com/attachments/1/2/report.pdf", name: "report.pdf", contentType: "application/pdf" },
		]);

		assert.deepEqual(result.files, []);
		assert.deepEqual(result.notes, ["report.pdf: only images can be attached"]);
		assert.equal(called, false);
	} finally {
		restore();
	}
});

test("a link outside Discord's CDN is refused", async () => {
	const result = await fetchAttachmentFiles([
		{ url: "https://example.com/tracker.png", name: "tracker.png", contentType: "image/png" },
	]);

	assert.deepEqual(result.files, []);
	assert.deepEqual(result.notes, ["tracker.png: unsupported link"]);
});

test("a download failure is reported with its status", async () => {
	const restore = stubFetch(() => new Response("gone", { status: 404 }));

	try {
		const result = await fetchAttachmentFiles([
			{ url: "https://cdn.discordapp.com/attachments/1/2/ticket.png", name: "ticket.png", contentType: "image/png" },
		]);

		assert.deepEqual(result.files, []);
		assert.deepEqual(result.notes, ["ticket.png: download failed (HTTP 404)"]);
	} finally {
		restore();
	}
});
