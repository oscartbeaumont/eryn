/**
 * Discord does not render Markdown tables, so the formatter's two layouts are
 * tested directly: a monospace table for short data and labelled blocks for
 * anything too wide to read in a code block.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatMessage } from "./markdown.ts";

test("a short table becomes an aligned monospace block", () => {
	const input = ["| Name | Score |", "| :--- | ---: |", "| Ada | 9 |", "| Grace | 10 |"].join("\n");
	assert.equal(
		formatMessage(input),
		["```", "Name  | Score", "------|------", "Ada   |     9", "Grace |    10", "```"].join("\n"),
	);
});

test("a wide table becomes one block per row", () => {
	const note = "a walk of ten minutes past the station and up the hill to the venue";
	const input = ["| | Cost | Note |", "| --- | --- | --- |", `| One | $1,220 | ${note} |`].join("\n");
	assert.equal(formatMessage(input), ["**One**", "- **Cost:** $1,220", `- **Note:** ${note}`].join("\n"));
});

test("a table with a pipe inside a cell uses the readable layout", () => {
	const input = ["| Left | Right |", "| --- | --- |", "| a \\| b | c |"].join("\n");
	assert.equal(formatMessage(input), ["**a | b**", "- **Right:** c"].join("\n"));
});

test("text around a table is preserved", () => {
	const input = ["Here you go:", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "Done."].join("\n");
	assert.equal(
		formatMessage(input),
		["Here you go:", "", "```", "A | B", "--|--", "1 | 2", "```", "", "Done."].join("\n"),
	);
});

test("a table inside a code fence is left alone", () => {
	const input = ["```md", "| A | B |", "| --- | --- |", "| 1 | 2 |", "```"].join("\n");
	assert.equal(formatMessage(input), input);
});

test("prose with a pipe is not a table", () => {
	const input = ["Use a | b for alternatives.", "That is not a table."].join("\n");
	assert.equal(formatMessage(input), input);
});

test("a header missing its leading blank cell is shifted, not truncated", () => {
	const note = "a long sentence that pushes the table past the compact width limit for sure";
	const input = [
		"| Cheap | Balanced |",
		"| --- | --- |",
		`| Nights | Thu–Sun (3) | Wed–Sun (4) |`,
		`| Note | ${note} | a short one |`,
	].join("\n");
	assert.equal(
		formatMessage(input),
		[
			"**Nights**",
			"- **Cheap:** Thu–Sun (3)",
			"- **Balanced:** Wed–Sun (4)",
			"",
			"**Note**",
			`- **Cheap:** ${note}`,
			"- **Balanced:** a short one",
		].join("\n"),
	);
});

test("formatting a message twice changes nothing", () => {
	const input = [
		"| Name | Score |",
		"| --- | ---: |",
		"| Ada | 9 |",
		"",
		"| | Cost | Note |",
		"| --- | --- | --- |",
		"| One | $1,220 | a walk of ten minutes past the station and up the hill to the venue |",
	].join("\n");
	const once = formatMessage(input);
	assert.equal(formatMessage(once), once);
});
