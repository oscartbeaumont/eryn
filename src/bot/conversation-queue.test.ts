/**
 * The queue is the guarantee that two quick messages in one conversation reach
 * the model in the order they were sent, even when their pre-turn checks finish
 * in a different order.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ConversationQueues } from "./conversation-queue.ts";

function queue(errors: unknown[] = []) {
	return new ConversationQueues((_message, error) => errors.push(error));
}

test("a slower check cannot let a later message overtake an earlier one", async () => {
	const conversations = queue();
	const order: string[] = [];
	const first = conversations.begin("thread-1");
	const second = conversations.begin("thread-1");

	second.ready(async () => {
		order.push("second");
	});
	// The second is ready first, but must wait for the first message.
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(order.length, 0);

	first.ready(async () => {
		order.push("first");
	});
	await Promise.all([first.done, second.done]);
	assert.deepEqual(order, ["first", "second"]);
});

test("a skipped message does not hold the queue", async () => {
	const conversations = queue();
	const order: string[] = [];
	const answer = conversations.begin("thread-1");
	const next = conversations.begin("thread-1");

	answer.skip();
	next.ready(async () => {
		order.push("next");
	});
	await Promise.all([answer.done, next.done]);
	assert.deepEqual(order, ["next"]);
});

test("a ticket settles when skipped, so a caller can await it", async () => {
	const conversations = queue();
	const ticket = conversations.begin("thread-1");
	ticket.skip();
	await ticket.done;
});

test("skipping twice, or after ready, is harmless", async () => {
	const conversations = queue();
	const order: string[] = [];
	const ticket = conversations.begin("thread-1");
	ticket.ready(async () => {
		order.push("ran");
	});
	ticket.skip();
	ticket.skip();
	await ticket.done;
	assert.deepEqual(order, ["ran"]);
});

test("a later message can wait for the earlier check without waiting for its turn", async () => {
	const conversations = queue();
	const first = conversations.begin("thread-1");
	const second = conversations.begin("thread-1");

	let checked = false;
	void second.previousChecked.then(() => {
		checked = true;
	});
	await Promise.resolve();
	assert.equal(checked, false);

	// Settling the check releases the next message even before the turn runs.
	first.ready(async () => undefined);
	await second.previousChecked;
	assert.equal(checked, true);
	second.skip();
	await Promise.all([first.done, second.done]);
});

test("a failing turn is reported and the next message still runs", async () => {
	const errors: unknown[] = [];
	const conversations = queue(errors);
	const order: string[] = [];
	const failing = conversations.begin("thread-1");
	const next = conversations.begin("thread-1");

	failing.ready(async () => {
		throw new Error("provider failed");
	});
	next.ready(async () => {
		order.push("next");
	});
	await Promise.all([failing.done, next.done]);
	assert.deepEqual(order, ["next"]);
	assert.equal(errors.length, 1);
});

test("different conversations do not wait for each other", async () => {
	const conversations = queue();
	const order: string[] = [];
	let release!: () => void;
	const blocked = conversations.begin("thread-1");
	blocked.ready(
		() =>
			new Promise<void>((resolve) => {
				release = () => {
					order.push("blocked");
					resolve();
				};
			}),
	);
	const other = conversations.begin("thread-2");
	other.ready(async () => {
		order.push("other");
	});
	await other.done;
	assert.deepEqual(order, ["other"]);
	release();
	await blocked.done;
	assert.deepEqual(order, ["other", "blocked"]);
});
