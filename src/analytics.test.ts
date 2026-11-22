/**
 * The analytics helper has to be inert when it is switched off and invisible
 * when a send fails: a product action must never depend on PostHog.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { capture, pseudonym } from "./analytics.ts";

interface CaptureBody {
	readonly event: string;
	readonly distinct_id: string;
	readonly properties: {
		readonly $groups?: { readonly server?: string };
		readonly provider?: string;
		readonly attachments?: number;
		readonly missing?: string;
	};
}

/** The helper reads only POSTHOG_KEY and ENCRYPTION_KEY, so a partial environment is enough. */
function env(values: { POSTHOG_KEY?: string; ENCRYPTION_KEY?: string }): Env {
	return values as Env;
}

/** Swap the global fetch for one test, and always put it back. */
async function withFetch<T>(stub: typeof fetch, run: () => Promise<T>): Promise<T> {
	const original = globalThis.fetch;

	globalThis.fetch = stub;

	try {
		return await run();
	} finally {
		globalThis.fetch = original;
	}
}

test("does nothing when POSTHOG_KEY is unset", async () => {
	let calls = 0;

	await withFetch(async () => {
		calls += 1;

		return new Response("{}", { status: 200 });
	}, async () => {
		await capture(env({}), "login_completed", {}, { userId: "usr_test" });
	});

	assert.equal(calls, 0);
});

test("sends a coarse server-scoped event", async () => {
	const calls: CaptureBody[] = [];

	await withFetch(async (_input, init) => {
		calls.push(JSON.parse(String(init?.body)) as CaptureBody);

		return new Response("{}", { status: 200 });
	}, async () => {
		await capture(
			env({ POSTHOG_KEY: "phc_test" }),
			"message_received",
			{ provider: "discord", attachments: 2, missing: undefined },
			{ serverId: "srv_test" },
		);
	});

	assert.equal(calls.length, 1);

	const sent = calls[0];

	assert.ok(sent);
	assert.equal(sent.event, "message_received");
	assert.equal(sent.distinct_id, "server:srv_test");
	assert.deepEqual(sent.properties.$groups, { server: "srv_test" });
	assert.equal(sent.properties.provider, "discord");
	assert.equal(sent.properties.attachments, 2);
	assert.equal("missing" in sent.properties, false);
});

test("a pseudonym cannot be read back as the address", async () => {
	const address = "person@example.com";
	const first = await pseudonym(env({ ENCRYPTION_KEY: "key-one" }), address);
	const again = await pseudonym(env({ ENCRYPTION_KEY: "key-one" }), address);
	const other = await pseudonym(env({ ENCRYPTION_KEY: "key-two" }), address);

	assert.ok(first);
	assert.equal(first, again);
	assert.notEqual(first, other);
	assert.equal(first.includes("@"), false);
	assert.equal(await pseudonym(env({}), address), undefined);
});

test("never throws when the request fails", async () => {
	await withFetch(async () => {
		throw new Error("offline");
	}, async () => {
		await assert.doesNotReject(capture(env({ POSTHOG_KEY: "phc_test" }), "login_completed", {}, { userId: "usr_test" }));
	});

	await withFetch(async () => new Response("refused", { status: 500 }), async () => {
		await assert.doesNotReject(capture(env({ POSTHOG_KEY: "phc_test" }), "login_completed", {}, { userId: "usr_test" }));
	});
});
