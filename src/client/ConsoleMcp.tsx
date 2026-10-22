import { createSignal, For, Show } from "solid-js";
import { capture } from "./analytics";
import {
	callMcp,
	discordToolAction,
	exchangeMcpCode,
	fetchMcpServers,
	mcpServerAction,
	registerMcpClient,
	startMcpSignIn,
	type McpServer,
	type McpTokens,
} from "./api";
import { session } from "./session";
import { A, buttonClass, Chip, Code, CopyButton, Footer, Header, Kicker, Notice } from "./ui";

/** The endpoint path, kept in step with `MCP_PATH` in `src/mcp/oauth.ts`. */
const MCP_PATH = "/mcp";
const FLOW_KEY = "eryn:mcp:flow";

/** Tools the server exposes today. Discord and GitHub are stubbed out below. */
const TOOLS = [
	{
		name: "random_number",
		group: "Built in",
		description: "One or more uniformly random integers, inclusive of both bounds.",
		enabled: true,
	},
];

/**
 * Integrations that still need an account before their tools can exist.
 *
 * The endpoints are built and reachable; the tools behind them land in a later
 * change, so the row renders greyed out rather than offering a button that would
 * do nothing.
 */
const INTEGRATIONS = [
	{
		name: "GitHub",
		description: "Read issues, open branches, and raise pull requests.",
		link: "Install the GitHub App",
		enabled: false,
	},
];

interface Status {
	kind: "idle" | "busy" | "ok" | "error";
	message: string;
}

interface Flow {
	clientId: string;
	verifier: string;
	redirectUri: string;
	state: string;
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** PKCE, exactly as a native harness does it (RFC 7636, S256). */
async function pkce(): Promise<{ verifier: string; challenge: string }> {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export default function ConsoleMcp() {
	const [status, setStatus] = createSignal<Status>(redirectStatus());
	const [tokens, setTokens] = createSignal<McpTokens>();
	const [discovered, setDiscovered] = createSignal<string[]>();
	const origin = window.location.origin;
	const endpoint = `${origin}${MCP_PATH}`;

	// Completing a flow that started on this page: the authorization server has
	// redirected back with a one-time code.
	const incoming = new URLSearchParams(window.location.search);
	const code = incoming.get("code");
	const state = incoming.get("state");
	if (code && state) void finish(code, state);

	async function start() {
		const redirectUri = `${origin}/console/mcp`;
		setStatus({ kind: "busy", message: "Registering a client…" });
		try {
			const client = await registerMcpClient({ name: "Eryn console", redirectUri });
			const { verifier, challenge } = await pkce();
			const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
			const flow: Flow = { clientId: client.client_id, verifier, redirectUri, state: nonce };
			sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow));
			const params = new URLSearchParams({
				response_type: "code",
				client_id: client.client_id,
				redirect_uri: redirectUri,
				code_challenge: challenge,
				code_challenge_method: "S256",
				scope: "mcp",
				state: nonce,
			});
			window.location.href = `/console/mcp/authorize?${params.toString()}`;
		} catch (error) {
			setStatus({ kind: "error", message: describe(error) });
		}
	}

	async function finish(receivedCode: string, receivedState: string) {
		const raw = sessionStorage.getItem(FLOW_KEY);
		window.history.replaceState(null, "", "/console/mcp");
		if (!raw) {
			setStatus({ kind: "error", message: "This browser did not start that authorization flow." });
			return;
		}
		sessionStorage.removeItem(FLOW_KEY);
		let flow: Flow;
		try {
			flow = JSON.parse(raw) as Flow;
		} catch {
			setStatus({ kind: "error", message: "The stored authorization flow could not be read." });
			return;
		}
		if (flow.state !== receivedState) {
			setStatus({ kind: "error", message: "The authorization state did not match." });
			return;
		}
		setStatus({ kind: "busy", message: "Exchanging the authorization code…" });
		try {
			const granted = await exchangeMcpCode({
				code: receivedCode,
				verifier: flow.verifier,
				redirectUri: flow.redirectUri,
				clientId: flow.clientId,
			});
			setTokens(granted);
			setStatus({ kind: "busy", message: "Calling the MCP endpoint…" });
			const init = await callMcp(
				{
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-06-18",
						capabilities: {},
						clientInfo: { name: "eryn-console", version: "1.0.0" },
					},
				},
				{ token: granted.access_token },
			);
			const sessionId = init.response.headers.get("mcp-session-id") ?? undefined;
			const call = { token: granted.access_token, sessionId, protocolVersion: "2025-06-18" };
			await callMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, call);
			const listed = await callMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }, call);
			const tools = (listed.json as { result?: { tools?: { name?: string }[] } } | undefined)?.result?.tools ?? [];
			setDiscovered(tools.map((tool) => tool.name ?? "?"));
			capture("mcp_client_connected", { tools: tools.length });
			setStatus({ kind: "ok", message: `Connected. The server advertised ${tools.length} tool(s).` });
		} catch (error) {
			setStatus({ kind: "error", message: describe(error) });
		}
	}

	return (
		<>
			<Header account={session()?.account} />
			<main class="flex-1">
				<section class="mx-auto w-[min(820px,92vw)] py-12">
					<Kicker>MCP</Kicker>
					<h1 class="mb-4 text-[clamp(30px,5vw,44px)] font-bold leading-[1.05] tracking-[-0.03em]">
						Eryn as an MCP server
					</h1>
					<p class="mb-3 max-w-[62ch] text-muted">
						Eryn exposes its tools over the Model Context Protocol, so any MCP harness — OpenCode, Claude, Cursor,
						or your own — can use them. The endpoint is protected with OAuth 2.1: a client discovers the
						authorization server, registers itself, and gets a token, all without you pasting anything.
					</p>
					<p class="mb-10 max-w-[62ch] text-muted">
						Eryn's own Discord sessions are already connected through a token it mints locally, so the agent needs no
						setup to use these tools.
					</p>

					<Show when={status().message}>
						<Notice kind={status().kind === "error" ? "error" : "ok"}>{status().message}</Notice>
					</Show>

					<McpServers onNotice={(kind, message) => setStatus({ kind: kind === "error" ? "error" : "ok", message })} />

					<div class="grid gap-4">
						<div class="border border-line bg-surface p-6">
							<div class="mb-4 flex items-center gap-3">
								<span class="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Endpoint</span>
								<span class="ml-auto">
									<Chip on>OAuth 2.1</Chip>
								</span>
							</div>
							<div class="flex flex-wrap items-center gap-3">
								<code class="min-w-0 flex-1 truncate border border-line-strong bg-bg px-3 py-3 font-mono text-sm">
									{endpoint}
								</code>
								<CopyButton value={endpoint} />
							</div>
							<div class="mt-4 flex flex-wrap items-center gap-3">
								<button type="button" class={buttonClass.primary} onClick={() => void start()} disabled={status().kind === "busy"}>
									{status().kind === "busy" ? "Working…" : "Connect this browser"}
								</button>
								<span class="text-xs text-faint">
									Runs the real OAuth flow, then calls <code class="font-mono">tools/list</code> with the token it
									receives.
								</span>
							</div>
							<Show when={discovered()}>
								{(names) => (
									<p class="mt-4 font-mono text-xs text-muted">
										Tools over the wire: {names().length ? names().join(", ") : "none"}
									</p>
								)}
							</Show>
							<Show when={tokens()}>
								{(granted) => (
									<p class="mt-2 font-mono text-[11px] break-all text-faint">
										access_token {granted().access_token.slice(0, 28)}… · expires in {granted().expires_in ?? "?"}s
										{granted().refresh_token ? " · refresh token issued" : ""}
									</p>
								)}
							</Show>
						</div>

						<Code
							title="OpenCode"
							value={`{\n  "mcp": {\n    "servers": {\n      "eryn": {\n        "type": "remote",\n        "url": "${endpoint}"\n      }\n    }\n  }\n}`}
						/>
						<Code
							title="Other harnesses"
							value={`{\n  "mcpServers": {\n    "eryn": {\n      "type": "remote",\n      "url": "${endpoint}"\n    }\n  }\n}`}
						/>
						<p class="text-xs text-faint">
							Point the client at the endpoint and it handles OAuth itself. Nothing needs to be registered by hand.
						</p>
					</div>

					<h2 class="mb-4 mt-12 font-mono text-[15px] font-semibold">Tools</h2>
					<div class="divide-y divide-line border border-line bg-surface">
						<For each={TOOLS}>
							{(tool) => (
								<div class="flex items-start gap-4 px-5 py-4">
									<div class="min-w-0">
										<div class="font-mono text-sm font-semibold">{tool.name}</div>
										<p class="mt-1 text-sm text-muted">{tool.description}</p>
									</div>
									<Chip on={tool.enabled}>{tool.enabled ? "Enabled" : "Coming soon"}</Chip>
								</div>
							)}
						</For>
						<For each={INTEGRATIONS}>
							{(integration) => (
								<div class="flex items-start gap-4 px-5 py-4 opacity-45">
									<div class="min-w-0">
										<div class="font-mono text-sm font-semibold">{integration.name}</div>
										<p class="mt-1 text-sm text-muted">{integration.description}</p>
									</div>
									<Chip on={integration.enabled}>{integration.enabled ? "Enabled" : "Coming soon"}</Chip>
								</div>
							)}
						</For>
					</div>

					<h2 class="mb-4 mt-12 font-mono text-[15px] font-semibold">Connections</h2>
					<p class="mb-4 max-w-[62ch] text-sm text-muted">
						These grant the MCP access to an account, so the tools can act outside this session.
					</p>
					<div class="divide-y divide-line border border-line bg-surface">
						<DiscordConnection
							onNotice={(kind, message) => setStatus({ kind: kind === "error" ? "error" : "ok", message })}
						/>
						<For each={INTEGRATIONS}>
							{(integration) => (
								<div class="flex flex-wrap items-center gap-4 px-5 py-4 opacity-45">
									<div class="min-w-0 flex-1">
										<div class="font-mono text-sm font-semibold">{integration.name}</div>
										<p class="mt-1 text-sm text-muted">{integration.description}</p>
									</div>
									<button type="button" class={`${buttonClass.ghost} cursor-not-allowed`} disabled>
										{integration.link}
									</button>
								</div>
							)}
						</For>
					</div>

					<p class="mt-8 max-w-[62ch] text-xs text-faint">
						Discovery documents: <span class="font-mono">/.well-known/oauth-protected-resource</span> and{" "}
						<span class="font-mono">/.well-known/oauth-authorization-server</span> on this origin.{" "}
						<A href="https://modelcontextprotocol.io/" external class="border-b border-line-strong text-muted">
							About MCP ↗
						</A>
					</p>
				</section>
			</main>
			<Footer />
		</>
	);
}

/**
 * The remote MCP servers this user has connected.
 *
 * They belong to the person rather than to a Discord server, so they are set up
 * once here and follow the user into every server they run Eryn in. A server
 * that wants a sign-in gets one through Eryn, which is the only party that can
 * receive the callback.
 */
function McpServers(props: { onNotice: (kind: "ok" | "error", message: string) => void }) {
	const [servers, setServers] = createSignal<McpServer[]>([]);
	const [loaded, setLoaded] = createSignal(false);
	const [busy, setBusy] = createSignal(false);
	const [name, setName] = createSignal("");
	const [url, setUrl] = createSignal("");
	const [tools, setTools] = createSignal<{ id: string; list: { name: string; description: string }[] }>();

	async function reload() {
		try {
			setServers((await fetchMcpServers()).servers);
		} catch (error) {
			props.onNotice("error", describe(error));
		} finally {
			setLoaded(true);
		}
	}
	void reload();

	async function run(action: "remove" | "enable" | "disable", server: McpServer) {
		setBusy(true);
		try {
			const result = await mcpServerAction({ action, id: server.id });
			props.onNotice("ok", result.message ?? "Done.");
			await reload();
		} catch (error) {
			props.onNotice("error", describe(error));
		} finally {
			setBusy(false);
		}
	}

	async function add(event: SubmitEvent) {
		event.preventDefault();
		if (!url().trim()) return;
		setBusy(true);
		try {
			const result = await mcpServerAction({ action: "add", name: name(), url: url() });
			setName("");
			setUrl("");
			props.onNotice("ok", result.message ?? "Added.");
			await reload();
		} catch (error) {
			props.onNotice("error", describe(error));
		} finally {
			setBusy(false);
		}
	}

	async function signIn(server: McpServer) {
		setBusy(true);
		try {
			const result = await startMcpSignIn(server.id);
			if (!result.url) throw new Error("The sign-in could not be started.");
			window.location.href = result.url;
		} catch (error) {
			props.onNotice("error", describe(error));
			setBusy(false);
		}
	}

	/** Ask the server itself what it offers, rather than trusting a cached list. */
	async function inspect(server: McpServer) {
		setBusy(true);
		try {
			const result = await mcpServerAction({ action: "tools", id: server.id });
			setTools({ id: server.id, list: result.tools ?? [] });
		} catch (error) {
			props.onNotice("error", describe(error));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div class="mb-8 border border-line bg-surface p-6">
			<div class="mb-1 flex items-center gap-3">
				<span class="font-mono text-[11px] uppercase tracking-[0.14em] text-faint">Your MCP servers</span>
			</div>
			<p class="mb-4 max-w-[62ch] text-sm text-muted">
				Add a remote MCP server by URL and Eryn can call its tools — from the Discord agent and from this endpoint,
				so your own harness can drop its copy of the same server.
			</p>

			<Show when={loaded() && servers().length === 0}>
				<p class="mb-4 border border-dashed border-line-strong px-4 py-3.5 text-sm text-muted">
					No servers connected yet. Add one below — for example <code class="font-mono">https://mcp.context7.com/mcp</code>.
				</p>
			</Show>

			<div class="mb-4 divide-y divide-line border border-line-strong">
				<For each={servers()}>
					{(server) => (
						<div class="px-4 py-3.5">
							<div class="flex flex-wrap items-center gap-3">
								<span class="font-mono text-sm text-fg">{server.name}</span>
								<Chip tone={server.enabled ? "ok" : "danger"}>{server.enabled ? "On" : "Off"}</Chip>
								<Show when={server.authorized}>
									<Chip>Signed in</Chip>
								</Show>
								<span class="min-w-0 flex-1 truncate font-mono text-xs text-faint">{server.url}</span>
								<div class="flex flex-wrap gap-2">
									<Show when={!server.authorized}>
										<button type="button" class={buttonClass.small} disabled={busy()} onClick={() => void signIn(server)}>
											Sign in
										</button>
									</Show>
									<button type="button" class={buttonClass.ghost} disabled={busy()} onClick={() => void inspect(server)}>
										Tools
									</button>
									<button
										type="button"
										class={buttonClass.ghost}
										disabled={busy()}
										onClick={() => void run(server.enabled ? "disable" : "enable", server)}
									>
										{server.enabled ? "Disable" : "Enable"}
									</button>
									<button type="button" class={buttonClass.danger} disabled={busy()} onClick={() => void run("remove", server)}>
										Remove
									</button>
								</div>
							</div>
							<Show when={tools()?.id === server.id ? tools() : undefined}>
								{(current) => (
									<div class="mt-3 border-t border-line pt-3">
										<Show
											when={current().list.length > 0}
											fallback={<p class="text-xs text-faint">That server reported no tools.</p>}
										>
											<ul class="flex flex-col gap-1.5">
												<For each={current().list}>
													{(tool) => (
														<li class="text-xs text-muted">
															<span class="font-mono text-fg">{tool.name}</span>
															{tool.description ? ` — ${tool.description}` : ""}
														</li>
													)}
												</For>
											</ul>
										</Show>
									</div>
								)}
							</Show>
						</div>
					)}
				</For>
			</div>

			<form class="flex flex-wrap items-end gap-3" onSubmit={add}>
				<label class="min-w-0 flex-1">
					<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">Name</span>
					<input
						type="text"
						value={name()}
						placeholder="context7"
						spellcheck={false}
						class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
						onInput={(event) => setName(event.currentTarget.value)}
					/>
				</label>
				<label class="min-w-0 flex-[2]">
					<span class="mb-2 block font-mono text-[11px] uppercase tracking-[0.12em] text-faint">URL</span>
					<input
						type="text"
						value={url()}
						placeholder="https://example.com/mcp"
						spellcheck={false}
						class="w-full border border-line-strong bg-bg px-3 py-3 font-mono text-sm text-fg outline-none focus:border-fg"
						onInput={(event) => setUrl(event.currentTarget.value)}
					/>
				</label>
				<button type="submit" class={buttonClass.primary} disabled={busy()}>
					Add
				</button>
			</form>
		</div>
	);
}

/**
 * The Discord tools, and the switch that turns them on.
 *
 * They act as the bot rather than as the account that connects them, so they are
 * as visible as the bot is — every server it has been added to, not one — and
 * connecting is therefore a deliberate act that can be reversed. The agent is
 * told which channel it was invoked in, and these take that id and read around
 * it.
 */
function DiscordConnection(props: { onNotice: (kind: "ok" | "error", message: string) => void }) {
	const [link, setLink] = createSignal<{ id: string; name: string } | null>(null);
	const [loaded, setLoaded] = createSignal(false);
	const [busy, setBusy] = createSignal(false);

	async function reload() {
		try {
			setLink((await fetchMcpServers()).discord ?? null);
		} catch (error) {
			props.onNotice("error", describe(error));
		} finally {
			setLoaded(true);
		}
	}
	void reload();

	async function toggle(action: "connect" | "disconnect") {
		setBusy(true);
		try {
			const result = await discordToolAction(action);
			props.onNotice("ok", result.message ?? "Done.");
			await reload();
		} catch (error) {
			props.onNotice("error", describe(error));
		} finally {
			setBusy(false);
		}
	}

	return (
		<div class="flex flex-wrap items-center gap-4 px-5 py-4">
			<div class="min-w-0 flex-1">
				<div class="flex items-center gap-2">
					<span class="font-mono text-sm font-semibold">Discord</span>
					<Show when={link()}>
						<Chip on>On</Chip>
					</Show>
				</div>
				<p class="mt-1 text-sm text-muted">
					List servers and channels, read a channel's messages with pagination, search a server's history, list
					threads, post a message, and open a thread. The tools act as the bot, so they reach any server the bot is
					in — a connected account is what turns them on, not what scopes them.
				</p>
			</div>
			<Show when={loaded()}>
				<button
					type="button"
					class={link() ? buttonClass.danger : buttonClass.primary}
					disabled={busy()}
					onClick={() => void toggle(link() ? "disconnect" : "connect")}
				>
					{link() ? "Disconnect" : "Connect Discord"}
				</button>
			</Show>
		</div>
	);
}

/** A notice carried in on redirect, from an MCP sign-in callback. */
function redirectStatus(): Status {
	const params = new URLSearchParams(window.location.search);
	const ok = params.get("ok");
	if (ok) return { kind: "ok", message: ok };
	const error = params.get("error");
	if (error) return { kind: "error", message: error };
	return { kind: "idle", message: "" };
}

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
