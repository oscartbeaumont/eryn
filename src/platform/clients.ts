/** Typed-ish clients for the internal objects, used by the Worker routes. */

import type { Schema } from "effect";

import { CONTROL_NAME } from "../control/do.ts";
import { withDeploy, withOrigin } from "../deploy.ts";
import { toJsonObject } from "../json.ts";

function object(value: unknown): Schema.JsonObject | undefined {
	return toJsonObject(value as never);
}

export interface CallResult {
	readonly ok: boolean;
	readonly status: number;
	readonly data: Schema.JsonObject;
}

export async function controlCall(
	env: Env,
	path: string,
	body: unknown = {},
): Promise<CallResult> {
	const response = await env.CONTROL.get(env.CONTROL.idFromName(CONTROL_NAME)).fetch(
		"https://control.internal" + path,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		},
	);

	return {
		ok: response.ok,
		status: response.status,
		data: object(await response.json().catch(() => undefined)) ?? {},
	};
}

export async function serverCall(
	env: Env,
	serverId: string,
	path: string,
	body: unknown = {},
	origin?: string,
): Promise<CallResult> {
	const response = await env.SERVER.get(env.SERVER.idFromName(serverId)).fetch(
		"https://server.internal" + path,
		withOrigin(
			withDeploy(env, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			origin,
		),
	);

	return {
		ok: response.ok,
		status: response.status,
		data: object(await response.json().catch(() => undefined)) ?? {},
	};
}

export async function gatewayCall(
	env: Env,
	path: string,
	body: unknown = {},
	origin?: string,
): Promise<Schema.JsonObject> {
	const response = await env.GATEWAY.get(env.GATEWAY.idFromName("gateway")).fetch(
		"https://gateway.internal" + path,
		withOrigin(
			withDeploy(env, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
			origin,
		),
	);

	return object(await response.json().catch(() => undefined)) ?? {};
}

export interface BrowserUser {
	readonly id: string;
	readonly email: string;
}

const COOKIE = "eryn_session";

/** The browser session id, or undefined when the request has no cookie. */
export function sessionId(request: Request): string | undefined {
	const header = request.headers.get("cookie") ?? "";

	for (const part of header.split(";")) {
		const [name, ...rest] = part.trim().split("=");

		if (name === COOKIE) return rest.join("=") || undefined;
	}

	return undefined;
}

/** A Set-Cookie value for a new browser session. */
export function sessionCookie(id: string, secure: boolean): string {
	return [
		COOKIE + "=" + id,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=" + 30 * 24 * 60 * 60,
		...(secure ? ["Secure"] : []),
	].join("; ");
}

export function clearSessionCookie(): string {
	return COOKIE + "=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0";
}

export async function currentUser(env: Env, request: Request): Promise<BrowserUser | undefined> {
	const id = sessionId(request);

	if (!id) return undefined;
	const result = await controlCall(env, "/session", { id });
	const user = object(result.data.user);
	const userId = typeof user?.id === "string" ? user.id : undefined;
	const email = typeof user?.email === "string" ? user.email : undefined;

	if (!userId || !email) return undefined;

	return { id: userId, email };
}

export interface ServerSummary {
	readonly id: string;
	readonly name: string;
}

export async function ownedServers(env: Env, userId: string): Promise<ServerSummary[]> {
	const result = await controlCall(env, "/servers/list", { userId });
	const servers = Array.isArray(result.data.servers) ? result.data.servers : [];

	return servers.flatMap((server) => {
		const entry = object(server);

		if (typeof entry?.id !== "string" || typeof entry.name !== "string") return [];

		return [{ id: entry.id, name: entry.name }];
	});
}

export async function ownsServer(env: Env, userId: string, serverId: string): Promise<boolean> {
	return (await ownedServers(env, userId)).some((server) => server.id === serverId);
}

/** Form fields, with an empty string for anything missing. */
export async function formFields(request: Request): Promise<Record<string, string>> {
	const form = await request.formData().catch(() => undefined);

	if (!form) return {};
	const fields: Record<string, string> = {};

	for (const [key, value] of form.entries()) {
		if (typeof value === "string") fields[key] = value;
	}

	return fields;
}

export function field(fields: Record<string, string>, name: string): string {
	const value = fields[name];

	return typeof value === "string" ? value : "";
}

export function truthy(fields: Record<string, string>, name: string): boolean {
	return fields[name] === "1" || fields[name] === "true" || fields[name] === "on";
}
