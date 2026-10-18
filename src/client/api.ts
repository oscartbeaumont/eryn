/** The typed boundary between the Solid app and the Worker's JSON API. */

export interface Guild {
	id: string;
	name: string;
	icon: string | null;
	configured: boolean;
	model: string;
	updatedAt: number | null;
	githubRepo: string | null;
	githubInstalled: boolean;
	githubInstallUrl: string | null;
}

/** A manageable server Eryn is not installed in yet. */
export interface AvailableGuild {
	id: string;
	name: string;
	icon: string | null;
}

export interface Account {
	id: string;
	name: string;
}

export interface SetupData {
	signedIn: boolean;
	account?: Account;
	githubConfigured?: boolean;
	guilds?: Guild[];
	available?: AvailableGuild[];
}

export interface SaveGuildInput {
	action: "save" | "remove";
	guildId: string;
	apiKey?: string;
	model?: string;
	githubRepo?: string;
}

export interface ApiResult {
	ok?: boolean;
	message?: string;
	error?: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, { credentials: "same-origin", ...init });
	const body = (await response.json().catch(() => ({}))) as T & { error?: string };
	if (!response.ok) throw new Error(body.error ?? `Request failed (HTTP ${response.status})`);
	return body;
}

export function fetchSetup(): Promise<SetupData> {
	return request<SetupData>("/api/setup");
}

export function saveGuild(input: SaveGuildInput): Promise<ApiResult> {
	return request<ApiResult>("/api/setup", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			action: input.action,
			guild_id: input.guildId,
			api_key: input.apiKey,
			model: input.model,
			github_repo: input.githubRepo,
		}),
	});
}
