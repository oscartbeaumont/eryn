/**
 * The public page at the Worker's origin.
 *
 * Eryn is a Discord bot, so this page only has one job: explain that and send
 * an admin to the install flow. Everything else happens in Discord.
 */

import { CLIENT_ID } from "./config";

/**
 * View Audit Log (so the install DM can find who added the bot), View Channels,
 * Send Messages, Read Message History, Create Public Threads, and Send Messages
 * in Threads.
 */
const BOT_PERMISSIONS =
	(1n << 7n) | (1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 35n) | (1n << 38n);

function installUrl(): string {
	const params = new URLSearchParams({
		client_id: CLIENT_ID,
		scope: "bot applications.commands",
		permissions: BOT_PERMISSIONS.toString(),
	});
	return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

export function landingPage(): Response {
	return new Response(
		`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>eryn — an OpenCode agent for Discord</title>
<meta name="description" content="Mention @eryn in Discord and it opens a thread, runs the request through an OpenCode agent, and streams the reply.">
<meta name="color-scheme" content="dark">
<style>
:root { color-scheme: dark; --bg: #0b0b0c; --fg: #ededed; --muted: #a1a1aa; --line: #27272a; }
* { box-sizing: border-box; }
body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--fg);
       font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 44rem; margin: 0 auto; padding: 16vh 1.5rem 4rem; }
.kicker { margin: 0 0 1.25rem; color: var(--muted); font: 11px/1.4 ui-monospace, monospace;
          letter-spacing: 0.14em; text-transform: uppercase; }
h1 { margin: 0 0 1.5rem; font-size: clamp(4rem, 14vw, 8rem); line-height: 0.9; letter-spacing: -0.05em; }
p { margin: 0 0 1rem; color: var(--muted); max-width: 60ch; }
strong { color: var(--fg); font-weight: 600; }
.actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin: 2rem 0 3rem; }
a { color: inherit; }
.button { display: inline-block; padding: 0.7rem 1.1rem; border: 1px solid var(--fg); border-radius: 2px;
          background: var(--fg); color: var(--bg); font-weight: 600; text-decoration: none; }
dl { display: grid; gap: 1rem; margin: 0; padding-top: 2rem; border-top: 1px solid var(--line); }
footer { max-width: 44rem; margin: 0 auto; padding: 0 1.5rem 4rem; color: var(--muted); font-size: 0.9rem; }
footer a { color: var(--muted); margin-right: 1rem; }
dt { margin: 0 0 0.2rem; font: 11px/1.4 ui-monospace, monospace; letter-spacing: 0.12em;
     text-transform: uppercase; color: var(--muted); }
dd { margin: 0; color: var(--muted); }
code { color: var(--fg); font: 0.9em/1.4 ui-monospace, monospace; }
</style>
</head>
<body>
<main>
<p class="kicker">An OpenCode agent for Discord</p>
<h1>eryn</h1>
<p>Mention <strong>@eryn</strong> in a server and it opens a thread, runs the request through an OpenCode agent, and streams the reply. Reply in the thread and it keeps going in the same session.</p>
<p>Every server brings its own inference provider and model, set up entirely with slash commands. Nothing is billed to the operator.</p>
<div class="actions">
<a class="button" href="${installUrl()}" rel="noreferrer">Add to Discord</a>
</div>
<dl>
<div><dt>Setup</dt><dd>Add Eryn, then run <code>/eryn setup</code> to connect a provider and choose a model.</dd></div>
<div><dt>Tools</dt><dd>Link any external MCP server from <code>/eryn setup</code>.</dd></div>
</dl>
</main>
<footer>
<a href="/terms">Terms of Service</a>
<a href="/privacy">Privacy Policy</a>
<a href="mailto:oscar@otbeaumont.me">Contact</a>
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
