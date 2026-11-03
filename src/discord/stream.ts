/**
 * Streams an assistant reply into a Discord thread.
 *
 * While the agent is thinking the message shows a rotating spinner and a short
 * status line, so the thread looks alive instead of frozen. Once text arrives
 * the spinner stops and the reply is edited in place, spilling into further
 * messages past the 2000-character limit.
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

/** How often the spinner advances while the agent is thinking. */
const LOADING_INTERVAL_MS = 1_400;

/** Braille spinner frames; they render cleanly in Discord's monospace. */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class DiscordStream {
	private readonly chunks: { id: string; content: string }[] = [];
	private text = "";
	private loading = true;
	private status = "Thinking…";
	private frame = 0;
	private lastFlush = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private loader: ReturnType<typeof setInterval> | undefined;
	private finished = false;
	private pending: Promise<void> = Promise.resolve();

	constructor(
		private readonly rest: DiscordRest,
		private readonly channelId: string,
	) {}

	/** Post the spinner and start animating it. */
	async start(): Promise<void> {
		const message = await this.rest.sendMessage(this.channelId, this.loadingBody());
		this.chunks.push({ id: message.id, content: this.loadingBody() });
		this.lastFlush = Date.now();
		this.loader = setInterval(() => {
			if (this.finished || !this.loading) return;
			this.frame = (this.frame + 1) % SPINNER.length;
			void this.flush();
		}, LOADING_INTERVAL_MS);
	}

	/** Change the loading line, e.g. once the agent starts running tools. */
	setStatus(status: string): void {
		this.status = status;
	}

	/** Replace the not-yet-committed text with the latest rendered reply. */
	push(text: string): void {
		if (this.finished) return;
		if (text.trim()) this.stopLoading();
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

	/**
	 * Write the final text (plus an optional suffix) and stop editing.
	 *
	 * Never rejects. If the final write is what fails, a thrown error here would
	 * leave the message showing the last spinner frame — which reads as a hung
	 * turn rather than a failed one — so the failure is logged and swallowed.
	 */
	async finish(text: string, suffix?: string): Promise<void> {
		this.finished = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.stopLoading();
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
	 * This is for a thread that no longer exists: the spinner and any queued
	 * edit have nowhere to go, and leaving the animation running would keep
	 * requesting a deleted channel. Nothing is written, because there is no one
	 * left to read it.
	 */
	abandon(): void {
		this.finished = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		this.stopLoading();
	}

	private stopLoading(): void {
		this.loading = false;
		if (this.loader) {
			clearInterval(this.loader);
			this.loader = undefined;
		}
	}

	private loadingBody(): string {
		return `${SPINNER[this.frame]} ${this.status}`;
	}

	private flush(): Promise<void> {
		this.lastFlush = Date.now();
		const body = this.loading ? this.loadingBody() : this.text.trim() || this.loadingBody();
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
