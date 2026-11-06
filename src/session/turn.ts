/**
 * The in-memory state of one turn, and what a host event does to it.
 *
 * A turn is the unit the Discord stream follows: it collects assistant text as
 * the host reports it and completes when the host says the execution settled.
 * Nothing here touches storage or the network, so the event handling can be
 * read as a table rather than searched for in the agent.
 */

/** The live state of one thread's turn. */
export interface Turn {
	readonly threadId: string;
	readonly createdAt: number;
	readonly parts: Map<string, Map<number, string>>;
	/** Assistant message ids that belong to a real step, excluding auxiliary requests. */
	readonly main: Set<string>;
	done: boolean;
	interrupted: boolean;
	/** Set when the thread was deleted, so the reply has nowhere to go. */
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
		parts: new Map(),
		main: new Set(),
		done: false,
		interrupted: false,
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
 * What to say when a turn failed. The SDK reports the provider's own message,
 * which is far more useful than a generic apology, and the fix is almost always
 * the model or the key for this server.
 */
export function failureNote(error: string): string {
	const hint = /deprecat|unavailable|not found/i.test(error)
		? "\n\nThe model for this server is no longer available — pick another with `/eryn setup`."
		: /credential|unauthor|401|403/i.test(error)
			? "\n\nThe key for this server was rejected — check or replace it with `/eryn setup`."
			: "";
	return `**That turn failed.**\n> ${error}${hint}`;
}

/** Render the streamed text so far, preferring messages that belong to a step. */
export function renderTurn(turn: Turn): string {
	const messages: string[] = [];
	for (const [messageID, ordinals] of turn.parts) {
		if (turn.main.size > 0 && !turn.main.has(messageID)) continue;
		const text = [...ordinals.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, value]) => value)
			.join("")
			.trim();
		if (text) messages.push(text);
	}
	return messages.join("\n\n").trim();
}

/**
 * The ordinals of one assistant message.
 *
 * Text arrives per message part: a delta appends to the part the host names,
 * and an end replaces it with the authoritative text. Keeping the map nested
 * means a part is only ever addressed by the ids the host gave it.
 */
function partFor(turn: Turn, data: Record<string, unknown>): { ordinals: Map<number, string>; ordinal: number } | undefined {
	const messageID = data.assistantMessageID;
	const ordinal = data.ordinal;
	if (typeof messageID !== "string" || typeof ordinal !== "number") return undefined;
	const ordinals = turn.parts.get(messageID) ?? new Map<number, string>();
	turn.parts.set(messageID, ordinals);
	return { ordinals, ordinal };
}

function appendDelta(turn: Turn, data: Record<string, unknown>, delta: string): string | undefined {
	if (!delta) return undefined;
	const part = partFor(turn, data);
	if (!part) return undefined;
	part.ordinals.set(part.ordinal, (part.ordinals.get(part.ordinal) ?? "") + delta);
	return renderTurn(turn);
}

function setText(turn: Turn, data: Record<string, unknown>, text: string): string | undefined {
	const part = partFor(turn, data);
	if (!part) return undefined;
	part.ordinals.set(part.ordinal, text);
	return renderTurn(turn);
}

/**
 * Apply one host event to a turn.
 *
 * Returns the new rendered text when the event changed it, so the caller can
 * push only that; `undefined` means there is nothing to render. Events that do
 * not belong to a turn are ignored by returning `undefined`, the same as an
 * unknown event type.
 */
export function applyTurnEvent(turn: Turn, type: string, data: Record<string, unknown>): string | undefined {
	switch (type) {
		case "session.step.started":
			if (typeof data.assistantMessageID === "string") turn.main.add(data.assistantMessageID);
			return undefined;
		case "session.text.delta":
			return appendDelta(turn, data, typeof data.delta === "string" ? data.delta : "");
		case "session.text.ended":
			return setText(turn, data, typeof data.text === "string" ? data.text : "");
		case "session.execution.failed":
			turn.error ??= errorDetail(data.error);
			complete(turn);
			return undefined;
		case "session.step.failed":
			// The SDK puts the provider's own message here, which is the only
			// place the real reason for a failure appears.
			turn.error ??= errorDetail(data.error);
			return undefined;
		case "session.execution.interrupted":
			turn.interrupted = true;
			complete(turn);
			return undefined;
		case "session.execution.succeeded":
			complete(turn);
			return undefined;
		case "session.idle":
			// Only a session that actually started a step is considered finished.
			if (turn.main.size > 0) complete(turn);
			return undefined;
		default:
			return undefined;
	}
}
