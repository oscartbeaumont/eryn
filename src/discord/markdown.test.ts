/**
 * Discord renders neither Markdown tables nor a table component, so the three
 * layouts are tested directly: a box-drawn monospace block, an embed grid for a
 * wide comparison, and labelled blocks for everything else.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { formatMessage } from "./markdown.ts";

test("a short table becomes a box-drawn monospace block", () => {
	const input = ["| Name | Score |", "| :--- | ---: |", "| Ada | 9 |", "| Grace | 10 |"].join("\n");
	assert.equal(
		formatMessage(input).content,
		[
			"┌───────┬───────┐",
			"│ Name  │ Score │",
			"├───────┼───────┤",
			"│ Ada   │     9 │",
			"│ Grace │    10 │",
			"└───────┴───────┘",
		].join("\n"),
	);
});

test("a wide comparison becomes an embed with one field per option", () => {
	const input = [
		"| Cheap | Balanced | Nicer |",
		"| --- | --- | --- |",
		"| Nights | Thu–Sun (3) | Wed–Sun (4) | Thu–Sun (3) |",
		"| Wins | cheapest, walk home after the show | everything is walkable, one extra day | proper hotel, breakfast, rooftop |",
	].join("\n");
	const formatted = formatMessage(input);
	assert.equal(formatted.content, "");
	assert.deepEqual(formatted.embeds, [
		{
			color: 0xa1a1aa,
			fields: [
				{
					name: "Cheap",
					value: "**Nights:** Thu–Sun (3)\n**Wins:** cheapest, walk home after the show",
					inline: true,
				},
				{
					name: "Balanced",
					value: "**Nights:** Wed–Sun (4)\n**Wins:** everything is walkable, one extra day",
					inline: true,
				},
				{
					name: "Nicer",
					value: "**Nights:** Thu–Sun (3)\n**Wins:** proper hotel, breakfast, rooftop",
					inline: true,
				},
			],
		},
	]);
});

test("a wide three-column table is transposed into three fields", () => {
	const input = [
		"| Plan | Cost | Note |",
		"| --- | --- | --- |",
		"| Cheap and close to the venue | $1,220 | a short walk home after the show |",
		"| Nicer hotel in the CBD | $2,080 | proper hotel, breakfast, rooftop |",
	].join("\n");
	assert.deepEqual(formatMessage(input).embeds, [
		{
			color: 0xa1a1aa,
			fields: [
				{ name: "Plan", value: "Cheap and close to the venue\nNicer hotel in the CBD", inline: true },
				{ name: "Cost", value: "$1,220\n$2,080", inline: true },
				{ name: "Note", value: "a short walk home after the show\nproper hotel, breakfast, rooftop", inline: true },
			],
		},
	]);
});

test("text before a table stays in the message, above the embed", () => {
	const input = [
		"Here are the options:",
		"",
		"| Cheap | Balanced | Nicer |",
		"| --- | --- | --- |",
		"| Nights | Thu–Sun (3) | Wed–Sun (4) | Thu–Sun (3) |",
		"| Wins | cheapest, walk home after the show | everything is walkable, one extra day | proper hotel, breakfast, rooftop |",
	].join("\n");
	const formatted = formatMessage(input);
	assert.equal(formatted.content, "Here are the options:");
	assert.equal(formatted.embeds.length, 1);
});

test("a table followed by more text keeps the labelled layout", () => {
	const input = [
		"| Cheap | Balanced | Nicer |",
		"| --- | --- | --- |",
		"| Nights | Thu–Sun (3) | Wed–Sun (4) | Thu–Sun (3) |",
		"| Wins | cheapest, walk home after the show | everything is walkable, one extra day | proper hotel, breakfast, rooftop |",
		"",
		"Which one?",
	].join("\n");
	const formatted = formatMessage(input);
	assert.equal(formatted.embeds.length, 0);
	assert.match(formatted.content, /^\*\*Nights\*\*\n- \*\*Cheap:\*\* Thu–Sun \(3\)/);
});

test("a four-column table that fits a code block stays monospace", () => {
	const input = ["| | A | B | C |", "| --- | --- | --- | --- |", "| One | 1 | 2 | 3 |"].join("\n");
	const formatted = formatMessage(input);
	assert.equal(formatted.embeds.length, 0);
	assert.match(formatted.content, /^┌/);
});

test("a table too large for one embed field falls back to labelled blocks", () => {
	const long = "x".repeat(1_100);
	const input = ["| A | B | C |", "| --- | --- | --- |", `| Label | short | ${long} |`].join("\n");
	const formatted = formatMessage(input);
	assert.equal(formatted.embeds.length, 0);
	assert.match(formatted.content, /^\*\*Label\*\*/);
});

test("a table with a pipe inside a cell uses the readable layout", () => {
	const input = ["| Left | Right |", "| --- | --- |", "| a \\| b | c |"].join("\n");
	assert.equal(formatMessage(input).content, ["**a | b**", "- **Right:** c"].join("\n"));
});

test("text around a table is preserved", () => {
	const input = ["Here you go:", "", "| A | B |", "| --- | --- |", "| 1 | 2 |", "", "Done."].join("\n");
	assert.equal(
		formatMessage(input).content,
		[
			"Here you go:",
			"",
			"┌───┬───┐",
			"│ A │ B │",
			"├───┼───┤",
			"│ 1 │ 2 │",
			"└───┴───┘",
			"",
			"Done.",
		].join("\n"),
	);
});

test("a table inside a code fence is left alone", () => {
	const input = ["```md", "| A | B |", "| --- | --- |", "| 1 | 2 |", "```"].join("\n");
	const formatted = formatMessage(input);
	assert.equal(formatted.content, input);
	assert.equal(formatted.embeds.length, 0);
});

test("prose with a pipe is not a table", () => {
	const input = ["Use a | b for alternatives.", "That is not a table."].join("\n");
	assert.equal(formatMessage(input).content, input);
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
	const twice = formatMessage(once.content);
	assert.equal(twice.content, once.content);
	assert.equal(twice.embeds.length, 0);
});
