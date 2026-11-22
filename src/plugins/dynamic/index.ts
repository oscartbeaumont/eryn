/**
 * Custom agent plugins, run in Dynamic Workers.
 *
 * A plugin is a JavaScript module with a tiny declarative contract: it exports
 * `tools`, an object of `name -> async (input, context) => result`. Eryn wraps
 * that module in a Worker, loads it with the Worker Loader, and registers one
 * OpenCode tool per entry. Plugin code never shares an isolate with the agent,
 * and a version is pinned by the hash of its source, so an update cannot change
 * the tools a running session already registered: the host rebuilds to pick it
 * up.
 */

import { Plugin } from "@opencode/plugin";
import type { Schema } from "effect";

import { declaredInput, objectSchema, toolRun } from "../tool.ts";
import type { ToolCall, ToolSpec } from "../tool.ts";
import type { PluginRecord } from "../../core/schema.ts";
import { toJsonObject } from "../../json.ts";

/** The subset of a loaded Worker this module uses. */
interface LoadedWorker {
	getEntrypoint(): {
		fetch(input: string | Request, init?: RequestInit): Promise<Response>;
	};
}

interface ToolManifest {
	name: string;
	description?: string;
	input?: Schema.JsonObject;
}

const WRAPPER = `import plugin from "plugin.js";

export default {
	async fetch(request) {
		const message = await request.json();

		if (message.type === "manifest") {
			return Response.json({
				name: plugin.name ?? "plugin",
				tools: Object.entries(plugin.tools ?? {}).map(([name, fn]) => ({
					name,
					description: typeof fn === "function" ? fn.description : undefined,
					input: typeof fn === "function" ? fn.input : undefined,
				})),
			});
		}

		if (message.type === "call") {
			const fn = plugin.tools?.[message.tool];

			if (typeof fn !== "function") {
				return Response.json({ error: "Unknown plugin tool." }, { status: 404 });
			}

			try {
				const value = await fn(message.input ?? {}, message.context ?? {});

				return Response.json({
					result: typeof value === "string" ? value : JSON.stringify(value),
				});
			} catch (error) {
				return Response.json({ error: String(error) }, { status: 500 });
			}
		}

		return new Response("Not found", { status: 404 });
	}
};
`;

/** Load one plugin version, caching by its content hash. */
export function loadPlugin(env: Env, record: PluginRecord): LoadedWorker {
	const id = "eryn-plugin:" + record.id + ":" + record.version;
	const worker = env.PLUGIN_LOADER.get(id, async () => ({
		compatibilityDate: "2026-11-20",
		mainModule: "main.js",
		modules: {
			"main.js": WRAPPER,
			"plugin.js": record.code,
		},
		// A plugin has no bindings and, unless it opted in, no outbound network.
		globalOutbound: record.allowNetwork ? undefined : null,
	}));

	return worker;
}

async function manifestOf(worker: LoadedWorker): Promise<ToolManifest[]> {
	const response = await worker.getEntrypoint().fetch("https://plugin.internal/manifest", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ type: "manifest" }),
	});
	const payload = toJsonObject((await response.json().catch(() => undefined)) as Schema.Json | undefined);
	const listed = payload && Array.isArray(payload.tools) ? payload.tools : [];

	return listed.flatMap((item) => {
		const entry = toJsonObject(item as Schema.Json);

		if (typeof entry?.name !== "string") return [];
		const manifest: ToolManifest = {
			name: entry.name,
			input: toJsonObject(entry.input),
		};
		const description = typeof entry.description === "string" ? entry.description : undefined;

		if (description) manifest.description = description;

		return [manifest];
	});
}

async function callPlugin(
	worker: LoadedWorker,
	tool: string,
	input: Schema.JsonObject,
	context: Schema.JsonObject,
): Promise<string> {
	const response = await worker.getEntrypoint().fetch("https://plugin.internal/call", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ type: "call", tool, input, context }),
	});
	const payload = (await response.json().catch(() => undefined)) as
		| { result?: string; error?: string }
		| undefined;

	if (!response.ok) throw new Error(payload?.error ?? "The plugin failed.");

	return payload?.result ?? "";
}

/**
 * Register every enabled plugin's tools with the host.
 *
 * Load failures are reported as a tool that explains itself rather than
 * failing the host build: one broken plugin should not stop the agent talking.
 */
export function dynamicPluginsPlugin(env: Env, plugins: readonly PluginRecord[]) {
	if (plugins.length === 0) return undefined;

	return Plugin.define({
		id: "eryn.plugins",
		async setup(ctx) {
			for (const record of plugins) {
				let worker: LoadedWorker;

				try {
					worker = loadPlugin(env, record);
				} catch {
					continue;
				}

				let tools: ToolManifest[];

				try {
					tools = await manifestOf(worker);
				} catch {
					continue;
				}

				const specs: ToolSpec[] = tools.map((tool) => {
					const properties = toJsonObject(tool.input?.properties) ?? {};
					const required = Array.isArray(tool.input?.required)
						? tool.input.required.filter((value): value is string => typeof value === "string")
						: [];

					return {
						name: "plugin_" + record.id + "_" + tool.name,
						description:
							(tool.description ?? "Plugin tool " + tool.name) + " (plugin: " + record.name + ")",
						input: objectSchema(properties, required),
						async run(rawInput: Schema.JsonObject, call: ToolCall) {
							const input = declaredInput<Schema.JsonObject>(rawInput);

							return await callPlugin(worker, tool.name, input, {
								sessionID: call.sessionID,
								plugin: record.name,
							});
						},
					} satisfies ToolSpec;
				});

				if (specs.length === 0) continue;

				await ctx.tool.transform((editor) => {
					specs.forEach((spec) => {
						editor.add({
							name: spec.name,
							description: spec.description,
							input: spec.input,
							execute: (input, context) => toolRun(spec, ctx)(input as Schema.JsonObject, context),
						});
					});
				});
			}
		},
	});
}
