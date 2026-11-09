/**
 * The in-memory state of one turn, and what a host event does to it.
 *
 * A turn completes when the host says the execution settled. Nothing here
 * touches storage or the network, so the event handling can be read as a table
 * rather than searched for in the agent. The assistant's text is deliberately
 * not collected: the agent posts its reply through a Discord tool.
 */

/** The live state of one conversation's turn. */
export interface Turn {
	readonly threadId: string;
	readonly createdAt: number;
	/** Set once the host reports that work has begun. */
	started: boolean;
	done: boolean;
	/** Set when the conversation was deleted, so there is nowhere to reply. */
	gone: boolean;
	error?: string;
	readonly resolve: () => void;
	readonly completed: Promise<void>;
}

export function createTurn(threadId: string): Turn {
	let resolve!: () => void;
	const completed = new Promise<void>((res) => {
		resolve = res;
	});
	return {
		threadId,
		createdAt: Date.now(),
		started: false,
		done: false,
		gone: false,
		resolve,
		completed,
	};
}

function complete(turn: Turn): void {
	if (turn.done) return;
	turn.done = true;
	turn.resolve();
}

/** The error detail an SDK failure carries, if any. */
function errorDetail(error: unknown): string | undefined {
	if (!error || typeof error !== "object") return undefined;
	const shape = error as { message?: unknown; type?: unknown };
	if (typeof shape.message === "string" && shape.message.trim()) return shape.message.trim();
	if (typeof shape.type === "string") return shape.type;
	return undefined;
}

/**
 * Apply one host event to a turn.
 *
 * Events that do not belong to a turn are ignored, the same as an unknown
 * event type. Assistant text events are ignored on purpose: the reply goes
 * through a Discord tool, not through the model's output.
 */
export function applyTurnEvent(turn: Turn, type: string, data: Record<string, unknown>): void {
	switch (type) {
		case "session.execution.started":
		case "session.step.started":
			turn.started = true;
			return;
		case "session.execution.failed":
			turn.error ??= errorDetail(data.error);
			complete(turn);
			return;
		case "session.step.failed":
			// The SDK puts the provider's own message here, which is the only
			// place the real reason for a failure appears.
			turn.error ??= errorDetail(data.error);
			return;
		case "session.execution.interrupted":
			complete(turn);
			return;
		case "session.execution.succeeded":
			complete(turn);
			return;
		case "session.idle":
			// Only a session that actually started work is considered finished.
			if (turn.started) complete(turn);
			return;
	}
}
