/**
 * Rendering model Markdown for Discord.
 *
 * Discord renders bold, italics, links and code spans, but not Markdown tables:
 * a table arrives as a run of pipe characters. Every message Eryn posts passes
 * through {@link formatMessage}, which finds tables outside code fences and
 * rewrites them into a layout Discord can read. Short, tabular data becomes a
 * monospace block; wide or prose-heavy tables become one labelled block per
 * row, which stays readable on a phone.
 */

/** The widest monospace table that fits a Discord message without scrolling. */
const COMPACT_WIDTH = 72;

type Alignment = "left" | "center" | "right";

/**
 * Rewrite every Markdown table in a message for Discord.
 *
 * Text outside tables, and anything inside a code fence, is left untouched, so
 * the function is safe to apply to any outgoing content.
 */
export function formatMessage(markdown: string): string {
	const lines = markdown.split("\n");
	const output: string[] = [];
	let fence: string | undefined;

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index]!;
		const marker = fenceMarker(line);
		if (marker) {
			if (fence === undefined) fence = marker;
			else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
			output.push(line);
			continue;
		}
		if (fence !== undefined) {
			output.push(line);
			continue;
		}

		const header = line.includes("|") ? splitRow(line) : undefined;
		const align = header && index + 1 < lines.length ? delimiter(lines[index + 1]!) : undefined;
		if (!header || !align || header.length !== align.length) {
			output.push(line);
			continue;
		}

		const rows: string[][] = [];
		let row = index + 2;
		while (row < lines.length) {
			const candidate = lines[row]!;
			if (!candidate.trim() || !candidate.includes("|")) break;
			rows.push(splitRow(candidate));
			row++;
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
		output.push(renderTable(paddedHeader, paddedAlign, rows.map((cells) => fit(cells, widest))));
		index = row - 1;
	}

	return output.join("\n");
}

/** The opening or closing marker of a fenced code block, if this line is one. */
function fenceMarker(line: string): string | undefined {
	return /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
}

/** Split one table row into trimmed cells, honouring `\|` as a literal pipe. */
function splitRow(line: string): string[] {
	let text = line.trim();
	if (text.startsWith("|")) text = text.slice(1);
	if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);

	const cells: string[] = [];
	let cell = "";
	for (let index = 0; index < text.length; index++) {
		const char = text[index]!;
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

function renderTable(header: string[], align: Alignment[], rows: string[][]): string {
	// A pipe inside a cell would look like a column boundary in a code block.
	if ([...header, ...rows.flat()].some((cell) => cell.includes("|"))) return labelledRows(header, rows);
	const plainHeader = header.map(plain);
	const plainRows = rows.map((row) => row.map(plain));
	const widths = plainHeader.map((cell, column) =>
		Math.max(displayWidth(cell), ...plainRows.map((row) => displayWidth(row[column] ?? ""))),
	);
	const total = widths.reduce((sum, width) => sum + width, 0) + 3 * (widths.length - 1);
	return total <= COMPACT_WIDTH
		? compactTable(plainHeader, align, plainRows, widths)
		: labelledRows(header, rows);
}

/** An aligned monospace table, for data that fits without scrolling. */
function compactTable(header: string[], align: Alignment[], rows: string[][], widths: number[]): string {
	const line = (cells: string[]) =>
		cells
			.map((cell, column) => alignCell(cell, widths[column]!, align[column]!))
			.join(" | ")
			.trimEnd();
	const rule = widths.map((width) => "-".repeat(width)).join("-|-");
	return ["```", line(header), rule, ...rows.map(line), "```"].join("\n");
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
			const label = (header[column] ?? "").trim();
			lines.push(label ? `- **${label}:** ${value}` : `- ${value}`);
		});
		return lines.join("\n");
	});
	return blocks.filter(Boolean).join("\n\n");
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
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
		.replace(/(\*\*|__|~~|`)/g, "")
		.replace(/(^|[^\w*])\*([^*]+)\*/g, "$1$2")
		.replace(/(^|[^\w_])_([^_]+)_/g, "$1$2");
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
		const code = char.codePointAt(0)!;
		width += WIDE.some(([start, end]) => code >= start && code <= end) ? 2 : 1;
	}
	return width;
}
