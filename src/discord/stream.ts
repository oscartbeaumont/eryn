/**
 * Streams an assistant reply into a Discord thread by editing a message in
 * place, spilling into further messages once the 2000-character limit is hit.
 *
 * Edits are coalesced to at most one per `EDIT_INTERVAL_MS`, because Discord
 * rate-limits message edits aggressively. `finish` always writes the complete
 * text, so a dropped or throttled intermediate edit can never lose output.
 */

import { describeError, splitMessage, type DiscordRest } from "./api";

/** Minimum gap between edits of the same message. */
const EDIT_INTERVAL_MS = 1_500;

/** Shown until the first token arrives. */
const PLACEHOLDER = "⏳";

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

	/** Post the placeholder so the thread shows activity immediately. */
	async start(): Promise<void> {
		const message = await this.rest.sendMessage(this.channelId, PLACEHOLDER);
		this.chunks.push({ id: message.id, content: PLACEHOLDER });
		this.lastFlush = Date.now();
	}

	/** Replace the not-yet-committed text object with the latest rendered reply. */
	push(text: string): void {
		if (this.finished) return;
		this.text = text;
		if (this.timer) return;
		const wait = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - this.lastFlush));
		if (wait === 0) void this.flush();
		else
			this.timer = setTimeout(() => {
				this.timer = undefined;
				void this.flush();
			}, wait);
	}

	/** Write the final text (plus an optional suffix) and stop editing. */
	async finish(text: string, suffix?: string): Promise<void> {
		this.finished = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		await this.pending.catch(() => undefined);
		const body = [text.trim(), suffix?.trim()].filter(Boolean).join("\n\n") || "_(no output)_";
		await this.write(body);
	}

	private flush(): Promise<void> {
		this.lastFlush = Date.now();
		const body = this.text.trim() || PLACEHOLDER;
		this.pending = this.pending
			.then(() => this.write(body))
			.catch((error) => {
				console.log(`[eryn:stream] edit failed: ${describeError(error)}`);
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
