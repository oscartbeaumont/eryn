/**
 * The "Connect this browser" self-test.
 *
 * It runs the exact OAuth 2.1 flow an external harness runs — dynamic client
 * registration, PKCE, consent, code exchange — and then calls the hosted
 * server's MCP endpoint over the wire, so the console proves the endpoint works
 * rather than trusting a cached list.
 *
 * The flow survives the round trip to the consent screen in `sessionStorage`,
 * and the return leg lands back on `/console`, which finishes it.
 */

import { callMcp, exchangeMcpCode, registerMcpClient } from "./api";

/** Where the authorization server sends the browser back to. */
const REDIRECT_PATH = "/console";
const FLOW_KEY = "eryn:mcp:flow";

interface SelfTestFlow {
	clientId: string;
	verifier: string;
	redirectUri: string;
	state: string;
	serverId: string;
	endpoint: string;
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

/** Register a client, remember the flow, and send the browser to consent. */
export async function startSelfTest(server: { id: string; endpoint: string }): Promise<void> {
	const origin = window.location.origin;
	const redirectUri = `${origin}${REDIRECT_PATH}`;
	const client = await registerMcpClient({ name: "Eryn console", redirectUri });
	const { verifier, challenge } = await pkce();
	const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
	const flow: SelfTestFlow = {
		clientId: client.client_id,
		verifier,
		redirectUri,
		state,
		serverId: server.id,
		endpoint: server.endpoint,
	};
	sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow));
	const params = new URLSearchParams({
		response_type: "code",
		client_id: client.client_id,
		redirect_uri: redirectUri,
		code_challenge: challenge,
		code_challenge_method: "S256",
		scope: "mcp",
		state,
		resource: server.endpoint,
	});
	window.location.href = `/console/authorize?${params.toString()}`;
}

/** Whether this page load is the return leg of a self-test. */
export function hasReturningFlow(): boolean {
	const params = new URLSearchParams(window.location.search);
	return params.has("code") && params.has("state");
}

export interface SelfTestResult {
	ok: boolean;
	message: string;
	/** The server the flow was for, when it could be identified. */
	serverId?: string;
	/** The tool names the endpoint advertised. */
	tools: string[];
}

/** Finish the return leg: exchange the code, then list the endpoint's tools. */
export async function completeSelfTest(): Promise<SelfTestResult> {
	const params = new URLSearchParams(window.location.search);
	const code = params.get("code") ?? "";
	const state = params.get("state") ?? "";
	const error = params.get("error");
	const raw = sessionStorage.getItem(FLOW_KEY);
	sessionStorage.removeItem(FLOW_KEY);
	window.history.replaceState(null, "", REDIRECT_PATH);

	if (error) return { ok: false, message: `The authorization was refused (${error}).`, tools: [] };
	if (!raw) return { ok: false, message: "This browser did not start that authorization flow.", tools: [] };

	let flow: SelfTestFlow;
	try {
		flow = JSON.parse(raw) as SelfTestFlow;
	} catch {
		return { ok: false, message: "The stored authorization flow could not be read.", tools: [] };
	}
	if (flow.state !== state) return { ok: false, message: "The authorization state did not match.", tools: [] };

	const granted = await exchangeMcpCode({
		code,
		verifier: flow.verifier,
		redirectUri: flow.redirectUri,
		clientId: flow.clientId,
	});
	const init = await callMcp(
		flow.endpoint,
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
	await callMcp(flow.endpoint, { jsonrpc: "2.0", method: "notifications/initialized" }, call);
	const listed = await callMcp(flow.endpoint, { jsonrpc: "2.0", id: 2, method: "tools/list" }, call);
	const tools = (listed.json as { result?: { tools?: { name?: string }[] } } | undefined)?.result?.tools ?? [];
	const names = tools.map((tool) => tool.name ?? "?");
	return {
		ok: true,
		message: `Connected. The server advertised ${names.length} tool${names.length === 1 ? "" : "s"}.`,
		serverId: flow.serverId,
		tools: names,
	};
}
