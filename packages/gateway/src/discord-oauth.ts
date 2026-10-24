/**
 * Discord OAuth2 for the setup site.
 *
 * The authorization code grant needs the application's client secret (Discord
 * does not accept the exchange without it), so the flow is: redirect to Discord
 * with a signed `state`, exchange the returned code for the user's token, then
 * list the guilds they administer.
 *
 * Discord rate-limits these bearer-token routes aggressively, so every call is
 * retried on 429 and the guild list is cached by the caller.
 */

const API = "https://discord.com/api/v10";
const MAX_RETRIES = 3;
/** Never wait longer than this inline; a longer limit becomes a surfaced error. */
const MAX_RETRY_WAIT_MS = 3_000;

/** Permission bits that mark a user as able to manage a guild. */
const ADMINISTRATOR = 1n << 3n;
const MANAGE_GUILD = 1n << 5n;

export interface DiscordToken {
	access_token: string;
	expires_in: number;
	scope: string;
}

export interface DiscordGuild {
	id: string;
	name: string;
	icon?: string | null;
	owner?: boolean;
	permissions?: string;
}

export interface DiscordAccount {
	id: string;
	username: string;
	global_name?: string | null;
}

/** A non-retryable Discord response, carrying its HTTP status. */
export class DiscordApiError extends Error {
	readonly status: number;

	constructor(message: string, status: number) {
		super(message);
		this.name = "DiscordApiError";
		this.status = status;
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long Discord asked us to wait, clamped so a request never hangs. */
async function retryAfterMs(response: Response): Promise<number> {
	const header = response.headers.get("retry-after");
	const seconds = header ? Number.parseFloat(header) : Number.NaN;
	if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1_000, MAX_RETRY_WAIT_MS) + 100;
	try {
		const body = (await response.clone().json()) as { retry_after?: unknown };
		if (typeof body.retry_after === "number" && body.retry_after > 0) {
			return Math.min(body.retry_after * 1_000, MAX_RETRY_WAIT_MS) + 100;
		}
	} catch {
		// No JSON body; fall back to a short fixed wait.
	}
	return 500;
}

/** Fetch a Discord route, retrying rate limits a few times before giving up. */
async function discordRequest(path: string, init: RequestInit, label: string): Promise<Response> {
	for (let attempt = 0; ; attempt++) {
		const response = await fetch(`${API}${path}`, init);
		if (response.status !== 429) return response;
		if (attempt >= MAX_RETRIES) {
			throw new DiscordApiError(`${label} is rate limited by Discord (HTTP 429)`, 429);
		}
		await sleep(await retryAfterMs(response));
	}
}

export function redirectUri(origin: string): string {
	return `${origin}/auth/callback`;
}

export function authorizeUrl(options: { origin: string; clientId: string; state: string }): string {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: options.clientId,
		scope: "identify guilds",
		state: options.state,
		redirect_uri: redirectUri(options.origin),
		prompt: "consent",
	});
	// Discord documents space-separated scopes as `%20`, not `+`.
	return `https://discord.com/oauth2/authorize?${params.toString().replaceAll("+", "%20")}`;
}

export async function exchangeCode(options: {
	origin: string;
	clientId: string;
	clientSecret: string;
	code: string;
}): Promise<DiscordToken> {
	const response = await discordRequest(
		"/oauth2/token",
		{
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				authorization: `Basic ${btoa(`${options.clientId}:${options.clientSecret}`)}`,
			},
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code: options.code,
				redirect_uri: redirectUri(options.origin),
			}),
		},
		"Discord sign-in",
	);
	if (!response.ok) throw new DiscordApiError(`Discord rejected the sign-in (HTTP ${response.status})`, response.status);
	return (await response.json()) as DiscordToken;
}

export async function currentUser(accessToken: string): Promise<DiscordAccount> {
	const response = await discordRequest(
		"/users/@me",
		{ headers: { authorization: `Bearer ${accessToken}` } },
		"Discord user lookup",
	);
	if (!response.ok) throw new DiscordApiError(`Discord user lookup failed (HTTP ${response.status})`, response.status);
	return (await response.json()) as DiscordAccount;
}

export async function listUserGuilds(accessToken: string): Promise<DiscordGuild[]> {
	const response = await discordRequest(
		"/users/@me/guilds",
		{ headers: { authorization: `Bearer ${accessToken}` } },
		"Discord guild lookup",
	);
	if (!response.ok) throw new DiscordApiError(`Discord guild lookup failed (HTTP ${response.status})`, response.status);
	return (await response.json()) as DiscordGuild[];
}

/** Whether the signed-in user can manage the guild. */
export function canManage(guild: DiscordGuild): boolean {
	if (guild.owner) return true;
	let permissions: bigint;
	try {
		permissions = BigInt(guild.permissions ?? "0");
	} catch {
		return false;
	}
	return (permissions & (ADMINISTRATOR | MANAGE_GUILD)) !== 0n;
}
