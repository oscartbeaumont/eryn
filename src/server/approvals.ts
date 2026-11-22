/**
 * Approval and elicitation messages on the chat surface.
 *
 * The broker owns the wait: OpenCode emits a permission or form event, the
 * broker posts a message through Hub, and a Discord button or an iMessage text
 * reply resolves it. It never stores message content; the only payload it
 * keeps is the tool name and the form fields.
 */

import { newId } from "../core/ids.ts";
import { log } from "../config.ts";
import { describeError } from "../errors.ts";
import { actionButton, buttonRow } from "../discord/components.ts";
import type { DiscordComponent } from "../discord/components.ts";
import { toJsonObject } from "../json.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

interface OutboundMessage {
	channel: string;
	text: string;
	components?: readonly DiscordComponent[];
}

interface PendingPermission {
	readonly kind: "permission";
	readonly id: string;
	readonly sessionID: string;
	readonly requestID: string;
	readonly channel: string;
	readonly provider: string;
	readonly action: string;
	requesterId?: string;
	readonly resolve: (decision: "once" | "always" | "block") => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

interface ApprovalField {
	key: string;
	title?: string;
	description?: string;
	type: string;
	required: boolean;
	options?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
}

interface PendingForm {
	readonly kind: "form";
	readonly id: string;
	readonly sessionID: string;
	readonly formID: string;
	readonly channel: string;
	readonly provider: string;
	readonly title: string;
	readonly fields: readonly ApprovalField[];
	values: Record<string, string>;
	requesterId?: string;
	readonly resolve: (answer: Record<string, string>) => void;
	readonly timer: ReturnType<typeof setTimeout>;
}

type Pending = PendingPermission | PendingForm;

export interface ApprovalBrokerOptions {
	readonly send: (input: {
		channel: string;
		text: string;
		components?: readonly DiscordComponent[];
	}) => Promise<void>;
	readonly replyPermission: (input: {
		sessionID: string;
		requestID: string;
		decision: "once" | "always" | "reject";
	}) => Promise<void>;
	readonly replyForm: (input: {
		sessionID: string;
		formID: string;
		answer: Record<string, string | number | boolean | ReadonlyArray<string>>;
	}) => Promise<void>;
	readonly cancelForm: (input: {
		sessionID: string;
		formID: string;
		message: string;
	}) => Promise<void>;
	readonly grant: (sessionID: string, tool: string) => Promise<void>;
	readonly timeoutMs?: number;
}

function fieldList(value: unknown): ApprovalField[] {
	if (!Array.isArray(value)) return [];

	return value.flatMap((entry) => {
		const field = toJsonObject(entry as never);

		if (!field || typeof field.key !== "string") return [];
		const options = Array.isArray(field.options)
			? field.options.flatMap((option) => {
					const item = toJsonObject(option as never);

					if (!item || typeof item.value !== "string") return [];

					return [
						{
							value: item.value,
							label: typeof item.label === "string" ? item.label : item.value,
						},
					];
				})
			: undefined;

		const parsed: ApprovalField = {
			key: field.key,
			title: typeof field.title === "string" ? field.title : undefined,
			description: typeof field.description === "string" ? field.description : undefined,
			type: typeof field.type === "string" ? field.type : "string",
			required: field.required !== false,
		};

		if (options) parsed.options = options;

		return [parsed];
	});
}

function fieldPrompt(field: ApprovalField): string {
	const label = field.title ?? field.key;
	const required = field.required ? "required" : "optional";
	const options = field.options?.length
		? ` — one of: ${field.options.map((option) => option.value).join(", ")}`
		: "";
	const description = field.description ? "\n  " + field.description : "";

	return `- ${field.key} (${label}, ${required}${options})${description}`;
}

function formPrompt(title: string, fields: readonly ApprovalField[]): string {
	return [
		"**Input needed: " + title + "**",
		"",
		"Reply with one `key: value` line per field.",
		"",
		...fields.map(fieldPrompt),
	].join("\n");
}

function coerce(field: ApprovalField, raw: string): string | number | boolean | string[] {
	if (field.type === "boolean") return /^(true|yes|1|y)$/i.test(raw.trim());
	if (field.type === "number" || field.type === "integer") {
		const value = Number(raw.trim());

		return Number.isFinite(value) ? value : raw;
	}
	if (field.type === "multiselect") {
		const selected = raw
			.split(",")
			.map((part) => part.trim())
			.filter(Boolean);

		return selected.map((part) => {
			const match = field.options?.find(
				(option) => option.value === part || option.label.toLowerCase() === part.toLowerCase(),
			);

			return match?.value ?? part;
		});
	}

	return raw;
}

function parseLines(fields: readonly ApprovalField[], text: string): Map<string, string> {
	const values = new Map<string, string>();
	const keys = new Set(fields.map((field) => field.key));

	for (const line of text.split("\n")) {
		const separator = line.indexOf(":");

		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim();

		if (!keys.has(key)) continue;
		values.set(key, line.slice(separator + 1).trim());
	}

	return values;
}

export class ApprovalBroker {
	private readonly pending = new Map<string, Pending>();

	private readonly options: ApprovalBrokerOptions;

	constructor(options: ApprovalBrokerOptions) {
		this.options = options;
	}

	/** Ask the conversation to approve one tool call. */
	async permission(input: {
		sessionID: string;
		channel: string;
		provider: string;
		action: string;
		resources?: readonly string[];
		message?: string;
		requesterId?: string;
		requesterName?: string;
		requestID: string;
	}): Promise<"once" | "always" | "block"> {
		const id = newId("apr", 6);
		const resources = input.resources?.filter(Boolean).join(", ") || "this action";
		const who = input.requesterName ? " from " + input.requesterName : "";

		return await new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve("block");
				void this.options
					.replyPermission({
						sessionID: input.sessionID,
						requestID: input.requestID,
						decision: "reject",
					})
					.catch(() => undefined);
				void this.options
					.send({ channel: input.channel, text: "The approval timed out." })
					.catch(() => undefined);
			}, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

			const pending: PendingPermission = {
				kind: "permission",
				id,
				sessionID: input.sessionID,
				requestID: input.requestID,
				channel: input.channel,
				provider: input.provider,
				action: input.action,
				resolve: (decision) => {
					clearTimeout(timer);
					resolve(decision);
				},
				timer,
			};

			if (input.requesterId) pending.requesterId = input.requesterId;
			this.pending.set(id, pending);

			const text = [
				"**Approval needed**",
				"`" + input.action + "` on " + resources + who + ".",
				input.message ? "\n" + input.message : "",
				"",
				"1. Allow once",
				"2. Always in this session",
				"3. Block",
			]
				.filter(Boolean)
				.join("\n");
			const components =
				input.provider === "discord"
					? [
							buttonRow([
								actionButton("Allow once", "approval:" + id + ":once", 1),
								actionButton("Always (session)", "approval:" + id + ":always", 2),
								actionButton("Block", "approval:" + id + ":block", 4),
							]),
						]
					: undefined;

			const message: OutboundMessage = { channel: input.channel, text };

			if (components) message.components = components;
			void this.options
				.send(message)
				.catch((error: unknown) => {
					log("approvals", "could not post an approval: " + describeError(error));
					const entry = this.pending.get(id);

					if (entry) {
						clearTimeout(entry.timer);
						this.pending.delete(id);
					}

					void this.options
						.replyPermission({
							sessionID: input.sessionID,
							requestID: input.requestID,
							decision: "reject",
						})
						.catch(() => undefined);
					resolve("block");
				});
		});
	}

	/** The fields of a pending form, for a Discord modal. */
	formDefinition(id: string): { title: string; fields: readonly unknown[] } | undefined {
		const pending = this.pending.get(id);

		if (!pending || pending.kind !== "form") return undefined;

		return { title: pending.title, fields: pending.fields };
	}

	/** Submit a Discord modal as one form answer. */
	async submitForm(
		id: string,
		values: Record<string, string>,
		userId: string | undefined,
	): Promise<boolean> {
		const pending = this.pending.get(id);

		if (!pending || pending.kind !== "form") return false;
		if (pending.requesterId && userId && pending.requesterId !== userId) return false;

		return await this.answerForm(pending, values);
	}

	private async answerForm(pending: PendingForm, values: Record<string, string>): Promise<boolean> {
		for (const [key, value] of Object.entries(values)) pending.values[key] = value;
		const missing = pending.fields.filter(
			(field) => field.required && pending.values[field.key] === undefined,
		);

		if (missing.length > 0) {
			await this.options
				.send({
					channel: pending.channel,
					text: "Still needed: " + missing.map((field) => field.key).join(", "),
				})
				.catch(() => undefined);

			return true;
		}

		clearTimeout(pending.timer);
		this.pending.delete(pending.id);
		const answer: Record<string, string | number | boolean | ReadonlyArray<string>> = {};

		for (const field of pending.fields) {
			const value = pending.values[field.key];

			if (value === undefined) continue;
			// A modal submits every input, so an untouched optional field arrives
			// as "". Only a string field can mean it.
			if (value === "" && field.type !== "string") continue;
			answer[field.key] = coerce(field, value);
		}

		await this.options
			.replyForm({ sessionID: pending.sessionID, formID: pending.formID, answer })
			.catch((error: unknown) => log("approvals", "could not answer the form: " + describeError(error)));

		return true;
	}

	/** Ask the conversation to fill an OpenCode form. */
	async form(input: {
		sessionID: string;
		channel: string;
		provider: string;
		formID: string;
		title: string;
		fields: unknown;
		requesterId?: string;
	}): Promise<void> {
		const id = newId("frm", 6);
		const fields = fieldList(input.fields);

		if (fields.length === 0) return;
		const timer = setTimeout(() => {
			this.pending.delete(id);
			void this.options
				.cancelForm({
					sessionID: input.sessionID,
					formID: input.formID,
					message: "The form timed out.",
				})
				.catch(() => undefined);
			void this.options
				.send({ channel: input.channel, text: "The form timed out." })
				.catch(() => undefined);
		}, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

		const pendingForm: PendingForm = {
			kind: "form",
			id,
			sessionID: input.sessionID,
			formID: input.formID,
			channel: input.channel,
			provider: input.provider,
			title: input.title,
			fields,
			values: {},
			resolve: () => undefined,
			timer,
		};

		if (input.requesterId) pendingForm.requesterId = input.requesterId;
		this.pending.set(id, pendingForm);

		const modal =
			input.provider === "discord" &&
			fields.length <= 5 &&
			fields.every(
				(field) =>
					field.type === "string" ||
					field.type === "number" ||
					field.type === "integer" ||
					field.type === "boolean",
			);

		if (modal) {
			await this.options
				.send({
					channel: input.channel,
					text: "**Input needed: " + input.title + "**",
					components: [buttonRow([actionButton("Fill form", "form:" + id, 1)])],
				})
				.catch(async (error: unknown) => {
					log("approvals", "could not post a form: " + describeError(error));
					clearTimeout(timer);
					this.pending.delete(id);
					await this.options
						.cancelForm({
							sessionID: input.sessionID,
							formID: input.formID,
							message: "The form could not be delivered.",
						})
						.catch(() => undefined);
				});

			return;
		}

		await this.options
			.send({ channel: input.channel, text: formPrompt(input.title, fields) })
			.catch(async (error: unknown) => {
				log("approvals", "could not post a form: " + describeError(error));
				clearTimeout(timer);
				this.pending.delete(id);
				await this.options
					.cancelForm({
						sessionID: input.sessionID,
						formID: input.formID,
						message: "The form could not be delivered.",
					})
					.catch(() => undefined);
			});
	}

	/** A Discord button or another caller that already knows the decision. */
	async reply(
		id: string,
		decision: "once" | "always" | "block",
		userId: string | undefined,
	): Promise<boolean> {
		const pending = this.pending.get(id);

		if (!pending) return false;

		if (pending.requesterId && userId && pending.requesterId !== userId) {
			return false;
		}

		if (pending.kind === "form") return false;
		clearTimeout(pending.timer);
		this.pending.delete(id);
		pending.resolve(decision);

		if (decision === "always") await this.options.grant(pending.sessionID, pending.action);

		await this.options
			.replyPermission({
				sessionID: pending.sessionID,
				requestID: pending.requestID,
				decision: decision === "block" ? "reject" : decision,
			})
			.catch((error: unknown) =>
				log("approvals", "could not answer the permission: " + describeError(error)),
			);

		const answer = decision === "block" ? "Blocked." : decision === "always" ? "Allowed for this session." : "Allowed once.";
		await this.options
			.send({ channel: pending.channel, text: answer })
			.catch(() => undefined);

		return true;
	}

	/**
	 * Treat a chat message as an approval or form answer.
	 *
	 * Returns true when the message was consumed, so the caller must not start a
	 * new agent turn with it.
	 */
	async consumeText(channel: string, text: string, userId?: string): Promise<boolean> {
		// An approval belongs to the person whose turn opened it. Someone else
		// in the channel answering "1" must not decide it for them.
		const pending = [...this.pending.values()]
			.filter((entry) => entry.channel === channel && entry.requesterId === userId)
			.at(-1);

		if (!pending) return false;

		if (pending.kind === "permission") {
			const normalized = text.trim().toLowerCase();
			const decision =
				normalized === "1" || normalized === "once" || normalized === "yes" || normalized === "allow"
					? "once"
					: normalized === "2" || normalized === "always"
						? "always"
						: normalized === "3" || normalized === "no" || normalized === "block" || normalized === "deny"
							? "block"
							: undefined;

			if (!decision) return false;
			clearTimeout(pending.timer);
			this.pending.delete(pending.id);
			pending.resolve(decision);

			if (decision === "always") await this.options.grant(pending.sessionID, pending.action);
			await this.options
				.replyPermission({
					sessionID: pending.sessionID,
					requestID: pending.requestID,
					decision: decision === "block" ? "reject" : decision,
				})
				.catch((error: unknown) =>
					log("approvals", "could not answer the permission: " + describeError(error)),
				);

			return true;
		}

		const values: Record<string, string> = {};

		for (const [key, value] of parseLines(pending.fields, text)) values[key] = value;

		// A message that answers no field is ordinary conversation, not a form
		// reply, so let it reach the agent instead of swallowing it.
		if (Object.keys(values).length === 0) return false;

		return await this.answerForm(pending, values);
	}

	/** Drop every wait for a session that is going away. */
	cancelSession(sessionID: string): void {
		for (const [id, pending] of this.pending) {
			if (pending.sessionID !== sessionID) continue;
			clearTimeout(pending.timer);
			this.pending.delete(id);

			// Never leave a caller awaiting a decision that can no longer arrive.
			if (pending.kind === "permission") pending.resolve("block");
			else pending.resolve({});
		}
	}

	close(): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			if (pending.kind === "permission") pending.resolve("block");
			else pending.resolve({});
			this.pending.delete(id);
		}
		this.pending.clear();
	}
}
