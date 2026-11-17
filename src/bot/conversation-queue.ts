/**
 * Per-conversation ordering for inbound Discord messages.
 *
 * The gateway handles events concurrently, and the work before a turn — a role
 * lookup, a permission check, a form-answer query — takes different amounts of
 * time per message. Without a reservation taken at arrival, a later message can
 * overtake an earlier one and start its turn first.
 *
 * `begin` reserves the position synchronously when the event arrives, before
 * any await. The handler then settles the ticket as `ready(work)` or `skip()`
 * and a per-conversation drainer runs the ready work in arrival order. Form
 * answers and stop words do their work before settling, so they are never
 * queued behind the turn they are meant to unblock.
 */

interface Entry {
	readonly key: string;
	settled: boolean;
	work?: () => Promise<void>;
	/** Resolves the ticket's `done` promise once the turn, if any, has finished. */
	readonly finish: () => void;
	/** Resolves when this message's pre-turn check is done, for the next message. */
	readonly checked: Promise<void>;
	readonly resolveChecked: () => void;
}

/** One reserved position in a conversation's queue. */
export class ConversationTicket {
	/** Resolves after this message's turn, or immediately when it is skipped. */
	readonly done: Promise<void>;
	/** Resolves when the message just before this one has finished its check. */
	readonly previousChecked: Promise<void>;
	private readonly queues: ConversationQueues;
	private readonly entry: Entry;

	constructor(
		queues: ConversationQueues,
		entry: Entry,
		done: Promise<void>,
		previousChecked: Promise<void>,
	) {
		this.queues = queues;
		this.entry = entry;
		this.done = done;
		this.previousChecked = previousChecked;
	}

	/** Run `work` once every earlier message in the conversation has settled. */
	ready(work: () => Promise<void>): void {
		this.queues.settle(this.entry, work);
	}

	/** This message was handled outside a turn, or had nothing to send the agent. */
	skip(): void {
		this.queues.settle(this.entry);
	}
}

/** Reports a failed queued task; the error is described, never inspected. */
type ErrorReporter = <Thrown>(message: string, error: Thrown) => void;

export class ConversationQueues {
	private readonly queues = new Map<string, Entry[]>();
	private readonly draining = new Set<string>();
	private readonly onError: ErrorReporter;

	constructor(onError: ErrorReporter) {
		this.onError = onError;
	}

	/** Reserve the next position for a conversation, before any await. */
	begin(key: string): ConversationTicket {
		let finish!: () => void;

		const done = new Promise<void>((resolve) => {
			finish = resolve;
		});

		let resolveChecked!: () => void;

		const checked = new Promise<void>((resolve) => {
			resolveChecked = resolve;
		});

		const entries = this.queues.get(key);
		const previous = entries?.[entries.length - 1];
		const entry: Entry = { key, settled: false, finish, checked, resolveChecked };

		if (entries) entries.push(entry);
		else this.queues.set(key, [entry]);

		return new ConversationTicket(this, entry, done, previous?.checked ?? Promise.resolve());
	}

	/** @internal Called by {@link ConversationTicket} when its check is done. */
	settle(entry: Entry, work?: () => Promise<void>): void {
		if (entry.settled) return;
		entry.settled = true;
		entry.work = work;
		// The next message only waits for this check, never for this turn.
		entry.resolveChecked();
		void this.drain(entry.key);
	}

	private async drain(key: string): Promise<void> {
		if (this.draining.has(key)) return;
		this.draining.add(key);

		try {
			for (;;) {
				const entries = this.queues.get(key);
				const head = entries?.[0];

				if (!head) return;

				// The earliest message is still deciding whether it is a turn.
				// Nothing later may start before it: that is what keeps the order.
				if (!head.settled) return;
				entries.shift();

				if (head.work) {
					try {
						await head.work();
					} catch (error) {
						this.onError(`message in ${key} failed`, error);
					}
				}

				head.finish();
			}
		} finally {
			this.draining.delete(key);

			if (this.queues.get(key)?.length === 0) this.queues.delete(key);
		}
	}
}
