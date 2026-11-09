/**
 * The Discord application this deployment runs.
 *
 * The hosted Eryn is the application `src/public.ts` names, so it never has to
 * ask Discord. A self-hosted deployment runs its own application and supplies
 * only the bot token: the application id, the key that signs interactions, and
 * the URL Discord posts them to all come from Discord itself. Each is read once
 * per isolate.
 */

import { configuredOrigin, INTERACTIONS_PATH, log } from "../config";
import { CLIENT_ID } from "../public";

const API = "https://discord.com/api/v10";

export interface Application {
	/** The application id, which is also the bot's user id. */
	readonly id: string;
	/** The Ed25519 key Discord signs this application's interactions with. */
	readonly verifyKey?: string;
	/** Where Discord posts interactions, once a deployment has set it. */
	endpoint?: string;
}

let cachedToken: string | undefined;
let cached: Promise<Application | undefined> | undefined;

/** The application the bot token belongs to, or undefined when Discord will not say. */
export function application(env: Env): Promise<Application | undefined> {
	const token = env.DISCORD_BOT_TOKEN?.trim();
	if (!token) return Promise.resolve(undefined);
	if (!cached || cachedToken !== token) {
		cachedToken = token;
		cached = fetchApplication(token);
	}
	return cached;
}

async function fetchApplication(token: string): Promise<Application | undefined> {
	try {
		const response = await fetch(`${API}/applications/@me`, {
			headers: { authorization: `Bot ${token}` },
		});
		if (!response.ok) {
			log("application", `Discord returned HTTP ${response.status} for this application`);
			return undefined;
		}
		const body = (await response.json()) as {
			id?: unknown;
			verify_key?: unknown;
			interactions_endpoint_url?: unknown;
		};
		if (typeof body.id !== "string") return undefined;
		return {
			id: body.id,
			...(typeof body.verify_key === "string" ? { verifyKey: body.verify_key } : {}),
			...(typeof body.interactions_endpoint_url === "string"
				? { endpoint: body.interactions_endpoint_url }
				: {}),
		};
	} catch (error) {
		log("application", `could not read this application: ${String(error)}`);
		return undefined;
	}
}

/** The id an install link is built for. */
export async function applicationId(env: Env): Promise<string> {
	return (await application(env))?.id ?? CLIENT_ID;
}

/**
 * The public origin of this deployment.
 *
 * A deployment that sets `PUBLIC_ORIGIN` knows it. Everyone else learns it from
 * Discord: `ensureEndpoint` points the application's interactions endpoint at
 * the origin serving its requests, and this reads that back.
 */
export async function resolveOrigin(env: Env): Promise<string | undefined> {
	const configured = configuredOrigin(env);
	if (configured) return configured;
	const endpoint = (await application(env))?.endpoint;
	if (!endpoint) return undefined;
	try {
		return new URL(endpoint).origin;
	} catch {
		return undefined;
	}
}

/** Endpoints this isolate has already pointed Discord at. */
const ensured = new Set<string>();

/**
 * Point interactions at the origin serving this request.
 *
 * A self-hosted deployment configures no domain, and the only place its public
 * URL is known is an incoming request. Discord verifies the URL with a signed
 * PING before accepting it, so a deployment that cannot answer keeps gateway
 * delivery instead.
 */
export async function ensureEndpoint(env: Env, origin: string): Promise<void> {
	// Discord only posts to HTTPS, and a local dev server must never rewrite the
	// endpoint of the application that token belongs to.
	if (!origin.startsWith("https://")) return;
	const endpoint = `${origin.replace(/\/$/, "")}${INTERACTIONS_PATH}`;
	if (ensured.has(endpoint)) return;
	const token = env.DISCORD_BOT_TOKEN?.trim();
	if (!token) return;
	const current = await application(env);
	if (!current) return;
	if (current.endpoint !== endpoint) {
		const response = await fetch(`${API}/applications/@me`, {
			method: "PATCH",
			headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
			body: JSON.stringify({ interactions_endpoint_url: endpoint }),
		});
		if (!response.ok) {
			log("application", `could not deliver interactions to ${endpoint}: HTTP ${response.status}`);
			return;
		}
		current.endpoint = endpoint;
		log("application", `interactions are now delivered to ${endpoint}`);
	}
	ensured.add(endpoint);
}
