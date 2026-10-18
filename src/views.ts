/**
 * Server-rendered HTML for the public site.
 *
 * Everything is a single self-contained document built from template strings:
 * no client framework, no external requests. Colours are custom properties that
 * follow the visitor's light or dark preference.
 */

import { CLIENT_ID, DEFAULT_MODEL } from "./config";

/** Bot permissions requested on install. */
const PERMISSIONS = [
	1n << 10n, // View Channels
	1n << 11n, // Send Messages
	1n << 16n, // Read Message History
	1n << 34n, // Create Public Threads
	1n << 38n, // Send Messages in Threads
].reduce((all, permission) => all | permission, 0n);

/** Models worth suggesting in the setup form's datalist. */
const SUGGESTED_MODELS = [
	"opencode-go/deepseek-v4.1-flash",
	"opencode-go/deepseek-v4-pro",
	"opencode-go/kimi-k3",
	"opencode-go/glm-5.3",
	"opencode-go/gpt-6-luna",
	"opencode-go/claude-haiku-5-5",
];

/** The OAuth2 install link for the bot, optionally pinned to one guild. */
export function installUrl(guildId?: string): string {
	const params = new URLSearchParams({
		client_id: CLIENT_ID,
		scope: "bot applications.commands",
		permissions: PERMISSIONS.toString(),
	});
	if (guildId) {
		params.set("guild_id", guildId);
		params.set("disable_guild_select", "true");
	}
	return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

function escape(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

const STYLE = `
	:root {
		--bg: #0b0d12; --bg-2: #11141c; --panel: rgba(255,255,255,0.04);
		--border: rgba(255,255,255,0.10); --fg: #eef1f7; --muted: #9aa3b5;
		--accent: #8b7cff; --accent-2: #38d6c4; --danger: #ff6b81; --ok: #38d6c4;
		--code-bg: rgba(0,0,0,0.35); --shadow: 0 30px 80px -40px rgba(139,124,255,0.55);
	}
	@media (prefers-color-scheme: light) {
		:root {
			--bg: #f7f8fc; --bg-2: #ffffff; --panel: rgba(17,20,28,0.02);
			--border: rgba(17,20,28,0.10); --fg: #171a22; --muted: #5b6376;
			--accent: #5a49e8; --accent-2: #0f9c8c; --danger: #d23b52; --ok: #0f9c8c;
			--code-bg: rgba(17,20,28,0.05); --shadow: 0 30px 80px -50px rgba(90,73,232,0.45);
		}
	}
	* { box-sizing: border-box; }
	html, body { height: 100%; }
	body {
		margin: 0;
		background:
			radial-gradient(1200px 600px at 15% -10%, color-mix(in oklab, var(--accent) 22%, transparent), transparent 60%),
			radial-gradient(900px 500px at 110% 10%, color-mix(in oklab, var(--accent-2) 16%, transparent), transparent 55%),
			linear-gradient(180deg, var(--bg), var(--bg-2));
		color: var(--fg);
		font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
		-webkit-font-smoothing: antialiased;
		display: flex; min-height: 100%; flex-direction: column;
	}
	main { flex: 1; width: min(760px, 92vw); margin: 0 auto; padding: clamp(40px, 9vh, 110px) 0 64px; }
	.top { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 34px; }
	.brand { font-weight: 700; letter-spacing: -0.02em; font-size: 20px; text-decoration: none; color: var(--fg); }
	.who { color: var(--muted); font-size: 14px; }
	.who a { color: var(--accent-2); text-decoration: none; margin-left: 12px; }
	.badge { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: var(--muted);
		border: 1px solid var(--border); background: var(--panel); padding: 6px 12px; border-radius: 999px; }
	.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-2); box-shadow: 0 0 12px var(--accent-2); }
	h1 { font-size: clamp(40px, 9vw, 84px); line-height: 0.98; margin: 22px 0 8px; letter-spacing: -0.04em;
		background: linear-gradient(100deg, var(--fg) 20%, var(--accent) 60%, var(--accent-2));
		-webkit-background-clip: text; background-clip: text; color: transparent; }
	h2 { font-size: 24px; margin: 0 0 6px; letter-spacing: -0.02em; }
	h3 { font-size: 18px; margin: 0; }
	.tagline { font-size: clamp(18px, 2.6vw, 24px); margin: 0 0 18px; }
	.lede { color: var(--muted); max-width: 60ch; margin: 0 0 28px; }
	.lede strong { color: var(--fg); font-weight: 600; }
	pre { background: var(--code-bg); border: 1px solid var(--border); border-radius: 14px; padding: 16px 18px; overflow-x: auto; margin: 0 0 28px; }
	code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 14px; }
	.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 44px; }
	.button { text-decoration: none; font-weight: 600; font-size: 15px; padding: 11px 20px; border-radius: 12px;
		border: 1px solid var(--border); transition: transform .12s ease, background .12s ease; cursor: pointer; font-family: inherit; }
	.button:hover { transform: translateY(-1px); }
	.button.primary { background: linear-gradient(100deg, var(--accent), var(--accent-2)); color: #0b0d12; border-color: transparent; box-shadow: var(--shadow); }
	.button.ghost { color: var(--fg); background: var(--panel); }
	.button.danger { color: var(--danger); background: transparent; }
	ul.features { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px; }
	ul.features li { display: grid; grid-template-columns: 26px 1fr; gap: 12px; color: var(--muted); }
	ul.features b { color: var(--fg); font-weight: 600; }
	.check { color: var(--accent-2); font-weight: 700; }
	.notice { border-radius: 12px; padding: 12px 16px; margin-bottom: 24px; border: 1px solid var(--border); background: var(--panel); }
	.notice.ok { border-color: color-mix(in oklab, var(--ok) 50%, var(--border)); }
	.notice.error { border-color: color-mix(in oklab, var(--danger) 55%, var(--border)); color: var(--danger); }
	.card { border: 1px solid var(--border); background: var(--panel); border-radius: 16px; padding: 20px; margin-bottom: 16px; }
	.card-head { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
	.avatar { width: 40px; height: 40px; border-radius: 12px; object-fit: cover; background: var(--code-bg); display: grid; place-items: center; font-weight: 700; }
	.chip { font-size: 12px; padding: 3px 10px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted); }
	.chip.on { color: #0b0d12; background: var(--accent-2); border-color: transparent; }
	.field { display: block; margin-bottom: 12px; }
	.field span { display: block; font-size: 13px; color: var(--muted); margin-bottom: 6px; }
	input[type=text], input[type=password] { width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid var(--border);
		background: var(--bg); color: var(--fg); font: inherit; }
	input:focus { outline: 2px solid color-mix(in oklab, var(--accent) 60%, transparent); outline-offset: 1px; }
	.row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
	.meta { color: var(--muted); font-size: 13px; }
	.empty { color: var(--muted); }
	footer { width: min(760px, 92vw); margin: 0 auto; padding: 24px 0 40px; color: var(--muted); font-size: 13px; border-top: 1px solid var(--border); }
	footer a { color: var(--muted); }
`;

function document(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(title)}</title>
<meta name="color-scheme" content="dark light" />
<meta name="description" content="Eryn is an OpenCode coding agent that lives in your Discord. Bring your own OpenCode Go key; inference is billed to you." />
<style>${STYLE}</style>
</head>
<body>
${body}
<footer>Eryn runs on Cloudflare Workers with an embedded OpenCode server. <a href="https://github.com/oscartbeaumont/eryn">Source</a> · <a href="/health">Health</a></footer>
</body>
</html>`;
}

export function landingPage(): string {
	return document(
		"eryn — an OpenCode agent for Discord",
		`<main>
	<span class="badge"><span class="dot"></span> OpenCode · Cloudflare Workers · bring your own key</span>
	<h1>eryn</h1>
	<p class="tagline">An OpenCode coding agent that lives in your Discord.</p>
	<p class="lede">Mention <strong>@eryn</strong> in a server and it opens a thread for the request, runs it through an embedded OpenCode server, and streams the answer as it is written. Reply in the thread and it keeps going in the same session.</p>
	<p class="lede">Each server runs on <strong>its own OpenCode Go key</strong> — nothing is billed to the operator, and no key is shared between servers.</p>
	<pre><code>@eryn refactor the parser and add tests for the edge cases</code></pre>
	<div class="actions">
		<a class="button primary" href="/setup">Set up a server</a>
		<a class="button ghost" href="${installUrl()}" target="_blank" rel="noreferrer">Install</a>
		<a class="button ghost" href="https://github.com/oscartbeaumont/eryn" target="_blank" rel="noreferrer">View source</a>
	</div>
	<ul class="features">
		<li><span class="check">✓</span><span><b>Bring your own key.</b> Sign in with Discord, pick a server you administer, and paste an OpenCode Go key. It is encrypted at rest and used only for that server.</span></li>
		<li><span class="check">✓</span><span><b>Threaded sessions.</b> Each thread is one durable OpenCode session, stored in a Durable Object.</span></li>
		<li><span class="check">✓</span><span><b>Live and stoppable.</b> Replies stream into Discord as they are written; <code>/stop</code> cancels a run.</span></li>
	</ul>
</main>`,
	);
}

function top(account?: { name: string }): string {
	return `<div class="top">
	<a class="brand" href="/">eryn</a>
	${
		account
			? `<span class="who">Signed in as ${escape(account.name)}<a href="/auth/logout">Sign out</a></span>`
			: `<a class="button ghost" href="/auth/discord">Sign in with Discord</a>`
	}</div>`;
}

export function signInPage(options: { notice?: { kind: "ok" | "error"; message: string } } = {}): string {
	const notice = options.notice
		? `<div class="notice ${options.notice.kind}">${escape(options.notice.message)}</div>`
		: "";
	return document(
		"Set up eryn — sign in",
		`<main>
	${top()}
	${notice}
	<h2>Connect a server</h2>
	<p class="lede">Sign in with Discord to see the servers you administer, then add an OpenCode Go key to run inference on your own account.</p>
	<div class="actions">
		<a class="button primary" href="/auth/discord">Sign in with Discord</a>
		<a class="button ghost" href="/">Back</a>
	</div>
</main>`,
	);
}

export interface SetupGuild {
	id: string;
	name: string;
	icon?: string | null;
	installed: boolean;
	configured: boolean;
	model?: string;
	updatedAt?: number;
}

export interface SetupPageOptions {
	account: { id: string; name: string };
	guilds: SetupGuild[];
	notice?: { kind: "ok" | "error"; message: string };
}

function avatar(guild: SetupGuild): string {
	if (guild.icon) {
		return `<img class="avatar" src="https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64" alt="" width="40" height="40" />`;
	}
	return `<span class="avatar">${escape(guild.name.slice(0, 1).toUpperCase())}</span>`;
}

function guildCard(guild: SetupGuild): string {
	if (!guild.installed) {
		return `<div class="card">
	<div class="card-head">${avatar(guild)}
		<div><h3>${escape(guild.name)}</h3><span class="meta">Eryn is not in this server yet</span></div>
	</div>
	<a class="button primary" href="${installUrl(guild.id)}" target="_blank" rel="noreferrer">Add Eryn to this server</a>
</div>`;
	}

	const status = guild.configured
		? `<span class="chip on">Configured</span>`
		: `<span class="chip">No key yet</span>`;
	const meta = guild.configured
		? `<span class="meta">${escape(guild.model ?? DEFAULT_MODEL)}${guild.updatedAt ? ` · updated ${new Date(guild.updatedAt).toISOString().slice(0, 10)}` : ""}</span>`
		: "";

	const remove = guild.configured
		? `<form method="post" action="/setup" onsubmit="return confirm('Remove the key for this server?')">
		<input type="hidden" name="action" value="remove" />
		<input type="hidden" name="guild_id" value="${escape(guild.id)}" />
		<button class="button danger" type="submit">Remove key</button>
	</form>`
		: "";

	return `<div class="card">
	<div class="card-head">${avatar(guild)}
		<div><h3>${escape(guild.name)}</h3><span class="meta">Installed</span></div>
		<span style="margin-left:auto"></span>${status}
	</div>
	${meta}
	<form method="post" action="/setup">
		<input type="hidden" name="action" value="save" />
		<input type="hidden" name="guild_id" value="${escape(guild.id)}" />
		<label class="field"><span>OpenCode Go API key${guild.configured ? " (leave blank to keep the current key)" : ""}</span>
			<input type="password" name="api_key" placeholder="sk-..." autocomplete="off" spellcheck="false" /></label>
		<label class="field"><span>Model</span>
			<input type="text" name="model" value="${escape(guild.model ?? DEFAULT_MODEL)}" list="models" spellcheck="false" /></label>
		<div class="row">
			<button class="button primary" type="submit">${guild.configured ? "Update key" : "Save key"}</button>
			${remove}
		</div>
	</form>
</div>`;
}

export function setupPage(options: SetupPageOptions): string {
	const notice = options.notice
		? `<div class="notice ${options.notice.kind}">${escape(options.notice.message)}</div>`
		: "";
	const cards = options.guilds.length
		? options.guilds.map(guildCard).join("\n")
		: `<p class="empty">You do not administer any servers yet. Create one, or ask a server owner to set Eryn up.</p>`;

	return document(
		"Set up eryn",
		`<main>
	${top(options.account)}
	${notice}
	<h2>Bring your own inference key</h2>
	<p class="lede">Eryn runs on OpenCode Go. Paste an API key from your <a href="https://opencode.ai/console" target="_blank" rel="noreferrer">OpenCode Console</a> for each server. The key is encrypted at rest, never leaves Cloudflare, and is used only for that server's sessions.</p>
	<datalist id="models">${SUGGESTED_MODELS.map((model) => `<option value="${escape(model)}"></option>`).join("")}</datalist>
	${cards}
</main>`,
	);
}

export function noticeHtml(title: string, message: string): string {
	return document(`eryn — ${title}`, `<main>${top()}
	<h2>${escape(title)}</h2>
	<p class="lede">${escape(message)}</p>
	<div class="actions"><a class="button primary" href="/setup">Back to setup</a></div>
</main>`);
}
