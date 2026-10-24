/**
 * The one tool every hosted server publishes, whatever accounts it holds.
 *
 * It exists to prove the transport end to end without needing an account: a
 * client that can list and call this has discovered the server, spoken the
 * protocol, and been authorised.
 */

export interface BuiltinTool {
	name: string;
	title: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties: false;
	};
	run: (args: Record<string, unknown>) => string;
}

const DEFAULT_MAX = 100;
const MAX_COUNT = 100;

function intArg(value: unknown, fallback: number): number {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

/** A uniformly random integer in `[min, max]` (inclusive), rejection-free. */
function randomBetween(min: number, max: number): number {
	const span = max - min + 1;
	if (span <= 0) return min;
	const limit = Math.floor(0xffffffff / span) * span;
	const buffer = new Uint32Array(1);
	let value: number;
	do {
		crypto.getRandomValues(buffer);
		value = buffer[0]!;
	} while (value >= limit);
	return min + (value % span);
}

export const BUILTIN_TOOLS: readonly BuiltinTool[] = [
	{
		name: "random_number",
		title: "Random number",
		description:
			"Generate one or more uniformly random integers, inclusive of both bounds. Use it to roll dice, pick a winner, or add jitter.",
		inputSchema: {
			type: "object",
			properties: {
				min: { type: "integer", description: "Smallest value that may be returned (inclusive). Defaults to 0." },
				max: { type: "integer", description: "Largest value that may be returned (inclusive). Defaults to 100." },
				count: { type: "integer", description: `How many numbers to return, 1-${MAX_COUNT}. Defaults to 1.` },
			},
			required: [],
			additionalProperties: false,
		},
		run: (args) => {
			const min = intArg(args.min, 0);
			const max = intArg(args.max, DEFAULT_MAX);
			if (max < min) throw new Error(`max (${max}) must be greater than or equal to min (${min}).`);
			const count = Math.min(Math.max(intArg(args.count, 1), 1), MAX_COUNT);
			const numbers = Array.from({ length: count }, () => randomBetween(min, max));
			if (count === 1) return `${numbers[0]}`;
			return `You rolled: ${numbers.join(", ")} (each between ${min} and ${max}).`;
		},
	},
];

export function builtinTool(name: string): BuiltinTool | undefined {
	return BUILTIN_TOOLS.find((tool) => tool.name === name);
}
