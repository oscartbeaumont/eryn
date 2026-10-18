/**
 * Discord OAuth2 for the setup site.
 *
 * The authorization code grant needs the application's client secret (Discord
 * does not accept the exchange without it), so the flow is: redirect to Discord
 * with a signed `state`, exchange the returned code for the user's token, then
 * list the guilds they administer.
 */

const API = "https://discord.com/api/v10";

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
	const response = await fetch(`${API}/oauth2/token`, {
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
	});
	if (!response.ok) throw new Error(`Discord rejected the sign-in (HTTP ${response.status})`);
	return (await response.json()) as DiscordToken;
}

export async function currentUser(accessToken: string): Promise<DiscordAccount> {
	const response = await fetch(`${API}/users/@me`, { headers: { authorization: `Bearer ${accessToken}` } });
	if (!response.ok) throw new Error(`Discord user lookup failed (HTTP ${response.status})`);
	return (await response.json()) as DiscordAccount;
}

export async function listUserGuilds(accessToken: string): Promise<DiscordGuild[]> {
	const response = await fetch(`${API}/users/@me/guilds`, { headers: { authorization: `Bearer ${accessToken}` } });
	if (!response.ok) throw new Error(`Discord guild lookup failed (HTTP ${response.status})`);
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
