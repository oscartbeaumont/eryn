/**
 * The account OAuth flows: GitHub, Google Calendar, and Discord.
 *
 * Each provider is the same shape — an authorize URL, a code exchange, and a
 * profile lookup — so the console can treat every "connect an account" button
 * the same way. GitHub additionally accepts a pasted personal token, which is
 * checked against the API before it is stored.
 */

import type { Provider, Profile } from "./model";

const GITHUB_API = "https://api.github.com";
const GITHUB_OAUTH = "https://github.com/login/oauth";
const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const DISCORD_API = "https://discord.com/api/v10";

/** The scopes requested for a Google account: profile plus full calendar access. */
const GOOGLE_SCOPES = [
	"openid",
	"email",
	"profile",
	"https://www.googleapis.com/auth/calendar",
].join(" ");

export interface GitHubTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number;
}
export interface GoogleTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
}

export function githubAuthorizeUrl(options: { clientId: string; redirectUri: string; state: string }): string {
	const params = new URLSearchParams({
		client_id: options.clientId,
		redirect_uri: options.redirectUri,
		scope: "repo read:user user:email",
		state: options.state,
	});
	return `${GITHUB_OAUTH}/authorize?${params}`;
}

export async function exchangeGitHubCode(options: {
	clientId: string;
	clientSecret: string;
	code: string;
	redirectUri: string;
}): Promise<GitHubTokens> {
	const response = await fetch(`${GITHUB_OAUTH}/access_token`, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: options.clientId,
			client_secret: options.clientSecret,
			code: options.code,
			redirect_uri: options.redirectUri,
		}),
	});
	if (!response.ok) throw new Error(`GitHub rejected the sign-in (HTTP ${response.status})`);
	const body = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		error_description?: string;
	};
	if (!body.access_token) throw new Error(body.error_description ?? "GitHub did not return a token.");
	return githubTokens(body);
}

/**
 * Swap a refresh token for a new access token.
 *
 * A GitHub OAuth App can be set to expire user tokens after eight hours, and it
 * only hands out a refresh token when it does. Dropping that refresh token is
 * how a working connection quietly turns into "Bad credentials" a few hours
 * later, so both halves are stored and this is the other half.
 */
export async function refreshGitHubToken(options: {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}): Promise<GitHubTokens> {
	const response = await fetch(`${GITHUB_OAUTH}/access_token`, {
		method: "POST",
		headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: options.clientId,
			client_secret: options.clientSecret,
			grant_type: "refresh_token",
			refresh_token: options.refreshToken,
		}),
	});
	if (!response.ok) throw new Error(`GitHub refused a token refresh (HTTP ${response.status})`);
	const body = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		expires_in?: number;
		error_description?: string;
	};
	if (!body.access_token) throw new Error(body.error_description ?? "GitHub did not return a token.");
	return githubTokens(body);
}

/** Read the token fields GitHub returns, with an expiry only when it sets one. */
function githubTokens(body: {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
}): GitHubTokens {
	const accessToken = body.access_token;
	if (!accessToken) throw new Error("GitHub did not return a token.");
	return {
		accessToken,
		...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
		...(typeof body.expires_in === "number" && body.expires_in > 0 ? { expiresAt: Date.now() + body.expires_in * 1_000 } : {}),
	};
}

/** The profile a GitHub token belongs to, or a thrown error when it is bad. */
export async function fetchGitHubProfile(token: string): Promise<Profile> {
	const response = await fetch(`${GITHUB_API}/user`, {
		headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "user-agent": "eryn" },
	});
	if (!response.ok) throw new Error(`GitHub rejected that token (HTTP ${response.status}).`);
	const user = (await response.json()) as { id?: unknown; login?: unknown; name?: unknown; avatar_url?: unknown; html_url?: unknown };
	if (typeof user.login !== "string") throw new Error("GitHub did not return a login.");
	return {
		id: typeof user.id === "number" || typeof user.id === "string" ? String(user.id) : user.login,
		username: user.login,
		...(typeof user.name === "string" && user.name ? { name: user.name } : {}),
		...(typeof user.avatar_url === "string" ? { avatarUrl: user.avatar_url } : {}),
		url: typeof user.html_url === "string" ? user.html_url : `https://github.com/${user.login}`,
	};
}

export function googleAuthorizeUrl(options: { clientId: string; redirectUri: string; state: string }): string {
	const params = new URLSearchParams({
		client_id: options.clientId,
		redirect_uri: options.redirectUri,
		response_type: "code",
		scope: GOOGLE_SCOPES,
		access_type: "offline",
		// Without `prompt=consent` Google only issues a refresh token the first
		// time, so a second account would connect without one.
		prompt: "consent",
		include_granted_scopes: "true",
		state: options.state,
	});
	return `${GOOGLE_AUTH}?${params}`;
}

export async function exchangeGoogleCode(options: {
	clientId: string;
	clientSecret: string;
	code: string;
	redirectUri: string;
}): Promise<GoogleTokens> {
	const response = await fetch(GOOGLE_TOKEN, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: options.clientId,
			client_secret: options.clientSecret,
			code: options.code,
			redirect_uri: options.redirectUri,
			grant_type: "authorization_code",
		}),
	});
	if (!response.ok) throw new Error(`Google rejected the sign-in (HTTP ${response.status})`);
	const body = (await response.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
	if (!body.access_token) throw new Error("Google did not return a token.");
	return {
		accessToken: body.access_token,
		...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
		expiresAt: Date.now() + (body.expires_in ?? 3600) * 1_000,
	};
}

export async function fetchGoogleProfile(accessToken: string): Promise<Profile> {
	const response = await fetch(GOOGLE_USERINFO, { headers: { authorization: `Bearer ${accessToken}` } });
	if (!response.ok) throw new Error(`Google rejected that token (HTTP ${response.status}).`);
	const user = (await response.json()) as { sub?: unknown; email?: unknown; name?: unknown; picture?: unknown };
	const email = typeof user.email === "string" ? user.email : undefined;
	return {
		id: typeof user.sub === "string" ? user.sub : (email ?? "google"),
		username: email ?? "google",
		...(typeof user.name === "string" && user.name ? { name: user.name } : {}),
		...(typeof user.picture === "string" ? { avatarUrl: user.picture } : {}),
	};
}

/** The Discord profile behind an OAuth token, for the account row. */
export async function fetchDiscordProfile(token: string): Promise<Profile> {
	const response = await fetch(`${DISCORD_API}/users/@me`, { headers: { authorization: `Bearer ${token}` } });
	if (!response.ok) throw new Error(`Discord rejected that token (HTTP ${response.status}).`);
	const user = (await response.json()) as {
		id?: unknown;
		username?: unknown;
		global_name?: unknown;
		avatar?: unknown;
	};
	if (typeof user.id !== "string") throw new Error("Discord did not return a user.");
	const avatarUrl =
		typeof user.avatar === "string" ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=128` : undefined;
	return {
		id: user.id,
		username: typeof user.username === "string" ? user.username : user.id,
		...(typeof user.global_name === "string" && user.global_name ? { name: user.global_name } : {}),
		...(avatarUrl ? { avatarUrl } : {}),
		// Discord has no universally public profile page, so no url.
	};
}

export function providerName(provider: Provider): string {
	return provider === "google" ? "Google Calendar" : provider === "github" ? "GitHub" : "Discord";
}
