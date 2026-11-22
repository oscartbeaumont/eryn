/**
 * Build an embedded OpenCode host and expose the pieces the promise SDK hides.
 *
 * `OpenCodeWorkerd.create` returns the generated promise client, but not the
 * host runtime. The host runtime is needed to close the host cleanly when the
 * configuration changes. This is the SDK's own promise wrapper with the
 * runtime kept in hand.
 */

import { OpenCode } from "@opencode/client";
import { fromPromise } from "@opencode/core/plugin/promise";
import type { Plugin as PromisePlugin } from "@opencode/plugin";
import type { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import { ServerWorkerd } from "@opencode/server/workerd";
import { Effect } from "effect";

import { EmbeddedHost } from "@opencode/sdk/internal/host";

type CreateOptions = Parameters<typeof OpenCodeWorkerd.create>[0];

export type HostOptions = Omit<CreateOptions, "instances">;

/** The host interface both the promise SDK and this builder return. */
export type HostInterface = OpenCodeWorkerd.Interface;

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

	const client = OpenCode.make({ baseUrl: "http://opencode.local", fetch: host.fetch });

	const register = (plugin: PromisePlugin.Plugin) =>
		host.runtime.runPromise(host.plugins.register(fromPromise(plugin)));

	return {
		...client,
		sessions: client.session,
		events: client.event,
		plugin: Object.assign(register, client.plugin),
		close: host.close,
		[Symbol.asyncDispose]: host.close,
	};
}
