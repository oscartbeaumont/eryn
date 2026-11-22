import assert from "node:assert/strict";
import { test } from "node:test";

import { ApprovalBroker } from "./approvals.ts";

function broker() {
	const sent: Array<{ channel: string; text: string; components?: readonly object[] }> = [];
	const replies: Array<{ sessionID: string; requestID: string; decision: string }> = [];
	const forms: Array<{
		sessionID: string;
		formID: string;
		answer: Record<string, string | number | boolean | ReadonlyArray<string>>;
	}> = [];
	const grants: Array<[string, string]> = [];
	const instance = new ApprovalBroker({
		send: async (message) => {
			sent.push(message);
		},
		replyPermission: async (input) => {
			replies.push(input);
		},
		replyForm: async (input) => {
			forms.push(input);
		},
		cancelForm: async () => undefined,
		grant: async (sessionID, tool) => {
			grants.push([sessionID, tool]);
		},
		timeoutMs: 1_000,
	});

	return { instance, sent, replies, forms, grants };
}

test("a numbered reply approves a permission once", async () => {
	const { instance, sent, replies } = broker();
	const pending = instance.permission({
		sessionID: "s1",
		channel: "c1",
		provider: "imessage",
		action: "bash",
		requestID: "r1",
	});

	assert.equal(await instance.consumeText("c1", "1"), true);
	assert.equal(await pending, "once");
	assert.equal(replies.length, 1);
	assert.equal(replies[0]?.decision, "once");
	assert.ok(sent[0]?.text.includes("Approval needed"));
	assert.equal(sent[0]?.components, undefined);
	instance.close();
});

test("a Discord approval carries buttons and always grants the session", async () => {
	const { instance, sent, grants } = broker();
	const pending = instance.permission({
		sessionID: "s1",
		channel: "c1",
		provider: "discord",
		action: "github_create_issue",
		requestID: "r1",
	});

	assert.equal(Array.isArray(sent[0]?.components), true);
	const approvalId = /approval:([a-z0-9_]+):once/.exec(
		JSON.stringify(sent[0]?.components) ?? "",
	)?.[1];

	assert.ok(approvalId);
	assert.equal(await instance.reply(approvalId, "always", undefined), true);
	assert.equal(await pending, "always");
	assert.deepEqual(grants, [["s1", "github_create_issue"]]);
	instance.close();
});

test("a form collects key: value lines and answers when required fields are present", async () => {
	const { instance, forms } = broker();
	instance.form({
		sessionID: "s1",
		channel: "c1",
		provider: "imessage",
		formID: "f1",
		title: "Details",
		fields: [
			{ key: "name", type: "string", required: true },
			{ key: "count", type: "number", required: false },
		],
	});

	assert.equal(await instance.consumeText("c1", "name: Ada"), true);
	assert.equal(forms.length, 1);
	assert.deepEqual(forms[0]?.answer, { name: "Ada" });
	instance.close();
});

test("the timeout rejects an unanswered permission", async () => {
	const { instance, replies } = broker();
	const pending = instance.permission({
		sessionID: "s1",
		channel: "c1",
		provider: "imessage",
		action: "bash",
		requestID: "r1",
	});

	assert.equal(await pending, "block");
	assert.equal(replies[0]?.decision, "reject");
	instance.close();
});
