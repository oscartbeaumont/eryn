/**
 * Streams an assistant reply into a Discord thread.
 *
 * Nothing is posted until there is text to show. While the agent is thinking,
 * the caller's typing indicator is the only progress signal. The first text
 * creates the reply message; later text edits it in place, spilling into
 * further messages past the 2000-character limit.
 *
 * Edits are coalesced to at most one per `EDIT_INTERVAL_MS`, because Discord
 * rate-limits message edits aggressively. `finish` always writes the complete
 * text, so a dropped or throttled intermediate edit can never lose output.
 */

import { log } from "../config";
import { describeError } from "../errors";
import { splitMessage, type DiscordRest } from "./api";

/** Minimum gap between edits of the same message. */
const EDIT_INTERVAL_MS = 1_500;

export class DiscordStream {
	private readonly chunks: { id: string; content: string }[] = [];
	private text = "";
	private lastFlush = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private finished = false;
	private pending: Promise<void> = Promise.resolve();

	constructor(
		private readonly rest: DiscordRest,
		private readonly channelId: string,
	) {}

	/** Replace the not-yet-committed text with the latest rendered reply. */
	push(text: string): void {
		if (this.finished) return;
		this.text = text;
		if (!text.trim()) return;
		if (this.timer) return;
		const wait = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - this.lastFlush));
		if (wait === 0) void this.flush();
		else
			this.timer = setTimeout(() => {
				this.timer = undefined;
				void this.flush();
			}, wait);
	}

	/**
	 * Write the final text (plus an optional suffix) and stop editing.
	 *
	 * Never rejects. A failed final write is logged rather than thrown, since a
	 * turn that is already over cannot report the error usefully.
	 */
	async finish(text: string, suffix?: string): Promise<void> {
		this.finished = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		await this.pending.catch(() => undefined);
		const body = [text.trim(), suffix?.trim()].filter(Boolean).join("\n\n") || "_Eryn produced no output._";
		try {
			await this.write(body);
		} catch (error) {
			log("stream", `could not write the final message: ${describeError(error)}`);
		}
	}

	/**
	 * Give up on the message without writing to it.
	 *
	 * This is for a thread that no longer exists: any queued edit has nowhere to
	 * go. Nothing is written, because there is no one left to read it.
	 */
	abandon(): void {
		this.finished = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private flush(): Promise<void> {
		this.lastFlush = Date.now();
		const body = this.text.trim();
		if (!body) return this.pending;
		this.pending = this.pending
			.then(() => this.write(body))
			.catch((error) => {
				log("stream", `edit failed: ${describeError(error)}`);
			});
		return this.pending;
	}

	/** Reconcile Discord with `body`, creating or editing each chunk in turn. */
	private async write(body: string): Promise<void> {
		const parts = splitMessage(body);
		for (let index = 0; index < parts.length; index++) {
			const part = parts[index]!;
			const existing = this.chunks[index];
			if (!existing) {
				const message = await this.rest.sendMessage(this.channelId, part);
				this.chunks.push({ id: message.id, content: part });
			} else if (existing.content !== part) {
				await this.rest.editMessage(this.channelId, existing.id, part);
				existing.content = part;
			}
		}
	}
}
