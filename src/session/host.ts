/**
 * Build an embedded OpenCode host and expose the pieces the promise SDK hides.
 *
 * `OpenCodeWorkerd.create` returns the generated promise client, which is what
 * the rest of the bot uses, but not the host runtime. OpenCode's schedule
 * runner has to be forked from that runtime's context (see below), and a plugin
 * cannot do it: plugins see the client services, not Core's private ones. This
 * builder is the SDK's own promise wrapper with the runtime kept in hand.
 *
 * The import reaches into the SDK because `EmbeddedHost.create` is not part of
 * its public exports. It is the same function `OpenCodeWorkerd.create` calls,
 * and the version is pinned.
 */

import { OpenCode } from "@opencode/client";
import { fromPromise } from "@opencode/core/plugin/promise";
import { Schedule } from "@opencode/core/schedule";
import type { Plugin as PromisePlugin } from "@opencode/plugin";
import type { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { ServerWorkerd } from "@opencode/server/workerd";
import { Context, Effect } from "effect";

import { EmbeddedHost } from "@opencode/sdk/internal/host";

type CreateOptions = Parameters<typeof OpenCodeWorkerd.create>[0];

export type HostOptions = Omit<CreateOptions, "instances">;

/** The host interface both the promise SDK and this builder return. */
export interface HostInterface extends OpenCodeWorkerd.Interface {
	/**
	 * Start the schedule runner if this host has an active schedule.
	 *
	 * Returns whether the runner is running. Starting is idempotent, so a host
	 * can be checked again after a turn creates a schedule.
	 */
	ensureSchedules(): Promise<boolean>;
}

export async function createHost(options: HostOptions): Promise<HostInterface> {
	const { plugins = [], ...rest } = options;

	// The profile wrapper in the SDK JSON-encodes the config and splits the
	// server options from the workerd replacements; both come from the same
	// object, and the replacements need `storage` untouched.
	const server = {
		...rest,
		config: rest.config === undefined ? undefined : { content: JSON.stringify(rest.config) },
	};

	const host = await Effect.runPromise(
		EmbeddedHost.create(
			{
				...ServerWorkerd.serverOptions(server),
				log: rest.log,
				plugins: plugins.map((plugin) => fromPromise(plugin)),
			},
			{ overrides: ServerWorkerd.replacements(server) },
		),
	);

	// `EmbeddedHost.create` starts the one background fiber the SDK knows about
	// (resuming suspended sessions) from the same context. The schedule runner
	// is another such fiber on the host runtime: OpenCode's Node server starts
	// it, the workerd profile does not, and it is not reachable from a plugin
	// because plugins see the client services rather than Core's.
	let schedule: Schedule.Interface | undefined;
	let schedulesStarted = false;
	const scheduleService = async () => {
		if (!schedule) {
			const services = await Effect.runPromise(host.runtime.contextEffect);
			schedule = Context.get(services, Schedule.Service);
		}
		return schedule;
	};
	const startSchedules = async () => {
		if (schedulesStarted) return;
		schedulesStarted = true;
		host.runtime.runFork((await scheduleService()).run);
	};
	const ensureSchedules = async () => {
		if (schedulesStarted) return true;
		const active = await host.runtime.runPromise((await scheduleService()).list());
		if (!active.some((entry) => entry.status === "active")) return false;
		await startSchedules();
		return true;
	};

	const client = OpenCode.make({ baseUrl: "http://opencode.local", fetch: host.fetch });
	const register = (plugin: PromisePlugin.Plugin) =>
		host.runtime.runPromise(host.plugins.register(fromPromise(plugin)));

	return {
		...client,
		sessions: client.session,
		events: client.event,
		plugin: Object.assign(register, client.plugin),
		ensureSchedules,
		close: host.close,
		[Symbol.asyncDispose]: host.close,
	};
}
