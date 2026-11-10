/**
 * Keep command `!` shell blocks out of OpenCode's process-based evaluator.
 *
 * OpenCode runs a command's `!`...`` blocks through its process plane, which
 * the Workerd profile does not have. The block is protected by inserting a
 * zero-width space after the `!`, so OpenCode's `/!`([^`]+)`/g` matcher does
 * not see it. Argument substitution still runs over the block, and Eryn's
 * prompt hook replaces it with just-bash output at execution time.
 */

const SHELL_BLOCK = /!`([^`]+)`/g;
const PROTECTED_PREFIX = "!\u200b`";

/** Matches a protected block and captures its shell source. */
export function shellBlockPattern(): RegExp {
	return /!\u200b`([^`]+)`/g;
}

/** Replace `!`...`` with a form OpenCode's command evaluator ignores. */
export function protectShellBlocks(template: string): string {
	return template.replace(SHELL_BLOCK, (_, source: string) => `${PROTECTED_PREFIX}${source}\``);
}
