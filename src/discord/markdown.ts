/**
 * Rendering model Markdown for Discord.
 *
 * Discord renders bold, italics, links and code spans, but not Markdown tables:
 * a table arrives as a run of pipe characters. Every message Eryn posts passes
 * through {@link formatMessage}, which finds tables outside code fences and
 * rewrites them into a layout Discord can read:
 *
 * - short, tabular data becomes an aligned box-drawn code block;
 * - a wide comparison with three or four columns becomes an embed, whose inline
 *   fields Discord draws side by side;
 * - anything else becomes one labelled block per row, which stays readable on
 *   a phone.
 */

import type { DiscordEmbed, DiscordEmbedField } from "./api";

/** The widest monospace table that fits a Discord message without scrolling. */
const COMPACT_WIDTH = 72;

/** A neutral accent, matching Eryn's monochrome brand. */
const EMBED_COLOR = 0xa1a1aa;

/** Discord's limits for one embed field and for an embed's text in total. */
const FIELD_NAME_LIMIT = 256;

const FIELD_VALUE_LIMIT = 1_024;

const EMBED_TEXT_LIMIT = 6_000;

type Alignment = "left" | "center" | "right";

/** A message as Discord needs it: content, plus any embeds laid out from tables. */
export interface FormattedMessage {
	content: string;
	embeds: DiscordEmbed[];
}

/**
 * Rewrite every Markdown table in a message for Discord.
 *
 * Text outside tables, and anything inside a code fence, is left untouched. A
 * wide comparison that ends the message becomes an embed, because Discord puts
 * content above embeds and the table stays in reading order; a table followed
 * by more text keeps the labelled layout instead.
 */
export function formatMessage(markdown: string): FormattedMessage {
	const lines = markdown.split("\n");
	const output: string[] = [];
	const embeds: DiscordEmbed[] = [];
	const state: MessageState = { fence: undefined, index: 0 };

	while (state.index < lines.length) {
		const line = lines[state.index] ?? "";

		if (consumeCodeLine(line, state, output)) {
			state.index += 1;
			continue;
		}

		const table = readTable(lines, state.index);

		if (!table) {
			output.push(line);
			state.index += 1;
			continue;
		}

		const rendered = renderTable(table, lines.slice(table.end).join("\n").trim() === "");

		if (rendered.embed) embeds.push(rendered.embed);

		if (rendered.text !== undefined) output.push(rendered.text);

		state.index = table.end;
	}

	return { content: output.join("\n").trimEnd(), embeds };
}

/** Where the scanner is: the open code fence, if any, and the current line. */
interface MessageState {
	fence: string | undefined;
	index: number;
}

/**
 * Copy a line that belongs to a code fence, or that opens or closes one.
 *
 * Returns whether the line was consumed; text inside a fence is never a table.
 */
function consumeCodeLine(line: string, state: MessageState, output: string[]): boolean {
	const marker = fenceMarker(line);

	if (marker) {
		if (state.fence === undefined) state.fence = marker;
		else if (marker[0] === state.fence[0] && marker.length >= state.fence.length) state.fence = undefined;
		output.push(line);

		return true;
	}

	if (state.fence !== undefined) {
		output.push(line);

		return true;
	}

	return false;
}

/** A table found in the message, with every row already padded to one width. */
interface TableBlock {
	readonly header: string[];
	readonly align: Alignment[];
	readonly rows: string[][];
	/** The line after the table's last row. */
	readonly end: number;
}

/** Read the table that starts at `start`, or undefined when that line is not one. */
function readTable(lines: readonly string[], start: number): TableBlock | undefined {
	const line = lines[start] ?? "";
	const header = line.includes("|") ? splitRow(line) : undefined;
	const align = header && start + 1 < lines.length ? delimiter(lines[start + 1] ?? "") : undefined;

	if (!header || !align || header.length !== align.length) return undefined;

	const rows: string[][] = [];
	let end = start + 2;

	while (end < lines.length) {
		const candidate = lines[end] ?? "";

		if (!candidate.trim() || !candidate.includes("|")) break;
		rows.push(splitRow(candidate));
		end += 1;
	}

	// A row may carry more cells than the header. When every row has exactly
	// one more, the header is a row-label table that omitted its leading
	// blank cell, so shift it right; otherwise keep the extra cells.
	const widest = Math.max(header.length, ...rows.map((cells) => cells.length));
	const shifted = widest === header.length + 1 && rows.every((cells) => cells.length === widest);
	const paddedHeader = shifted ? ["", ...header] : fit(header, widest);

	const paddedAlign: Alignment[] = shifted
		? ["left", ...align]
		: [...align, ...Array<Alignment>(widest - align.length).fill("left")];

	return {
		header: paddedHeader,
		align: paddedAlign,
		rows: rows.map((cells) => fit(cells, widest)),
		end,
	};
}

/** One table's replacement: an embed, or the text that stands in for it. */
interface RenderedTable {
	readonly embed?: DiscordEmbed;
	readonly text?: string;
}

/** Lay a table out as an embed when it is wide and ends the message, else as text. */
function renderTable(table: TableBlock, trailing: boolean): RenderedTable {
	const layout = tableLayout(table.header, table.rows);

	if (!layout.compact && trailing) {
		const embed = embedTable(table.header, table.rows);

		// A table too large for one embed field falls back to the labelled layout.
		if (embed) return { embed };
	}

	return {
		text: layout.compact
			? compactTable(layout.header, table.align, layout.rows, layout.widths)
			: labelledRows(table.header, table.rows),
	};
}

/** The opening or closing marker of a fenced code block, if this line is one. */
function fenceMarker(line: string): string | undefined {
	return /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
}

/** Split one table row into trimmed cells, honouring `\|` as a literal pipe. */
function splitRow(line: string): string[] {
	let text = line.trim();

	if (text.startsWith("|")) text = text.slice(1);

	if (text.endsWith("|") && !text.endsWith(String.raw`\|`)) text = text.slice(0, -1);

	const cells: string[] = [];
	let cell = "";

	for (let index = 0; index < text.length; index++) {
		const char = text[index];

		if (char === "\\" && text[index + 1] === "|") {
			cell += "|";
			index++;
		} else if (char === "|") {
			cells.push(cell.trim());
			cell = "";
		} else {
			cell += char;
		}
	}

	cells.push(cell.trim());

	return cells;
}

/** The alignments of a delimiter row, or undefined when the line is not one. */
function delimiter(line: string): Alignment[] | undefined {
	if (!line.includes("|")) return undefined;
	const align: Alignment[] = [];

	for (const cell of splitRow(line)) {
		const match = /^(:?)-+(:?)$/.exec(cell);

		if (!match) return undefined;
		align.push(match[1] && match[2] ? "center" : match[2] ? "right" : "left");
	}

	return align.length > 0 ? align : undefined;
}

/** Pad or trim a row to the header's width. */
function fit(cells: string[], width: number): string[] {
	const row = cells.slice(0, width);

	while (row.length < width) row.push("");

	return row;
}

interface TableLayout {
	/** The header and rows with Markdown removed, ready for a code block. */
	header: string[];
	rows: string[][];
	widths: number[];
	/** Whether the table fits a monospace block without scrolling. */
	compact: boolean;
}

/** Measure a table for the monospace layout, and whether it fits one. */
function tableLayout(header: string[], rows: string[][]): TableLayout {
	const plainHeader = header.map(plain);
	const plainRows = rows.map((row) => row.map(plain));

	const widths = plainHeader.map((cell, column) =>
		Math.max(displayWidth(cell), ...plainRows.map((row) => displayWidth(row[column] ?? ""))),
	);

	// A pipe inside a cell would look like a column boundary in a code block.
	const hasPipe = [...header, ...rows.flat()].some((cell) => cell.includes("|"));
	const total = widths.reduce((sum, width) => sum + width, 0) + 3 * widths.length + 1;

	return { header: plainHeader, rows: plainRows, widths, compact: !hasPipe && total <= COMPACT_WIDTH };
}

/** An aligned, box-drawn table for data that fits without scrolling. */
function compactTable(header: string[], align: Alignment[], rows: string[][], widths: number[]): string {
	const line = (cells: string[]) =>
		`│ ${cells.map((cell, column) => alignCell(cell, widths[column], align[column])).join(" │ ")} │`;

	const rule = (left: string, middle: string, right: string) =>
		`${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`;

	// The layout depends on every column being the same width in a monospace
	// font, so it has to be a code block; plain message text would not line up.
	return [
		"```",
		rule("┌", "┬", "┐"),
		line(header),
		rule("├", "┼", "┤"),
		...rows.map(line),
		rule("└", "┴", "┘"),
		"```",
	].join("\n");
}

/**
 * One block per row. The first column becomes the block's heading, so a table
 * whose rows are labelled stays scannable; every other column becomes a bullet
 * named by its header.
 */
function labelledRows(header: string[], rows: string[][]): string {
	const blocks = rows.map((row) => {
		const lines: string[] = [];
		const title = (row[0] ?? "").trim();

		if (title) lines.push(title.includes("**") ? title : `**${title}**`);
		row.forEach((cell, column) => {
			const value = cell.trim();

			if (column === 0 || !value) return;
			const label = fieldName(header[column] ?? "", "");
			lines.push(label ? `- **${label}:** ${value}` : `- ${value}`);
		});

		return lines.join("\n");
	});

	return blocks.filter(Boolean).join("\n\n");
}

/**
 * A wide comparison as an embed, where Discord draws up to three inline fields
 * side by side.
 *
 * A four-column table is a row label plus three options, so each option becomes
 * a field and carries its labels. A three-column table without a label column
 * is transposed, one field per column. Returns undefined when the shape or the
 * size does not fit an embed, so the caller falls back to the labelled layout.
 */
function embedTable(header: string[], rows: string[][]): DiscordEmbed | undefined {
	const fields =
		header.length === 4 || (header.length === 3 && (header[0] ?? "").trim() === "")
			? optionFields(header, rows)
			: header.length === 3
				? columnFields(header, rows)
				: undefined;

	if (!fields) return undefined;

	if (
		fields.some(
			(field) =>
				!field.name.trim() ||
				field.name.length > FIELD_NAME_LIMIT ||
				!field.value.trim() ||
				field.value.length > FIELD_VALUE_LIMIT,
		)
	) {
		return undefined;
	}

	const total = fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);

	if (total > EMBED_TEXT_LIMIT) return undefined;

	return { color: EMBED_COLOR, fields };
}

/** One inline field per option, with the row labels repeated in each value. */
function optionFields(header: string[], rows: string[][]): DiscordEmbedField[] | undefined {
	const fields: DiscordEmbedField[] = [];

	for (let column = 1; column < header.length; column++) {
		const name = fieldName(header[column] ?? "", `Option ${column}`);

		const value = rows
			.flatMap((row) => {
				const label = (row[0] ?? "").trim().replaceAll("**", "");
				const cell = (row[column] ?? "").trim();
				const line = label && cell ? `**${label}:** ${cell}` : cell;

				return line ? [line] : [];
			})
			.join("\n");

		if (!value) return undefined;
		fields.push({ name, value, inline: true });
	}

	return fields.length >= 2 ? fields : undefined;
}

/** One inline field per column, each value a line per row. */
function columnFields(header: string[], rows: string[][]): DiscordEmbedField[] | undefined {
	const fields = header.map((cell, column) => ({
		name: fieldName(cell, `Column ${column + 1}`),
		value: rows.map((row) => row[column] ?? "").join("\n"),
		inline: true,
	}));

	if (fields.some((field) => field.value.trim() === "")) return undefined;

	return fields;
}

/** A field name without the Markdown that Discord would show literally. */
function fieldName(cell: string, fallback: string): string {
	const name = cell.replaceAll(/(\*\*|__|`)/g, "").trim();

	return name || fallback;
}

/** Pad a cell to its column width in the requested direction. */
function alignCell(text: string, width: number, alignment: Alignment): string {
	const gap = Math.max(0, width - displayWidth(text));

	if (alignment === "right") return " ".repeat(gap) + text;

	if (alignment === "center") {
		const left = Math.floor(gap / 2);

		return " ".repeat(left) + text + " ".repeat(gap - left);
	}

	return text + " ".repeat(gap);
}

/** Drop the Markdown that a code block would show literally. */
function plain(text: string): string {
	return text
		.replaceAll(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
		.replaceAll(/(\*\*|__|~~|`)/g, "")
		.replaceAll(/(^|[^\w*])\*([^*]+)\*/g, "$1$2")
		.replaceAll(/(^|[^\w_])_([^_]+)_/g, "$1$2");
}

/** Code-point ranges that take two columns in a monospace font. */
const WIDE: ReadonlyArray<readonly [number, number]> = [
	[0x1100, 0x115f],
	[0x2e80, 0xa4cf],
	[0xac00, 0xd7a3],
	[0xf900, 0xfaff],
	[0xfe10, 0xfe19],
	[0xfe30, 0xfe6f],
	[0xff00, 0xff60],
	[0xffe0, 0xffe6],
	[0x1f000, 0x1faff],
	[0x20000, 0x3fffd],
];

/** The width of text in a monospace cell, counting wide characters twice. */
function displayWidth(text: string): number {
	let width = 0;

	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		width += WIDE.some(([start, end]) => code >= start && code <= end) ? 2 : 1;
	}

	return width;
}
