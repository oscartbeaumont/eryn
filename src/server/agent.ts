/**
 * The agent runtime for one server.
 *
 * It owns the embedded host, one OpenCode project per channel, and the
 * automations that turn Hub's `message` events into agent turns. Nothing here
 * knows how a message is delivered: replies leave through the MCP server.
 */

import { log } from "../config.ts";
import { SERVER_ROOT, channelRoot } from "../core/paths.ts";
import type { InboundMessage } from "../core/schema.ts";
import { describeError } from "../errors.ts";
import { buildHost, hostSignature } from "./host.ts";
import type { HostConfig } from "./host.ts";
import type { HostInterface } from "../agent/host.ts";
import { seedChannel } from "./seed.ts";
import type { ChannelRecord } from "./models.ts";

export interface AgentDeps {
	readonly env: Env;
	readonly storage: DurableObjectStorage;
	readonly serverId: string;
	readonly origin: () => string | undefined;
	readonly servers: DurableObjectNamespace;
	readonly hubs: DurableObjectNamespace;
	readonly channels: () => Promise<ChannelRecord[]>;
	readonly saveChannel: (record: ChannelRecord) => Promise<void>;
	readonly settings: () => Promise<{ model: string }>;
	readonly connections: () => Promise<HostConfig["connections"]>;
	readonly links: () => Promise<HostConfig["links"]>;
	readonly plugins: () => Promise<HostConfig["plugins"]>;
}

interface RunningHost {
	readonly promise: Promise<HostInterface>;
	readonly signature: string;
}

/** Split a `provider/model#variant` reference. */
interface CreateSessionRequest {
	title: string;
	location: { directory: string };
	model?: ModelRef;
}

interface ModelRef {
	readonly providerID: string;
	readonly id: string;
	readonly variant?: string;
}

function modelRef(model: string): ModelRef | undefined {
	const [base, variant] = model.split("#", 2);
	const slash = (base ?? "").indexOf("/");

	if (slash <= 0) return undefined;
	const providerID = (base ?? "").slice(0, slash);
	const id = (base ?? "").slice(slash + 1);

	return variant ? { providerID, id, variant } : { providerID, id };
}

const HOST_VERSION = "7";

function automationName(channelId: string): string {
	return "messages:" + channelId;
}

function renderMessage(message: InboundMessage): string {
	const lines = [
		"[" + message.provider + " message from " + message.author.name + " in " + message.channel + "]",
		message.text || "(no text)",
	];

	for (const attachment of message.attachments) {
		lines.push("[attachment] " + (attachment.name ?? attachment.url) + " " + attachment.url);
	}

	lines.push(
		"",
		"Reply with send_message if a reply is warranted.",
		'If this conversation has no message watch yet, create one now with watch_mcp_event: server "eryn", event "message", arguments {"channel":"' +
			message.channel +
			'"}, named "messages:' +
			message.channel +
			'". Do this once per conversation.',
	);

	return lines.join("\n");
}

export class ServerAgent {
	private running: RunningHost | undefined;
	private readonly sessionChannel = new Map<string, string>();
	private readonly attaching = new Map<string, Promise<ChannelRecord>>();
	private readonly channelSession = new Map<string, string>();
	private readyAt = 0;

	constructor(private readonly deps: AgentDeps) {}

	rootForSession(sessionID: string): string {
		const channel = this.sessionChannel.get(sessionID);

		return channel ? channelRoot(channel) : SERVER_ROOT;
	}

	/** Whether a live host is likely to have its MCP event stream open. */
	ready(): boolean {
		return this.running !== undefined && Date.now() >= this.readyAt;
	}

	hasHost(): boolean {
		return this.running !== undefined;
	}

	/** Build or reuse a host whose inputs have not changed. */
	async ensureHost(): Promise<HostInterface> {
		const origin = this.deps.origin();

		if (!origin) throw new Error("Eryn does not know its public URL yet. Open the site once.");
		const [connections, links, plugins, signature, settings] = await Promise.all([
			this.deps.connections(),
			this.deps.links(),
			this.deps.plugins(),
			hostSignature(this.deps.storage),
			this.deps.settings(),
		]);
		const config: HostConfig = { connections, links, plugins, model: settings.model, workspace: signature };
		const key = JSON.stringify({
			host: HOST_VERSION,
			deploy: this.deps.env.CF_VERSION?.id ?? "",
			connections: connections.map((entry) => entry.integrationID + ":" + entry.method + ":" + entry.key),
			links: links.map((entry) => entry.id + ":" + entry.url + ":" + (entry.token ?? "")),
			plugins: plugins.map((entry) => entry.id + ":" + entry.version + ":" + entry.enabled),
			workspace: signature,
		});

		if (this.running?.signature === key) return await this.running.promise;

		const previous = this.running?.promise;
		const promise = buildHost(config, {
			env: this.deps.env,
			storage: this.deps.storage,
			serverId: this.deps.serverId,
			origin,
			rootForSession: (sessionID) => this.rootForSession(sessionID),
		});

		this.running = { promise, signature: key };
		this.readyAt = Date.now() + 3_000;

		void promise
			.then(async (host) => {
				this.readyAt = Date.now() + 3_000;
				await this.attachAll(host);
				await previous?.then((old) => old.close()).catch(() => undefined);
			})
			.catch((error: unknown) => {
				if (this.running?.promise === promise) this.running = undefined;
				log("server", "host build failed: " + describeError(error));
			});

		return await promise;
	}

	/** Ensure the host and every bound channel's session and automation. */
	async wake(): Promise<void> {
		await this.ensureHost();
	}

	private async attachAll(host: HostInterface): Promise<void> {
		for (const channel of await this.deps.channels()) {
			try {
				await this.attach(host, channel);
			} catch (error) {
				log("server", "could not attach " + channel.channelId + ": " + describeError(error));
			}
		}
	}

	/** Create the session and message automation for one channel. */
	async attach(host: HostInterface, input: ChannelRecord): Promise<ChannelRecord> {
		const pending = this.attaching.get(input.channelId);

		if (pending) return await pending;
		const run = this.attachInner(host, input).finally(() => {
			this.attaching.delete(input.channelId);
		});

		this.attaching.set(input.channelId, run);

		return await run;
	}

	private async attachInner(host: HostInterface, input: ChannelRecord): Promise<ChannelRecord> {
		await seedChannel(this.deps.storage, input.channelId, input.provider, input.name);
		const root = channelRoot(input.channelId);
		const ref = modelRef((await this.deps.settings()).model);
		let sessionID = input.sessionID;

		if (sessionID) {
			try {
				await host.sessions.get({ sessionID });
			} catch {
				sessionID = undefined;
			}
		}

		if (!sessionID) {
			const request: CreateSessionRequest = {
				title: input.name ?? input.channelId,
				location: { directory: root },
			};

			if (ref) request.model = ref;
			const session = await host.sessions.create(request);

			sessionID = session.id;
		}

		this.sessionChannel.set(sessionID, input.channelId);
		this.channelSession.set(input.channelId, sessionID);

		if (ref) {
			await host.sessions
				.switchModel({ sessionID, model: ref })
				.catch((error: unknown) => log("server", "could not set the model: " + describeError(error)));
		}

		let automationID = input.automationID;
		const name = automationName(input.channelId);

		// The agent creates the watch itself through `watch_mcp_event`; this only
		// discovers one it has already made, so a restart keeps using it.
		try {
			const automations = await host.experimental.automation.list({ sessionID });
			const existing = automations.find((entry) => entry.name === name);

			if (existing) automationID = existing.id;
		} catch (error) {
			log("server", "could not list automations: " + describeError(error));
		}

		const record: ChannelRecord = { ...input, sessionID, automationID };

		await this.deps.saveChannel(record);
		await this.deps.hubs
			.get(this.deps.hubs.idFromName(this.deps.serverId))
			.fetch("https://hub.internal/remember-session", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionID, channel: input.channelId }),
			})
			.catch(() => undefined);

		return record;
	}

	/** Attach a new channel, after Hub has bound it. */
	async attachChannel(input: ChannelRecord): Promise<ChannelRecord> {
		await this.deps.saveChannel(input);
		const host = await this.ensureHost();

		return await this.attach(host, input);
	}

	/** Prompt a channel directly while its agent-owned message watch is absent. */
	async prompt(channel: string, message: InboundMessage): Promise<boolean> {
		const host = await this.ensureHost();
		const existing = (await this.deps.channels()).find((entry) => entry.channelId === channel);

		if (!existing) return false;
		const record = await this.attach(host, existing);

		// Once the agent has created its watch and the MCP stream is open, the
		// event drives the turn and prompting here would run it twice.
		if (record.automationID && this.ready()) return false;

		if (!record.sessionID) return false;
		const ref = modelRef((await this.deps.settings()).model);

		if (ref) await host.sessions.switchModel({ sessionID: record.sessionID, model: ref }).catch(() => undefined);
		await host.sessions.prompt({
			sessionID: record.sessionID,
			text: renderMessage(message),
		});

		return true;
	}

	/** Remove a channel's watch and session when it is detached. */
	async detach(record: ChannelRecord): Promise<void> {
		const channel = record.channelId;
		const sessionID = record.sessionID ?? this.channelSession.get(channel);

		if (!sessionID) return;
		const host = this.running
			? await this.running.promise
			: await this.ensureHost().catch(() => undefined);

		if (!host) return;

		try {
			const automations = await host.experimental.automation.list({ sessionID });
			const name = automationName(channel);

			for (const automation of automations) {
				if (automation.name !== name) continue;
				await host.experimental.automation.delete({ automationID: automation.id }).catch(() => undefined);
			}
		} catch (error) {
			log("server", "could not remove the channel watch: " + describeError(error));
		}

		await host.sessions.remove({ sessionID }).catch(() => undefined);
		this.channelSession.delete(channel);
		this.sessionChannel.delete(sessionID);
	}

	/** Point every open session at the server's current model. */
	async refreshModels(): Promise<void> {
		if (!this.running) return;
		const ref = modelRef((await this.deps.settings()).model);

		if (!ref) return;
		const host = await this.running.promise;

		for (const sessionID of this.channelSession.values()) {
			await host.sessions.switchModel({ sessionID, model: ref }).catch(() => undefined);
		}
	}

	/** Stop the run in one channel. */
	async interrupt(channel: string): Promise<boolean> {
		if (!this.running) return false;
		const sessionID = this.channelSession.get(channel);

		if (!sessionID) return false;
		const host = await this.running.promise;

		await host.sessions.interrupt({ sessionID }).catch(() => undefined);

		return true;
	}

	async close(): Promise<void> {
		const running = this.running;

		this.running = undefined;
		this.sessionChannel.clear();
		this.channelSession.clear();
		await running?.promise.then((host) => host.close()).catch(() => undefined);
	}
}
