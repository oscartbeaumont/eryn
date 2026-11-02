/**
 * The GitHub tools.
 *
 * Like Discord's, they belong to the MCP endpoint rather than to the agent, so
 * one set serves a harness and the bot. Unlike Discord, they authenticate as
 * whoever connected them, in one of two ways:
 *
 * - **A personal access token**, so every action carries the user's own name.
 * - **Eryn's GitHub App**, which is installed on the user's account; actions are
 *   attributed to the app, acting on their behalf, which is what an installation
 *   is for.
 *
 * The same tools work either way, because the only difference is where the
 * bearer token comes from.
 */

import { appJwt, type GitHubConfig } from "../github";

const API = "https://api.github.com";
const JSON_HEADERS = {
	accept: "application/vnd.github+json",
	"x-github-api-version": "2022-11-28",
	"user-agent": "eryn",
};

/** How the tools are authenticated, which decides whose name the actions carry. */
export type GitHubCredential =
	| { kind: "pat"; token: string }
	| { kind: "app"; appId: string; privateKey: string; installationId: string };

/** A REST client that acts as whichever credential it was given. */
export interface GitHubApi {
	request<T>(method: string, path: string, body?: unknown): Promise<T>;
	/** The repositories this credential can reach, across both flows. */
	listRepos(limit: number): Promise<Record<string, unknown>[]>;
	/** Who the actions will be attributed to. */
	identity(): Promise<{ login: string; kind: "pat" | "app" }>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A client for one credential.
 *
 * An installation token lasts an hour, so it is cached for the life of whatever
 * holds this client rather than minted per call.
 */
export function githubApi(credential: GitHubCredential): GitHubApi {
	let cached: { token: string; expiresAt: number } | undefined;

	async function token(): Promise<string> {
		if (credential.kind === "pat") return credential.token;
		if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
		const jwt = await appJwt(credential.appId, credential.privateKey);
		const response = await fetch(`${API}/app/installations/${credential.installationId}/access_tokens`, {
			method: "POST",
			headers: { ...JSON_HEADERS, authorization: `Bearer ${jwt}` },
		});
		if (!response.ok) throw new Error(`GitHub refused an installation token (HTTP ${response.status})`);
		const body = (await response.json()) as { token: string; expires_at: string };
		cached = { token: body.token, expiresAt: Date.parse(body.expires_at) || Date.now() + 3_000_000 };
		return body.token;
	}

	async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			const headers: Record<string, string> = { ...JSON_HEADERS, authorization: `Bearer ${await token()}` };
			if (body !== undefined) headers["content-type"] = "application/json";
			const response = await fetch(`${API}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			// Rate limits and outages are worth another go; a 403 is not, because
			// GitHub uses it for both "forbidden" and "rate limited" and the body is
			// what tells them apart, which the caller gets to see.
			if ((response.status === 429 || response.status >= 500) && attempt < 3) {
				await sleep(500 * (attempt + 1));
				continue;
			}
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				if (response.status === 401) {
					throw new Error(
						`GitHub rejected the stored token (HTTP 401). Reconnect the GitHub account in the Eryn console, then try again. ${clip(detail, 300)}`.trim(),
					);
				}
				throw new Error(`GitHub ${method} ${path} failed (HTTP ${response.status}) ${clip(detail, 300)}`.trim());
			}
			return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
		}
	}

	const api: GitHubApi = {
		request,
		async listRepos(limit) {
			if (credential.kind === "pat") {
				return await request<Record<string, unknown>[]>(
					"GET",
					`/user/repos?per_page=${limit}&sort=updated&affiliation=owner,collaborator,organization_member`,
				);
			}
			const listed = await request<{ repositories?: Record<string, unknown>[] }>(
				"GET",
				`/installation/repositories?per_page=${limit}`,
			);
			return Array.isArray(listed?.repositories) ? listed.repositories : [];
		},
		async identity() {
			if (credential.kind === "pat") {
				const user = await request<{ login?: unknown }>("GET", "/user");
				return { login: typeof user?.login === "string" ? user.login : "unknown", kind: "pat" };
			}
			const installation = await request<{ account?: { login?: unknown } }>(
				"GET",
				`/app/installations/${credential.installationId}`,
			);
			const login = installation?.account?.login;
			return { login: typeof login === "string" ? login : "unknown", kind: "app" };
		},
	};
	return api;
}

// --- Formatting ---------------------------------------------------------------

/** How much of one body to include before cutting it short. */
const BODY_LIMIT = 1_200;

function clip(text: string, limit = BODY_LIMIT): string {
	const collapsed = text.replace(/\r/g, "").trim();
	return collapsed.length > limit ? `${collapsed.slice(0, limit)}…` : collapsed;
}

const stringArg = (value: unknown): string | undefined => (typeof value === "string" && value.trim() ? value.trim() : undefined);
const numberArg = (value: unknown, fallback: number): number => {
	const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
	return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
};
const boolArg = (value: unknown): boolean => value === true || value === "true";
const listArg = (value: unknown): string[] =>
	Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [];

/** `owner/name`, checked here so a typo does not become a request. */
function requireRepo(value: unknown): string {
	const repo = stringArg(value);
	if (!repo || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
		throw new Error(`repo must be "owner/name", got ${JSON.stringify(value ?? null)}`);
	}
	return repo;
}

function requireNumber(value: unknown, field: string): number {
	const parsed = numberArg(value, Number.NaN);
	if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${field} must be a number, got ${JSON.stringify(value ?? null)}`);
	return parsed;
}

interface IssueLike {
	number?: unknown;
	title?: unknown;
	state?: unknown;
	user?: { login?: unknown };
	labels?: { name?: unknown }[];
	comments?: unknown;
	html_url?: unknown;
	body?: unknown;
	draft?: unknown;
	pull_request?: unknown;
	created_at?: unknown;
	updated_at?: unknown;
	head?: { ref?: unknown };
	base?: { ref?: unknown };
}

function labelsOf(entry: IssueLike): string {
	const names = (entry.labels ?? []).map((label) => label?.name).filter((name): name is string => typeof name === "string");
	return names.length ? ` [${names.join(", ")}]` : "";
}

function issueLine(entry: IssueLike): string {
	const user = entry.user?.login ?? "unknown";
	return `#${entry.number} ${entry.state ?? ""} "${clip(String(entry.title ?? ""), 140)}"${labelsOf(entry)} by ${user} (${entry.comments ?? 0} comments)${entry.draft ? " draft" : ""}`;
}

function pullLine(entry: IssueLike): string {
	const user = entry.user?.login ?? "unknown";
	const branches = entry.head?.ref && entry.base?.ref ? ` ${entry.head.ref}→${entry.base.ref}` : "";
	return `#${entry.number} ${entry.state ?? ""}${entry.draft ? " draft" : ""} "${clip(String(entry.title ?? ""), 140)}"${labelsOf(entry)}${branches} by ${user}`;
}

function header(entry: IssueLike): string {
	const lines = [
		`#${entry.number} ${entry.title ?? ""}`,
		`state: ${entry.state ?? "?"}${entry.draft ? " (draft)" : ""}${labelsOf(entry)}  by ${entry.user?.login ?? "unknown"}`,
		`created: ${entry.created_at ?? "?"}  updated: ${entry.updated_at ?? "?"}`,
		String(entry.html_url ?? ""),
	];
	return lines.filter(Boolean).join("\n");
}

/** A comment, rendered so a model can tell who said what and when. */
function commentLine(comment: { user?: { login?: unknown }; created_at?: unknown; body?: unknown }): string {
	return `--- ${comment.user?.login ?? "unknown"} at ${comment.created_at ?? "?"}\n${clip(String(comment.body ?? ""), 600)}`;
}

/** One tool, described the way the MCP server registers it. */
export interface GitHubTool {
	name: string;
	title: string;
	description: string;
	inputSchema: {
		type: "object";
		properties: Record<string, unknown>;
		required?: string[];
		additionalProperties: false;
	};
	run: (api: GitHubApi, args: Record<string, unknown>) => Promise<string>;
}

const repoProperty = {
	type: "string",
	description: 'The repository as "owner/name", for example "anomalyco/opencode".',
};

export const GITHUB_TOOLS: readonly GitHubTool[] = [
	{
		name: "github_whoami",
		title: "Show which GitHub account the tools act as",
		description:
			"Report the GitHub account these tools act as, so it is clear whose name an action carries.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
		run: async (api) => {
			const who = await api.identity();
			return who.kind === "pat"
				? `Acting as ${who.login} with the GitHub account connected in the Eryn console, so actions carry that name.`
				: `Acting as Eryn's GitHub App installed on ${who.login}, so actions are attributed to the app on their behalf.`;
		},
	},
	{
		name: "github_repos",
		title: "List accessible GitHub repositories",
		description:
			"List the repositories these tools can reach, most recently updated first, with their default branch and visibility.",
		inputSchema: {
			type: "object",
			properties: { limit: { type: "integer", description: "How many repositories, 1-100. Defaults to 30." } },
			additionalProperties: false,
		},
		run: async (api, args) => {
			const repos = await api.listRepos(Math.min(Math.max(numberArg(args.limit, 30), 1), 100));
			if (!repos.length) return "No repositories are reachable with the connected credential.";
			return repos
				.map((repo) => {
					const entry = repo as { full_name?: unknown; private?: unknown; default_branch?: unknown; description?: unknown };
					const visibility = entry.private ? "private" : "public";
					const description = entry.description ? ` — ${clip(String(entry.description), 120)}` : "";
					return `${entry.full_name} (${visibility}, default ${entry.default_branch ?? "?"})${description}`;
				})
				.join("\n");
		},
	},
	{
		name: "github_repo",
		title: "Read a GitHub repository",
		description: "Read one repository's description, default branch, language, and activity counts.",
		inputSchema: { type: "object", properties: { repo: repoProperty }, required: ["repo"], additionalProperties: false },
		run: async (api, args) => {
			const repo = requireRepo(args.repo);
			const info = await api.request<Record<string, unknown>>("GET", `/repos/${repo}`);
			const entry = info as {
				full_name?: unknown;
				description?: unknown;
				private?: unknown;
				default_branch?: unknown;
				language?: unknown;
				open_issues_count?: unknown;
				stargazers_count?: unknown;
				forks_count?: unknown;
				pushed_at?: unknown;
				html_url?: unknown;
			};
			return [
				`${entry.full_name} (${entry.private ? "private" : "public"})`,
				String(entry.description ?? "(no description)"),
				`default branch: ${entry.default_branch ?? "?"}  language: ${entry.language ?? "?"}`,
				`open issues and pull requests: ${entry.open_issues_count ?? 0}  stars: ${entry.stargazers_count ?? 0}  forks: ${entry.forks_count ?? 0}`,
				`last push: ${entry.pushed_at ?? "?"}`,
				String(entry.html_url ?? ""),
			]
				.filter(Boolean)
				.join("\n");
		},
	},
	{
		name: "github_issues",
		title: "List GitHub issues",
		description:
			"List a repository's issues, newest first. Pull requests are excluded — use github_pulls for those. Filter by state, labels, or assignee, and page with `page`.",
		inputSchema: {
			type: "object",
			properties: {
				repo: repoProperty,
				state: { type: "string", enum: ["open", "closed", "all"], description: "Defaults to open." },
				labels: { type: "array", items: { type: "string" }, description: "Only issues carrying all of these labels." },
				assignee: { type: "string", description: 'A login, or "*" for any assignee.' },
				since: { type: "string", description: "Only issues updated at or after this ISO 8601 timestamp." },
				sort: { type: "string", enum: ["created", "updated", "comments"], description: "Defaults to updated." },
				limit: { type: "integer", description: "How many issues, 1-100. Defaults to 30." },
				page: { type: "integer", description: "Page number, for going further back." },
			},
			required: ["repo"],
			additionalProperties: false,
		},
		run: async (api, args) => {
			const repo = requireRepo(args.repo);
			const query = new URLSearchParams({
				state: stringArg(args.state) ?? "open",
				sort: stringArg(args.sort) ?? "updated",
				direction: "desc",
				per_page: String(Math.min(Math.max(numberArg(args.limit, 30), 1), 100)),
			});
			if (stringArg(args.assignee)) query.set("assignee", stringArg(args.assignee)!);
			if (stringArg(args.since)) query.set("since", stringArg(args.since)!);
			if (listArg(args.labels).length) query.set("labels", listArg(args.labels).join(","));
			if (numberArg(args.page, 1) > 1) query.set("page", String(numberArg(args.page, 1)));
			const listed = await api.request<IssueLike[]>("GET", `/repos/${repo}/issues?${query}`);
			const issues = (Array.isArray(listed) ? listed : []).filter((entry) => !entry.pull_request);
			if (!issues.length) return `No issues matched in ${repo}.`;
			return issues.map(issueLine).join("\n");
		},
	},
	{
		name: "github_issue",
		title: "Read a GitHub issue",
		description: "Read one issue in full, with its comments.",
		inputSchema: {
			type: "object",
			properties: { repo: repoProperty, number: { type: "integer", description: "The issue number." } },
			required: ["repo", "number"],
			additionalProperties: false,
		},
		run: async (api, args) => {
			const repo = requireRepo(args.repo);
			const number = requireNumber(args.number, "number");
			const issue = await api.request<IssueLike & { body?: unknown }>("GET", `/repos/${repo}/issues/${number}`);
			const comments = await api.request<{ user?: { login?: unknown }; created_at?: unknown; body?: unknown }[]>(
				"GET",
				`/repos/${repo}/issues/${number}/comments?per_page=50`,
			);
			const parts = [header(issue), "", clip(String(issue.body ?? "(no body)"))];
			if (Array.isArray(comments) && comments.length) parts.push("", `${comments.length} comment(s):`, ...comments.map(commentLine));
			return parts.join("\n");
		},
	},
	{
		name: "github_create_issue",
		title: "Create a GitHub issue",
		description:
			"Open an issue. Keep the body in Markdown and use it to record what was observed, what was expected, and how to reproduce.",
		inputSchema: {
			type: "object",
			properties: {
				repo: repoProperty,
				title: { type: "string", description: "The issue title." },
				body: { type: "string", description: "The issue body, in Markdown." },
				labels: { type: "array", items: { type: "string" }, description: "Labels to apply." },
				assignees: { type: "array", items: { type: "string" }, description: "Logins to assign." },
			},
			required: ["repo", "title"],
			additionalProperties: false,
		},
		run: async (api, args) => {
			const repo = requireRepo(args.repo);
			const title = stringArg(args.title);
			if (!title) throw new Error("title is required");
			const created = await api.request<{ number?: unknown; html_url?: unknown }>("POST", `/repos/${repo}/issues`, {
				title,
				...(stringArg(args.body) ? { body: stringArg(args.body)! } : {}),
				...(listArg(args.labels).length ? { labels: listArg(args.labels) } : {}),
				...(listArg(args.assignees).length ? { assignees: listArg(args.assignees) } : {}),
			});
			return `Created issue #${created?.number} in ${repo}: ${created?.html_url ?? ""}`;
		},
	},
	{
		name: "github_update_issue",
		title: "Update a GitHub issue or pull request",
		description:
			"Change an issue's or pull request's state, labels, assignees, title, or body. Closing is often what someone wants after a fix; say so when you do it.",
		inputSchema: {
			type: "object",
			properties: {
				repo: repoProperty,
				number: { type: "integer", description: "The issue or pull request number." },
				state: { type: "string", enum: ["open", "closed"], description: "Set the state." },
				state_reason: {
					type: "string",
					enum: ["completed", "not_planned", "reopened"],
					description: "Why it is being closed.",
				},
				title: { type: "string", description: "A new title." },
				body: { type: "string", description: "A new body, in Markdown." },
				labels: { type: "array", items: { type: "string" }, description: "Replace the labels with these." },
				assignees: { type: "array", items: { type: "string" }, description: "Replace the assignees with these." },
			},
			required: ["repo", "number"],
			additionalProperties: false,
		},
		run: async (api, args) => {
			const repo = requireRepo(args.repo);
			const number = requireNumber(args.number, "number");
			const body: Record<string, unknown> = {};
			for (const field of ["state", "state_reason", "title", "body"] as const) {
				if (stringArg(args[field])) body[field] = stringArg(args[field]);
			}
			if (listArg(args.labels).length || args.labels !== undefined) body.labels = listArg(args.labels);
			if (listArg(args.assignees).length || args.assignees !== undefined) body.assignees = listArg(args.assignees);
			if (!Object.keys(body).length) throw new Error("nothing to change: give at least one field");
			const updated = await api.request<IssueLike>("PATCH", `/repos/${repo}/issues/${number}`, body);
			return `Updated #${number}: now ${updated?.state ?? "?"}${labelsOf(updated)}.`;
		},
	},
	{
		name: "github_comment",
		title: "Comment on a GitHub issue or pull request",
		description:
			"Add a comment to an issue or a pull request. Both take comments the same way. Use it to report progress, ask a question, or leave the reasoning behind a change.",
		inputSchema: {
			type: "object",
			properties: {
				repo: repoProperty,
				number: { type: "integer", description: "The issue or pull request number." },
				body: { type: "string", description: "The comment, in Markdown." },
			},
			required: ["repo", "number", "body"],
			additionalProperties: false,
		},
		run: async (api, args) => {
			const repo = requireRepo(args.repo);
			const number = requireNumber(args.number, "number");
			const body = stringArg(args.body);
			if (!body) throw new Error("body is required");
			const created = await api.request<{ html_url?: unknown }>("POST", `/repos/${repo}/issues/${number}/comments`, { body });
			return `Commented on #${number}: ${created?.html_url ?? ""}`;
		},
	},
	{
		name: "github_search",
		title: "Search GitHub issues and pull requests",
		description:
			"Search issues and pull requests across every repository the credential can reach, using GitHub's search syntax — for example `is:open label:bug repo:owner/name`, `is:pr author:someone`, or `is:merged`. Use this when you do not know where something was reported.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "A GitHub search query, e.g. `is:issue is:open label:bug`." },
				sort: { type: "string", enum: ["created", "updated", "comments", "reactions"], description: "Defaults to updated." },
				limit: { type: "integer", description: "How many results, 1-100. Defaults to 25." },
			},
			required: ["query"],
			additionalProperties: false,
		},
		run: async (api, args) => {
			const query = stringArg(args.query);
			if (!query) throw new Error("query is required");
			const params = new URLSearchParams({
				q: query,
				sort: stringArg(args.sort) ?? "updated",
				order: "desc",
				per_page: String(Math.min(Math.max(numberArg(args.limit, 25), 1), 100)),
			});
			const found = await api.request<{ total_count?: unknown; items?: IssueLike[] }>("GET", `/search/issues?${params}`);
			const items = Array.isArray(found?.items) ? found.items : [];
			if (!items.length) return `Nothing matched \`${query}\`.`;
			return [`${items.length} of ${found?.total_count ?? "?"} matches:`, ...items.map(issueLine)].join("\n");
		},
	},
	{
		name: "github_pulls",
		title: "List GitHub pull requests",
		description: "List a repository's pull requests, newest first, optionally filtered by state, base branch, or head branch.",
		inputSchema: {
			type: "object",
			properties: {
				repo: repoProperty,
				state: { type: "string", enum: ["open", "closed", "all"], description: "Defaults to open." },
				base: { type: "string", description: "Only pull requests targeting this branch." },
				head: { type: "string", description: "Only pull requests from this branch or `owner:branch`." },
				sort: { type: "string", enum: ["created", "updated", "popularity", "long-running"], description: "Defaults to updated." },
				limit: { type: "integer", description: "How many pull requests, 1-100. Defaults to 30." },
				page: { type: "integer", description: "Page number, for going further back." },
			},
			required: ["repo"],
			additionalProperties: false,
		},
		run: async (api, args) => {
			const repo = requireRepo(args.repo);
			const query = new URLSearchParams({
				state: stringArg(args.state) ?? "open",
				sort: stringArg(args.sort) ?? "updated",
				direction: "desc",
				per_page: String(Math.min(Math.max(numberArg(args.limit, 30), 1), 100)),
			});
			for (const field of ["base", "head"] as const) if (stringArg(args[field])) query.set(field, stringArg(args[field])!);
			if (numberArg(args.page, 1) > 1) query.set("page", String(numberArg(args.page, 1)));
			const listed = await api.request<IssueLike[]>("GET", `/repos/${repo}/pulls?${query}`);
			if (!Array.isArray(listed) || !listed.length) return `No pull requests matched in ${repo}.`;
			return listed.map(pullLine).join("\n");
		},
	},
	{
		name: "github_pull",
		title: "Read a GitHub pull request",
		description:
			"Read one pull request: its description, the files it changes with their diff stats, the review comments, and the reviews left on it.",
		inputSchema: {
			type: "object",
			properties: {
				repo: repoProperty,
				number: { type: "integer", description: "The pull request number." },
				files: { type: "integer", description: "How many changed files to list, 1-100. Defaults to 30." },
			},
			required: ["repo", "number"],
			additionalProperties: false,
		},
		run: async (api, args) => {
			const repo = requireRepo(args.repo);
			const number = requireNumber(args.number, "number");
			const pull = await api.request<IssueLike & { body?: unknown; merged?: unknown; additions?: unknown; deletions?: unknown; changed_files?: unknown; mergeable_state?: unknown }>(
				"GET",
				`/repos/${repo}/pulls/${number}`,
			);
			const limit = Math.min(Math.max(numberArg(args.files, 30), 1), 100);
			const files = await api.request<{ filename?: unknown; status?: unknown; additions?: unknown; deletions?: unknown }[]>(
				"GET",
				`/repos/${repo}/pulls/${number}/files?per_page=${limit}`,
			);
			const comments = await api.request<{ user?: { login?: unknown }; created_at?: unknown; body?: unknown; path?: unknown }[]>(
				"GET",
				`/repos/${repo}/pulls/${number}/comments?per_page=50`,
			);
			const reviews = await api.request<{ user?: { login?: unknown }; state?: unknown; submitted_at?: unknown; body?: unknown }[]>(
				"GET",
				`/repos/${repo}/pulls/${number}/reviews?per_page=50`,
			);

			const parts = [
				header(pull),
				`merged: ${pull.merged === true}  ${pull.additions ?? "?"}+ ${pull.deletions ?? "?"}-  ${pull.changed_files ?? "?"} files`,
				"",
				clip(String(pull.body ?? "(no description)")),
			];
			if (Array.isArray(files) && files.length) {
				parts.push("", `${files.length} changed file(s):`, ...files.map((file) => `${file.status} ${file.filename} (+${file.additions ?? 0}/-${file.deletions ?? 0})`));
			}
			if (Array.isArray(reviews) && reviews.length) {
				parts.push("", `${reviews.length} review(s):`, ...reviews.map((review) => `${review.state} by ${review.user?.login ?? "?"} at ${review.submitted_at ?? "?"}${review.body ? ` — ${clip(String(review.body), 300)}` : ""}`));
			}
			if (Array.isArray(comments) && comments.length) {
				parts.push("", `${comments.length} review comment(s):`, ...comments.map((comment) => `${comment.path ?? ""} ${commentLine(comment)}`));
			}
			return parts.filter(Boolean).join("\n");
		},
	},
	{
		name: "github_create_pull",
		title: "Create a GitHub pull request",
		description:
			"Open a pull request from a branch that already exists on the remote. The branch must have been pushed; this does not create commits.",
		inputSchema: {
			type: "object",
			properties: {
				repo: repoProperty,
				title: { type: "string", description: "The pull request title." },
				head: { type: "string", description: "The branch with the changes, or `owner:branch` for a fork." },
				base: { type: "string", description: "The branch to merge into. Defaults to the repository's default branch." },
				body: { type: "string", description: "The description, in Markdown." },
				draft: { type: "boolean", description: "Open it as a draft." },
			},
			required: ["repo", "title", "head"],
			additionalProperties: false,
		},
		run: async (api, args) => {
			const repo = requireRepo(args.repo);
			const title = stringArg(args.title);
			const head = stringArg(args.head);
			if (!title || !head) throw new Error("title and head are required");
			const created = await api.request<{ number?: unknown; html_url?: unknown }>("POST", `/repos/${repo}/pulls`, {
				title,
				head,
				...(stringArg(args.base) ? { base: stringArg(args.base)! } : {}),
				...(stringArg(args.body) ? { body: stringArg(args.body)! } : {}),
				...(boolArg(args.draft) ? { draft: true } : {}),
			});
			return `Opened pull request #${created?.number} in ${repo}: ${created?.html_url ?? ""}`;
		},
	},
	{
		name: "github_review",
		title: "Review a GitHub pull request",
		description:
			"Submit a review on a pull request: approve it, request changes, or leave a comment. Use `comment` when you have read it but are not the right person to approve.",
		inputSchema: {
			type: "object",
			properties: {
				repo: repoProperty,
				number: { type: "integer", description: "The pull request number." },
				event: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"], description: "Which verdict to give." },
				body: { type: "string", description: "What you want to say, in Markdown. Required unless approving." },
			},
			required: ["repo", "number", "event"],
			additionalProperties: false,
		},
		run: async (api, args) => {
			const repo = requireRepo(args.repo);
			const number = requireNumber(args.number, "number");
			const event = stringArg(args.event)?.toUpperCase();
			if (event !== "APPROVE" && event !== "REQUEST_CHANGES" && event !== "COMMENT") {
				throw new Error('event must be "APPROVE", "REQUEST_CHANGES", or "COMMENT"');
			}
			const body = stringArg(args.body);
			if (event !== "APPROVE" && !body) throw new Error("body is required unless approving");
			const review = await api.request<{ state?: unknown; html_url?: unknown }>("POST", `/repos/${repo}/pulls/${number}/reviews`, {
				event,
				...(body ? { body } : {}),
			});
			return `Reviewed #${number} as ${review?.state ?? event}: ${review?.html_url ?? ""}`;
		},
	},
	{
		name: "github_ci",
		title: "Read GitHub Actions runs",
		description:
			"List a repository's recent workflow runs, optionally for one branch. Use it to see whether a branch is green before opening or merging a pull request.",
		inputSchema: {
			type: "object",
			properties: {
				repo: repoProperty,
				branch: { type: "string", description: "Only runs for this branch." },
				limit: { type: "integer", description: "How many runs, 1-100. Defaults to 20." },
			},
			required: ["repo"],
			additionalProperties: false,
		},
		run: async (api, args) => {
			const repo = requireRepo(args.repo);
			const query = new URLSearchParams({ per_page: String(Math.min(Math.max(numberArg(args.limit, 20), 1), 100)) });
			if (stringArg(args.branch)) query.set("branch", stringArg(args.branch)!);
			const found = await api.request<{ workflow_runs?: { name?: unknown; status?: unknown; conclusion?: unknown; head_branch?: unknown; created_at?: unknown; html_url?: unknown }[] }>(
				"GET",
				`/repos/${repo}/actions/runs?${query}`,
			);
			const runs = Array.isArray(found?.workflow_runs) ? found.workflow_runs : [];
			if (!runs.length) return `No workflow runs in ${repo}${stringArg(args.branch) ? ` for ${stringArg(args.branch)}` : ""}.`;
			return runs
				.map((run) => `${run.conclusion ?? run.status ?? "?"} — ${run.name} on ${run.head_branch} at ${run.created_at ?? "?"} (${run.html_url ?? ""})`)
				.join("\n");
		},
	},
];

/** The tool with this name, for a caller that has to route a call. */
export function githubTool(name: string): GitHubTool | undefined {
	return GITHUB_TOOLS.find((tool) => tool.name === name);
}

/** Build a credential from what a user connected, or nothing when they have not. */
export function credentialFor(
	connection: { kind: "pat" | "app"; token?: string; installationId?: string } | undefined,
	app: GitHubConfig | undefined,
): GitHubCredential | undefined {
	if (!connection) return undefined;
	if (connection.kind === "pat") return connection.token ? { kind: "pat", token: connection.token } : undefined;
	if (!connection.installationId || !app) return undefined;
	return { kind: "app", appId: app.appId, privateKey: app.privateKey, installationId: connection.installationId };
}
