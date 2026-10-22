/**
 * A minimal GitHub App client.
 *
 * Authenticates as the App (RS256 JWT signed with the App's private key), mints
 * short-lived installation tokens, and exposes just the REST calls the agent's
 * GitHub tools need: issues, branches, commits, pull requests, and a tarball
 * download used to "clone" a repository into the workspace.
 *
 * No personal access token is involved and nothing long-lived is stored beyond
 * the installation id.
 */

import { base64url } from "./crypto";
import { base64ToBytes } from "./opencode/bytes";

const API = "https://api.github.com";
const JSON_HEADERS = {
	accept: "application/vnd.github+json",
	"x-github-api-version": "2022-11-28",
	"user-agent": "eryn",
};

export interface GitHubConfig {
	readonly appId: string;
	readonly privateKey: string;
	readonly installationId: string;
}

export interface CreatedPullRequest {
	readonly number: number;
	readonly url: string;
}

function pemToDer(pem: string): Uint8Array {
	const base64 = pem
		.replace(/-----BEGIN [^-]+-----/g, "")
		.replace(/-----END [^-]+-----/g, "")
		.replace(/\s+/g, "");
	return base64ToBytes(base64);
}

/**
 * A JWT for the App itself, which is what mints an installation token.
 *
 * Exported because the MCP tools authenticate as the same App when a user
 * chooses it over a personal token; the agent's own client is unchanged.
 */
export async function appJwt(appId: string, privateKey: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"pkcs8",
		pemToDer(privateKey),
		{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
		false,
		["sign"],
	);
	const now = Math.floor(Date.now() / 1_000);
	const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
	const signingInput = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: appId })}`;
	const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput));
	return `${signingInput}.${base64url(new Uint8Array(signature))}`;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Minimal ustar reader: enough for GitHub's tarballs. */
function extractTar(bytes: Uint8Array): Array<{ path: string; data: Uint8Array }> {
	const decoder = new TextDecoder();
	const field = (start: number, length: number) =>
		decoder
			.decode(bytes.subarray(start, start + length))
			.replace(/\0.*$/s, "")
			.trim();
	const files: Array<{ path: string; data: Uint8Array }> = [];
	let offset = 0;
	while (offset + 512 <= bytes.length) {
		const name = field(offset, 100);
		if (!name) break;
		const size = Number.parseInt(field(offset + 124, 12) || "0", 8) || 0;
		const type = field(offset + 156, 1);
		const prefix = field(offset + 345, 155);
		const full = prefix ? `${prefix}/${name}` : name;
		const dataStart = offset + 512;
		if (type === "" || type === "0") {
			files.push({ path: full, data: bytes.subarray(dataStart, dataStart + size) });
		}
		offset = dataStart + Math.ceil(size / 512) * 512;
	}
	return files;
}

/** Drop GitHub's leading `owner-repo-sha/` directory from a tarball path. */
function stripTopLevel(path: string): string {
	const index = path.indexOf("/");
	return index === -1 ? path : path.slice(index + 1);
}

export type GitHub = ReturnType<typeof createGitHub>;

export function createGitHub(config: GitHubConfig) {
	let cached: { token: string; expiresAt: number } | undefined;

	async function token(): Promise<string> {
		if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
		const jwt = await appJwt(config.appId, config.privateKey);
		const response = await fetch(`${API}/app/installations/${config.installationId}/access_tokens`, {
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
			if ((response.status === 429 || response.status >= 500) && attempt < 3) {
				await sleep(500 * (attempt + 1));
				continue;
			}
			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				throw new Error(`GitHub ${method} ${path} failed (HTTP ${response.status}) ${detail.slice(0, 200)}`.trim());
			}
			return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
		}
	}

	return {
		/** Raw bytes of a gzipped tarball for a ref, used to clone into the workspace. */
		async tarball(repo: string, ref?: string): Promise<Array<{ path: string; data: Uint8Array }>> {
			const headers: Record<string, string> = {
				...JSON_HEADERS,
				accept: "application/vnd.github+json",
				authorization: `Bearer ${await token()}`,
			};
			const suffix = ref ? `/${encodeURIComponent(ref)}` : "";
			const response = await fetch(`${API}/repos/${repo}/tarball${suffix}`, { headers });
			if (!response.ok) throw new Error(`GitHub tarball download failed (HTTP ${response.status})`);
			const files = extractTar(await gunzip(new Uint8Array(await response.arrayBuffer())));
			return files.map((file) => ({ path: stripTopLevel(file.path), data: file.data }));
		},

		async listIssues(repo: string, state: string, limit: number): Promise<unknown[]> {
			const issues = await request<Array<{ pull_request?: unknown }>>(
				"GET",
				`/repos/${repo}/issues?state=${state}&per_page=${limit}`,
			);
			return issues.filter((issue) => !issue.pull_request);
		},

		async getIssue(repo: string, number: number): Promise<unknown> {
			const issue = await request<Record<string, unknown>>("GET", `/repos/${repo}/issues/${number}`);
			const comments = await request<unknown[]>("GET", `/repos/${repo}/issues/${number}/comments?per_page=50`);
			return { ...issue, comments };
		},

		async defaultBranch(repo: string): Promise<string> {
			const info = await request<{ default_branch: string }>("GET", `/repos/${repo}`);
			return info.default_branch;
		},

		async branchHead(repo: string, branch: string): Promise<string> {
			const ref = await request<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${branch}`);
			return ref.object.sha;
		},

		async createBranch(repo: string, branch: string, from: string): Promise<void> {
			await request("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: from });
		},

		/** Create a commit of the given files on a branch, creating the branch if needed. */
		async commitFiles(input: {
			repo: string;
			branch: string;
			base: string;
			message: string;
			files: ReadonlyArray<{ path: string; data: Uint8Array }>;
		}): Promise<string> {
			let parent: string;
			let baseTree: string | undefined;
			try {
				parent = await this.branchHead(input.repo, input.branch);
				baseTree = (await request<{ tree: { sha: string } }>("GET", `/repos/${input.repo}/git/commits/${parent}`))
					.tree.sha;
			} catch {
				parent = await this.branchHead(input.repo, input.base);
				baseTree = (await request<{ tree: { sha: string } }>("GET", `/repos/${input.repo}/git/commits/${parent}`))
					.tree.sha;
			}

			const entries = [];
			for (const file of input.files) {
				const blob = await request<{ sha: string }>("POST", `/repos/${input.repo}/git/blobs`, {
					content: base64url(file.data),
					encoding: "base64",
				});
				entries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
			}
			const tree = await request<{ sha: string }>("POST", `/repos/${input.repo}/git/trees`, {
				base_tree: baseTree,
				tree: entries,
			});
			const commit = await request<{ sha: string }>("POST", `/repos/${input.repo}/git/commits`, {
				message: input.message,
				tree: tree.sha,
				parents: [parent],
			});
			await this.setBranch(input.repo, input.branch, commit.sha, parent);
			return commit.sha;
		},

		async setBranch(repo: string, branch: string, sha: string, previous?: string): Promise<void> {
			try {
				await this.branchHead(repo, branch);
				await request("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha, force: true });
			} catch {
				await request("POST", `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
			}
			void previous;
		},

		async createPullRequest(input: {
			repo: string;
			head: string;
			base: string;
			title: string;
			body: string;
			draft: boolean;
		}): Promise<CreatedPullRequest> {
			const result = await request<{ number: number; html_url: string }>("POST", `/repos/${input.repo}/pulls`, {
				head: input.head,
				base: input.base,
				title: input.title,
				body: input.body,
				draft: input.draft,
			});
			return { number: result.number, url: result.html_url };
		},

		async listRepositories(): Promise<Array<{ full_name: string; default_branch: string }>> {
			const result = await request<{ repositories: Array<{ full_name: string; default_branch: string }> }>(
				"GET",
				"/installation/repositories?per_page=100",
			);
			return result.repositories;
		},
	};
}
