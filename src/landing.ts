/**
 * The public page at the Worker's origin.
 *
 * Eryn is a Discord bot, so this page explains what it does, documents the
 * commands, and sends an admin to the install flow. Everything else happens in
 * Discord.
 */

import { CLIENT_ID } from "./config";
import { BRAND } from "./brand";

/**
 * View Audit Log (so the install message can find who added the bot), View
 * Channels, Send Messages, Read Message History, Create Public Threads, and
 * Send Messages in Threads.
 */
const BOT_PERMISSIONS =
	(1n << 7n) | (1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 35n) | (1n << 38n);

const REPOSITORY = "https://github.com/oscartbeaumont/eryn";

function installUrl(): string {
	const params = new URLSearchParams({
		client_id: CLIENT_ID,
		scope: "bot applications.commands",
		permissions: BOT_PERMISSIONS.toString(),
	});
	return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

const STYLES = `
:root {
	color-scheme: dark;
	--bg: #08080a;
	--panel: #0d0d10;
	--fg: #f4f4f5;
	--muted: #a1a1aa;
	--faint: #71717a;
	--line: #222227;
	--max: 68rem;
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
	margin: 0;
	min-height: 100vh;
	background: var(--bg);
	color: var(--fg);
	font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
	-webkit-font-smoothing: antialiased;
	text-rendering: optimizeLegibility;
}
body::before {
	content: "";
	position: fixed;
	inset: 0 0 auto;
	height: 42rem;
	background: radial-gradient(52rem 28rem at 50% -12%, rgba(255, 255, 255, 0.07), transparent 72%);
	pointer-events: none;
}
a { color: inherit; }
img { display: block; max-width: 100%; }
code, kbd { font: 0.9em/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
code {
	padding: 0.1em 0.35em;
	border: 1px solid var(--line);
	border-radius: 3px;
	background: rgba(255, 255, 255, 0.03);
	color: var(--fg);
	white-space: nowrap;
}

.skip {
	position: absolute;
	left: -999px;
}
.skip:focus {
	left: 1rem;
	top: 1rem;
	z-index: 10;
	padding: 0.6rem 0.9rem;
	border-radius: 4px;
	background: var(--fg);
	color: var(--bg);
}

.wrap { width: min(var(--max), 100% - 3rem); margin-inline: auto; }

.site-header {
	position: relative;
	z-index: 1;
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 1.5rem;
	padding-block: 1.35rem;
	border-bottom: 1px solid var(--line);
}
.brand {
	display: inline-flex;
	align-items: center;
	gap: 0.6rem;
	text-decoration: none;
	font-weight: 600;
	letter-spacing: -0.02em;
}
.brand img { width: 1.65rem; height: 1.65rem; border-radius: 4px; }

.hero { padding-block: clamp(4rem, 12vw, 7.5rem) 0; }
.eyebrow {
	margin: 0 0 1.1rem;
	color: var(--faint);
	font: 0.68rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
	letter-spacing: 0.16em;
	text-transform: uppercase;
}
h1.wordmark {
	margin: 0 0 1.6rem;
	color: var(--fg);
	font-size: clamp(5rem, 19vw, 12rem);
	font-weight: 600;
	line-height: 0.82;
	letter-spacing: -0.065em;
}
@supports (background-clip: text) {
	.wordmark {
		background: linear-gradient(175deg, #fff 18%, #b9b9c2 62%, #8a8a94 100%);
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
}
.lead {
	max-width: 46rem;
	margin: 0 0 1rem;
	font-size: clamp(1.1rem, 2.1vw, 1.35rem);
	line-height: 1.55;
	color: var(--muted);
}
.lead strong { color: var(--fg); font-weight: 600; }
.lead.secondary { font-size: 1rem; color: var(--faint); }

.actions { display: flex; flex-wrap: wrap; gap: 0.7rem; margin: 2.2rem 0 1.6rem; }
.button {
	display: inline-block;
	padding: 0.72rem 1.1rem;
	border: 1px solid var(--line);
	border-radius: 4px;
	background: rgba(255, 255, 255, 0.04);
	color: var(--fg);
	font-size: 0.92rem;
	font-weight: 600;
	text-decoration: none;
}
.button:hover { border-color: #3a3a42; background: rgba(255, 255, 255, 0.07); }
.button.primary { border-color: var(--fg); background: var(--fg); color: var(--bg); }
.button.primary:hover { background: #d9d9de; border-color: #d9d9de; }
a:focus-visible { outline: 2px solid #d4d4d8; outline-offset: 3px; }

.facts {
	display: flex;
	flex-wrap: wrap;
	gap: 0.35rem 1.2rem;
	margin: 0;
	padding: 0;
	list-style: none;
	color: var(--faint);
	font: 0.72rem/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
	letter-spacing: 0.06em;
	text-transform: uppercase;
}
.facts li::before { content: "·"; margin-right: 1.2rem; color: #3f3f46; }
.facts li:first-child::before { content: none; }

.brand-art {
	margin: clamp(2.5rem, 7vw, 4.5rem) 0 0;
	overflow: hidden;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: #000;
}
.brand-art img { width: 100%; height: auto; }

.features {
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 1px;
	margin-block: clamp(3.5rem, 9vw, 6rem) 0;
	border: 1px solid var(--line);
	border-radius: 6px;
	background: var(--line);
	overflow: hidden;
}
.feature { padding: 1.5rem 1.4rem 1.7rem; background: var(--panel); }
.feature h2 { margin: 0 0 0.55rem; font-size: 0.98rem; letter-spacing: -0.01em; }
.feature p { margin: 0; color: var(--muted); font-size: 0.9rem; line-height: 1.6; }

.section { padding-block: clamp(3.5rem, 9vw, 6rem) 0; }
.section-head { max-width: 42rem; margin-bottom: 2rem; }
.section-head h2 {
	margin: 0 0 0.75rem;
	font-size: clamp(1.7rem, 4vw, 2.4rem);
	line-height: 1.15;
	letter-spacing: -0.035em;
}
.section-head p:last-child { margin: 0; color: var(--muted); }

.commands { border-top: 1px solid var(--line); }
.command-list { display: grid; border-top: 1px solid var(--line); }
.command {
	display: grid;
	grid-template-columns: minmax(9rem, 13rem) 1fr auto;
	grid-template-areas: "command description permission";
	align-items: start;
	gap: 1rem 1.5rem;
	padding-block: 1.1rem;
	border-bottom: 1px solid var(--line);
}
.command code { grid-area: command; justify-self: start; font-size: 0.88rem; }
.command p { grid-area: description; margin: 0; color: var(--muted); font-size: 0.92rem; }
.permission {
	grid-area: permission;
	padding-top: 0.2rem;
	color: var(--faint);
	font: 0.66rem/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
	letter-spacing: 0.12em;
	text-transform: uppercase;
	white-space: nowrap;
}

.closing {
	margin-block: clamp(3.5rem, 9vw, 6rem) 0;
	padding: clamp(2rem, 5vw, 3.25rem);
	border: 1px solid var(--line);
	border-radius: 6px;
	background:
		radial-gradient(30rem 14rem at 50% 0%, rgba(255, 255, 255, 0.05), transparent 70%),
		var(--panel);
	text-align: center;
}
.closing h2 { margin: 0 0 0.7rem; font-size: clamp(1.6rem, 3.5vw, 2.2rem); letter-spacing: -0.035em; }
.closing p { max-width: 38rem; margin: 0 auto 1.6rem; color: var(--muted); }

footer {
	margin-top: clamp(3.5rem, 9vw, 6rem);
	border-top: 1px solid var(--line);
}
.footer-inner {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 1rem;
	padding-block: 1.5rem 2.5rem;
	color: var(--faint);
	font-size: 0.85rem;
}
.footer-inner nav { display: flex; flex-wrap: wrap; gap: 1.1rem; }
.footer-inner a { color: var(--muted); text-decoration: none; }
.footer-inner a:hover { color: var(--fg); }

@media (max-width: 760px) {
	.features { grid-template-columns: 1fr; }
	.command { grid-template-columns: 1fr auto; grid-template-areas: "command permission" "description description"; }
}
@media (prefers-reduced-motion: reduce) {
	html { scroll-behavior: auto; }
}
`;

export function landingPage(origin: string): Response {
	const banner = `${origin}${BRAND.banner}`;
	return new Response(
		`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>eryn — your personal agent in Discord</title>
<meta name="description" content="Mention @eryn in Discord and it opens a thread, runs the request through an OpenCode agent, and streams the reply.">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="#08080a">
<link rel="icon" href="${BRAND.favicon}" sizes="any">
<link rel="icon" type="image/png" href="${BRAND.icon}" sizes="64x64">
<link rel="apple-touch-icon" href="${BRAND.appleIcon}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="eryn">
<meta property="og:title" content="eryn — your personal agent in Discord">
<meta property="og:description" content="Mention @eryn in Discord and it opens a thread, runs the request through an OpenCode agent, and streams the reply.">
<meta property="og:url" content="${origin}/">
<meta property="og:image" content="${banner}">
<meta property="og:image:alt" content="The Eryn mark: a brushed silver ring around a stylised E">
<meta property="og:image:width" content="1600">
<meta property="og:image:height" content="564">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${banner}">
<style>${STYLES}</style>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="site-header wrap">
<a class="brand" href="/"><img src="${BRAND.icon}" alt="" width="26" height="26">eryn</a>
</header>
<main id="main" class="wrap">
<section class="hero">
<p class="eyebrow">Your personal agent in Discord</p>
<h1 class="wordmark">eryn</h1>
<p class="lead">Mention <strong>@eryn</strong> in a server and it opens a thread, works the request through an OpenCode agent, and streams the answer back. Reply in the thread and it keeps going in the same session.</p>
<p class="lead secondary">Every server connects its own inference provider and model. The server pays for its own inference; nothing is billed to the operator.</p>
<div class="actions">
<a class="button primary" href="${installUrl()}" rel="noreferrer">Add to Discord</a>
<a class="button" href="${REPOSITORY}">GitHub</a>
</div>
<ul class="facts">
<li>Per-server setup</li>
<li>Bring your own model</li>
<li>Connect with MCPs</li>
</ul>
</section>
<figure class="brand-art">
<img src="${BRAND.banner}" alt="The Eryn mark: a brushed silver ring around a stylised E" width="1600" height="564">
</figure>
<section class="features" aria-label="What Eryn does">
<div class="feature">
<h2>Threads, not tabs</h2>
<p>Each request gets a thread of its own with a persistent session, so follow-ups carry the context instead of starting over.</p>
</div>
<div class="feature">
<h2>Your models, your bill</h2>
<p>Connect your own inference provider and pick the model per server. OpenCode Go comes with the OpenCode Console connection.</p>
</div>
<div class="feature">
<h2>Tools that do the work</h2>
<p>A virtual filesystem, a sandboxed shell, Discord itself, and any external MCP server an admin links.</p>
</div>
</section>
<section id="commands" class="section commands">
<div class="section-head">
<p class="eyebrow">Commands</p>
<h2>Everything is a slash command.</h2>
<p>There is no dashboard. Commands live under <code>/eryn</code>; configuration needs Manage Server, while stopping a run and reading help are open to everyone.</p>
</div>
<div class="command-list">
<div class="command">
<code>/eryn setup</code>
<p>Open the setup menu: connect or remove a provider, choose a model, link and test MCP servers, and see whether the server is ready.</p>
<span class="permission">Manage Server</span>
</div>
<div class="command">
<code>/eryn stop</code>
<p>Stop the run in the current thread. The session stays intact for the next message.</p>
<span class="permission">Everyone</span>
</div>
<div class="command">
<code>/eryn help</code>
<p>Show the commands and point to where setup lives.</p>
<span class="permission">Everyone</span>
</div>
</div>
</section>
<section class="closing">
<h2>Setup happens in Discord.</h2>
<p>Add Eryn, run <code>/eryn setup</code>, connect a provider, and choose a model. Then mention it anywhere.</p>
<a class="button primary" href="${installUrl()}" rel="noreferrer">Add to Discord</a>
</section>
</main>
<footer>
<div class="footer-inner wrap">
<span>Created by <a href="https://otbeaumont.me">Oscar Beaumont</a></span>
<nav>
<a href="/terms">Terms</a>
<a href="/privacy">Privacy</a>
<a href="mailto:oscar@otbeaumont.me">Contact</a>
<a href="${REPOSITORY}">GitHub</a>
</nav>
</div>
</footer>
</body>
</html>`,
		{
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "public, max-age=300",
				"x-content-type-options": "nosniff",
			},
		},
	);
}
