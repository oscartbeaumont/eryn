/**
 * Server-rendered HTML for the public site.
 *
 * A single self-contained document per page: no client framework, no external
 * requests. The look is deliberately blocky and terminal-adjacent — sharp
 * corners, hairline borders, a monospace utility face, and a warm near-black
 * palette — so the marketing pages and the Discord agent feel like one product.
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

const SOURCE_URL = "https://github.com/oscartbeaumont/eryn";

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
	*, *::before, *::after { box-sizing: border-box; border-radius: 0; }
	:root {
		color-scheme: dark;
		--bg: #121010;
		--bg-2: #171514;
		--panel: #1b1918;
		--panel-2: #211e1d;
		--line: #2e2a29;
		--line-2: #3d3837;
		--fg: #f1ecec;
		--muted: #a49d9c;
		--faint: #6d6664;
		--invert: #f1ecec;
		--invert-fg: #14110f;
		--ok: #8fd6b0;
		--bad: #e78a8a;
		--warn: #e8c07d;
		--mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
		--sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
	}
	html, body { margin: 0; }
	body {
		background: var(--bg);
		color: var(--fg);
		font: 16px/1.6 var(--sans);
		-webkit-font-smoothing: antialiased;
		display: flex;
		min-height: 100vh;
		flex-direction: column;
	}
	a { color: inherit; }
	.wrap { width: min(1080px, 92vw); margin: 0 auto; }

	header.bar { border-bottom: 1px solid var(--line); }
	header.bar .wrap { display: flex; align-items: center; justify-content: space-between; height: 64px; }
	.brand {
		font: 700 20px/1 var(--mono);
		letter-spacing: -0.02em;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
		gap: 10px;
	}
	.brand::before { content: ""; width: 12px; height: 12px; background: var(--invert); display: inline-block; }
	.bar nav { display: flex; align-items: center; gap: 20px; }
	.navlink {
		font: 500 11px/1 var(--mono);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		text-decoration: none;
		color: var(--muted);
	}
	.navlink:hover { color: var(--fg); }
	.who { font: 500 11px/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint); }

	main { flex: 1; }
	.kicker { font: 500 11px/1 var(--mono); letter-spacing: 0.18em; text-transform: uppercase; color: var(--faint); margin: 0 0 18px; }
	section { padding: 72px 0; border-bottom: 1px solid var(--line); }
	section.tight { padding: 40px 0; }
	section.last { border-bottom: 0; }
	h1.hero { font-size: clamp(56px, 13vw, 128px); line-height: 0.9; letter-spacing: -0.045em; margin: 0 0 20px; font-weight: 700; }
	h1.title { font-size: clamp(30px, 5vw, 44px); line-height: 1.05; letter-spacing: -0.03em; margin: 0 0 14px; font-weight: 700; }
	h2.block { font: 600 15px/1.4 var(--mono); letter-spacing: 0.02em; margin: 0 0 6px; }
	.lede { color: var(--muted); max-width: 62ch; margin: 0 0 30px; }
	.lede strong { color: var(--fg); font-weight: 600; }
	.lede a { color: var(--fg); text-decoration: underline; text-underline-offset: 3px; }
	code { font-family: var(--mono); font-size: 0.92em; background: var(--panel); border: 1px solid var(--line); padding: 1px 5px; }

	.actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
	.btn {
		appearance: none;
		font: 600 11px/1 var(--mono);
		letter-spacing: 0.14em;
		text-transform: uppercase;
		text-decoration: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		padding: 14px 20px;
		border: 1px solid var(--line-2);
		background: transparent;
		color: var(--fg);
		cursor: pointer;
		transition: background .12s ease, color .12s ease, border-color .12s ease;
	}
	.btn:hover { border-color: var(--fg); }
	.btn.primary { background: var(--invert); color: var(--invert-fg); border-color: var(--invert); }
	.btn.primary:hover { background: #fff; border-color: #fff; }
	.btn.small { padding: 10px 14px; }
	.btn.danger { color: var(--bad); border-color: color-mix(in oklab, var(--bad) 55%, var(--line)); }
	.btn.danger:hover { border-color: var(--bad); background: color-mix(in oklab, var(--bad) 12%, transparent); }

	.term { border: 1px solid var(--line); background: var(--bg-2); font-family: var(--mono); }
	.term-head { display: flex; justify-content: space-between; gap: 16px; padding: 11px 16px; border-bottom: 1px solid var(--line); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--faint); }
	.term-body { padding: 18px 16px; display: grid; gap: 12px; font-size: 14px; }
	.term-body p { margin: 0; }
	.term .tag { display: inline-block; min-width: 46px; color: var(--faint); }
	.dim { color: var(--faint); }

	.grid { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--line); }
	.grid > * { padding: 26px 24px; border-right: 1px solid var(--line); }
	.grid > *:last-child { border-right: 0; }
	.grid .num { font: 500 11px/1 var(--mono); letter-spacing: 0.14em; color: var(--faint); display: block; margin-bottom: 16px; }
	.grid p { color: var(--muted); margin: 8px 0 0; font-size: 14px; }

	.cards { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); }
	.card { border: 1px solid var(--line); background: var(--panel); padding: 22px; }
	.card-top { display: flex; align-items: center; gap: 14px; margin-bottom: 18px; }
	.avatar { width: 44px; height: 44px; flex: none; border: 1px solid var(--line-2); background: var(--panel-2); display: grid; place-items: center; font: 600 18px/1 var(--mono); object-fit: cover; }
	.guild-name { font-weight: 600; }
	.meta { font: 500 11px/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--faint); margin-top: 5px; }
	.chip { font: 500 10px/1 var(--mono); letter-spacing: 0.14em; text-transform: uppercase; padding: 5px 9px; border: 1px solid var(--line-2); color: var(--muted); margin-left: auto; white-space: nowrap; }
	.chip.on { color: var(--invert-fg); background: var(--ok); border-color: var(--ok); }
	.field { display: block; margin-bottom: 14px; }
	.field > span { display: block; font: 500 11px/1 var(--mono); letter-spacing: 0.12em; text-transform: uppercase; color: var(--faint); margin-bottom: 8px; }
	input[type=text], input[type=password] {
		width: 100%;
		padding: 12px 13px;
		border: 1px solid var(--line-2);
		background: var(--bg);
		color: var(--fg);
		font: 14px/1.4 var(--mono);
	}
	input:focus { outline: none; border-color: var(--fg); }
	.row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }

	.notice { border: 1px solid var(--line-2); padding: 14px 16px; margin-bottom: 28px; font-size: 14px; }
	.notice.ok { border-color: color-mix(in oklab, var(--ok) 55%, var(--line)); color: var(--ok); }
	.notice.error { border-color: color-mix(in oklab, var(--bad) 55%, var(--line)); color: var(--bad); }
	.empty { color: var(--faint); font-family: var(--mono); font-size: 13px; }

	footer.foot { border-top: 1px solid var(--line); }
	footer.foot .wrap { padding: 26px 0 40px; display: flex; flex-wrap: wrap; gap: 8px 24px; justify-content: space-between; font: 500 11px/1.6 var(--mono); letter-spacing: 0.08em; text-transform: uppercase; color: var(--faint); }
	footer.foot a { color: var(--faint); text-decoration: none; }
	footer.foot a:hover { color: var(--fg); }

	@media (max-width: 780px) {
		.grid { grid-template-columns: 1fr; }
		.grid > * { border-right: 0; border-bottom: 1px solid var(--line); }
		.grid > *:last-child { border-bottom: 0; }
		section { padding: 52px 0; }
	}
`;

function footer(): string {
	return `<footer class="foot"><div class="wrap">
	<span>eryn · OpenCode on Cloudflare Workers</span>
	<span><a href="${SOURCE_URL}">Source</a> · <a href="/setup">Setup</a> · <a href="/health">Health</a></span>
</div></footer>`;
}

function header(account?: { name: string }): string {
	const right = account
		? `<span class="who">${escape(account.name)}</span><a class="navlink" href="/auth/logout">Sign out</a>`
		: `<a class="navlink" href="${SOURCE_URL}">GitHub</a>`;
	return `<header class="bar"><div class="wrap"><a class="brand" href="/">eryn</a><nav>${right}</nav></div></header>`;
}

function document(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(title)}</title>
<meta name="color-scheme" content="dark" />
<meta name="description" content="Eryn is an OpenCode coding agent that lives in your Discord. Bring your own OpenCode Go key; inference is billed to you." />
<style>${STYLE}</style>
</head>
<body>
${body}
${footer()}
</body>
</html>`;
}

function noticeBanner(notice?: { kind: "ok" | "error"; message: string }): string {
	if (!notice) return "";
	return `<div class="notice ${notice.kind}">${escape(notice.message)}</div>`;
}

// --- Landing ------------------------------------------------------------------

export function landingPage(): string {
	return document(
		"eryn — an OpenCode agent for Discord",
		`${header()}
<main>
	<section>
		<div class="wrap">
			<p class="kicker">OpenCode · Cloudflare · Bring your own key</p>
			<h1 class="hero">eryn</h1>
			<p class="lede" style="font-size:18px">An OpenCode coding agent that lives in your Discord. Mention <strong>@eryn</strong> in a server and it opens a thread for the request, runs it through an embedded OpenCode server, and streams the answer back as it is written.</p>
			<p class="lede">Every server runs on <strong>its own OpenCode Go key</strong> — nothing is billed to the operator and no key is shared between servers.</p>
			<div class="actions">
				<a class="btn primary" href="/setup">Set up a server</a>
				<a class="btn" href="${SOURCE_URL}" target="_blank" rel="noreferrer">Source</a>
			</div>
		</div>
	</section>
	<section>
		<div class="wrap">
			<p class="kicker">A session, end to end</p>
			<div class="term">
				<div class="term-head"><span>discord / #engineering</span><span>thread</span></div>
				<div class="term-body">
					<p><span class="tag">you</span>@eryn refactor the parser and add tests for the edge cases</p>
					<p><span class="tag">eryn</span><span class="dim">⠹ Thinking…</span></p>
					<p><span class="tag">eryn</span>Done — extracted a tokenizer, added 12 cases, all green.</p>
					<p><span class="tag">you</span>now split the tokenizer into its own module</p>
					<p><span class="tag">eryn</span><span class="dim">⠼ Working…</span></p>
				</div>
			</div>
		</div>
	</section>
	<section class="last">
		<div class="wrap grid">
			<div><span class="num">[01]</span><h2 class="block">Bring your own key</h2><p>Sign in with Discord, pick a server you administer, and paste an OpenCode Go key. It is encrypted at rest and used only for that server.</p></div>
			<div><span class="num">[02]</span><h2 class="block">Threaded sessions</h2><p>Each thread is one durable OpenCode session stored in a Durable Object, so follow-up messages keep their context.</p></div>
			<div><span class="num">[03]</span><h2 class="block">Live and stoppable</h2><p>Replies stream in as they are written and the requester is pinged when the run finishes. Send <code>/stop</code> to cancel.</p></div>
		</div>
	</section>
</main>`,
	);
}

// --- Setup --------------------------------------------------------------------

export function signInPage(options: { notice?: { kind: "ok" | "error"; message: string } } = {}): string {
	return document(
		"Set up eryn",
		`${header()}
<main>
	<section class="tight">
		<div class="wrap">
			${noticeBanner(options.notice)}
			<p class="kicker">Setup</p>
			<h1 class="title">Connect a server</h1>
			<p class="lede">Sign in with Discord to see the servers you administer, then add an OpenCode Go key to run inference on your own account.</p>
			<div class="actions"><a class="btn primary" href="/auth/discord">Sign in with Discord</a></div>
		</div>
	</section>
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
		return `<img class="avatar" src="https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64" alt="" width="44" height="44" />`;
	}
	return `<span class="avatar">${escape(guild.name.slice(0, 1).toUpperCase())}</span>`;
}

function guildCard(guild: SetupGuild): string {
	const status = guild.configured
		? `<span class="chip on">Configured</span>`
		: guild.installed
			? `<span class="chip">No key</span>`
			: `<span class="chip">Not installed</span>`;
	const meta = guild.configured
		? `<div class="meta">${escape(guild.model ?? DEFAULT_MODEL)}${guild.updatedAt ? ` · ${new Date(guild.updatedAt).toISOString().slice(0, 10)}` : ""}</div>`
		: `<div class="meta">${guild.installed ? "Installed" : "Not installed"}</div>`;

	const install = guild.installed
		? ""
		: `<a class="btn" href="${installUrl(guild.id)}" target="_blank" rel="noreferrer">Add to server</a>`;
	const remove = guild.configured
		? `<form method="post" action="/setup" onsubmit="return confirm('Remove the key for this server?')">
		<input type="hidden" name="action" value="remove" />
		<input type="hidden" name="guild_id" value="${escape(guild.id)}" />
		<button class="btn danger" type="submit">Remove key</button>
	</form>`
		: "";

	return `<div class="card">
	<div class="card-top">${avatar(guild)}<div><div class="guild-name">${escape(guild.name)}</div>${meta}</div>${status}</div>
	<form method="post" action="/setup">
		<input type="hidden" name="action" value="save" />
		<input type="hidden" name="guild_id" value="${escape(guild.id)}" />
		<label class="field"><span>OpenCode Go API key${guild.configured ? " — blank keeps current" : ""}</span>
			<input type="password" name="api_key" placeholder="sk-…" autocomplete="off" spellcheck="false" /></label>
		<label class="field"><span>Model</span>
			<input type="text" name="model" value="${escape(guild.model ?? DEFAULT_MODEL)}" list="models" spellcheck="false" /></label>
		<div class="row">
			<button class="btn primary" type="submit">${guild.configured ? "Update key" : "Save key"}</button>
			${install}
			${remove}
		</div>
	</form>
</div>`;
}

export function setupPage(options: SetupPageOptions): string {
	const cards = options.guilds.length
		? `<div class="cards">${options.guilds.map(guildCard).join("\n")}</div>`
		: `<p class="empty">You do not administer any servers yet. Create one, or ask a server owner to set Eryn up.</p>`;

	return document(
		"Set up eryn",
		`${header(options.account)}
<main>
	<section class="last">
		<div class="wrap">
			${noticeBanner(options.notice)}
			<p class="kicker">Setup</p>
			<h1 class="title">Bring your own inference key</h1>
			<p class="lede">Eryn runs on OpenCode Go. Paste a key from your <a href="https://opencode.ai/console" target="_blank" rel="noreferrer">OpenCode Console</a> for each server. The key is encrypted at rest, never leaves Cloudflare, and is used only for that server's sessions.</p>
			<datalist id="models">${SUGGESTED_MODELS.map((model) => `<option value="${escape(model)}"></option>`).join("")}</datalist>
			${cards}
		</div>
	</section>
</main>`,
	);
}

export function noticeHtml(title: string, message: string): string {
	return document(
		`eryn — ${title}`,
		`${header()}
<main>
	<section class="tight last">
		<div class="wrap">
			<p class="kicker">Notice</p>
			<h1 class="title">${escape(title)}</h1>
			<p class="lede">${escape(message)}</p>
			<div class="actions"><a class="btn primary" href="/setup">Back to setup</a></div>
		</div>
	</section>
</main>`,
	);
}
