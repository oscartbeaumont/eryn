/**
 * File tools that need the workspace.
 *
 * Sending a workspace file is a Server-side operation: the file lives in the
 * durable store, and the messaging providers need a URL. `share_file` copies
 * one file to R2 and returns a signed, expiring link; `save_attachment` pulls
 * an incoming chat attachment into the workspace when the agent wants to keep
 * it.
 */

import { Plugin } from "@opencode/plugin";
import type { Schema } from "effect";

import { capture } from "../../analytics.ts";
import { newId } from "../../core/ids.ts";
import { declaredInput, objectSchema, toolRun } from "../tool.ts";
import type { ToolCall, ToolSpec } from "../tool.ts";
import { base64ToBytes, bytesToBase64 } from "../workspace/bytes.ts";
import { resolveToolPath } from "../workspace/paths.ts";
import { fileStore } from "../workspace/store.ts";
import { mintFileToken } from "../../files/token.ts";

const MAX_BYTES = 25 * 1024 * 1024;

const MIME = new Map([
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
	[".pdf", "application/pdf"],
	[".json", "application/json"],
	[".md", "text/markdown"],
	[".txt", "text/plain"],
	[".csv", "text/csv"],
	[".html", "text/html"],
	[".zip", "application/zip"],
]);

function mimeOf(name: string): string {
	const dot = name.lastIndexOf(".");

	return dot >= 0 ? (MIME.get(name.slice(dot).toLowerCase()) ?? "application/octet-stream") : "application/octet-stream";
}

function fileName(url: string): string {
	try {
		const path = new URL(url).pathname;
		const name = path.slice(path.lastIndexOf("/") + 1);

		return name || "attachment";
	} catch {
		return "attachment";
	}
}

export interface FilesPluginOptions {
	readonly env: Env;
	readonly storage: DurableObjectStorage;
	readonly serverId: string;
	readonly origin: string;
	readonly rootForSession: (sessionID: string) => string;
}

export function filesPlugin(options: FilesPluginOptions) {
	const store = fileStore(options.storage);

	const tools: ToolSpec[] = [
		{
			name: "share_file",
			description: "Upload a workspace file and return a link that a chat provider can attach.",
			input: objectSchema(
				{
					path: { type: "string", description: "File path, relative to the channel or absolute" },
				},
				["path"],
			),
			async run(rawInput, call: ToolCall) {
				const { path } = declaredInput<{ path: string }>(rawInput);
				const root = options.rootForSession(call.sessionID);
				const resolved = await resolveToolPath({ store, root, input: path, kind: "file" });
				const file = await store.get(resolved);

				if (!file) throw new Error("File not found: " + resolved);
				const bytes = base64ToBytes(file.b);

				if (bytes.byteLength > MAX_BYTES) {
					throw new Error("That file is larger than 25 MB.");
				}

				const name = resolved.slice(resolved.lastIndexOf("/") + 1) || "file";
				const channel = root.slice(root.lastIndexOf("/") + 1);
				const key = "servers/" + options.serverId + "/" + channel + "/" + newId("art", 10) + "/" + name;

				await options.env.ARTIFACTS.put(key, bytes, {
					httpMetadata: { contentType: mimeOf(name) },
				});
				void capture(
					options.env,
					"file_shared",
					{ mime: mimeOf(name), size: bytes.byteLength },
					{ serverId: options.serverId },
				);
				const token = await mintFileToken(options.env, key);

				if (!token) throw new Error("File links are not configured.");

				return options.origin + "/files/" + encodeURIComponent(key) + "?token=" + encodeURIComponent(token);
			},
		},
		{
			name: "save_attachment",
			description: "Download a chat attachment into the workspace so it persists.",
			input: objectSchema(
				{
					url: { type: "string", description: "The attachment URL" },
					path: { type: "string", description: "Where to save it, relative to the channel" },
				},
				["url"],
			),
			async run(rawInput, call: ToolCall) {
				const { url, path } = declaredInput<{ url: string; path?: string }>(rawInput);

				if (!url.startsWith("https://")) throw new Error("An HTTPS attachment URL is required.");
				const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });

				if (!response.ok) throw new Error("The attachment returned HTTP " + response.status);
				const bytes = new Uint8Array(await response.arrayBuffer());

				if (bytes.byteLength > MAX_BYTES) throw new Error("That attachment is larger than 25 MB.");
				const root = options.rootForSession(call.sessionID);
				const target = await resolveToolPath({
					store,
					root,
					input: path ?? "attachments/" + fileName(url),
					kind: "file",
				});

				await store.put(target, { b: bytesToBase64(bytes), m: Date.now() });

				return target;
			},
		},
	];

	return Plugin.define({
		id: "eryn.files",
		async setup(ctx) {
			await ctx.tool.transform((editor) => {
				tools.forEach((spec) => {
					editor.add({
						name: spec.name,
						description: spec.description,
						input: spec.input,
						execute: (input, context) => toolRun(spec, ctx)(input as Schema.JsonObject, context),
					});
				});
			});
		},
	});
}
