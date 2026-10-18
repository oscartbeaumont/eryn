/**
 * The static landing page served at `/`.
 *
 * It is a single self-contained document: no build step, no client framework,
 * and no external requests. Colours are defined once as custom properties and
 * follow the visitor's light or dark preference.
 */

/** Eryn's public Discord application id (equal to the bot user id). */
const CLIENT_ID = "1561290858668494959";

/** Bot permissions requested on install. */
const PERMISSIONS = [
	1n << 10n, // View Channels
	1n << 11n, // Send Messages
	1n << 16n, // Read Message History
	1n << 34n, // Create Public Threads
	1n << 38n, // Send Messages in Threads
].reduce((all, permission) => all | permission, 0n);

/** Discord OAuth2 install link: invite the bot and let it register commands. */
const INSTALL_URL = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&scope=bot%20applications.commands&permissions=${PERMISSIONS}`;

export function landingPage(): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>eryn — an OpenCode agent for Discord</title>
<meta name="description" content="eryn is an OpenCode coding agent that lives in your Discord. Mention it in a server and it answers in a thread, streaming as it works." />
<meta name="color-scheme" content="dark light" />
<style>
	:root {
		--bg: #0b0d12;
		--bg-2: #11141c;
		--panel: rgba(255, 255, 255, 0.04);
		--border: rgba(255, 255, 255, 0.10);
		--fg: #eef1f7;
		--muted: #9aa3b5;
		--accent: #8b7cff;
		--accent-2: #38d6c4;
		--code-bg: rgba(0, 0, 0, 0.35);
		--shadow: 0 30px 80px -40px rgba(139, 124, 255, 0.55);
	}
	@media (prefers-color-scheme: light) {
		:root {
			--bg: #f7f8fc;
			--bg-2: #ffffff;
			--panel: rgba(17, 20, 28, 0.02);
			--border: rgba(17, 20, 28, 0.10);
			--fg: #171a22;
			--muted: #5b6376;
			--accent: #5a49e8;
			--accent-2: #0f9c8c;
			--code-bg: rgba(17, 20, 28, 0.05);
			--shadow: 0 30px 80px -50px rgba(90, 73, 232, 0.45);
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
		display: flex;
		min-height: 100%;
		flex-direction: column;
	}
	main {
		flex: 1;
		width: min(760px, 92vw);
		margin: 0 auto;
		padding: clamp(56px, 12vh, 140px) 0 64px;
	}
	.badge {
		display: inline-flex;
		align-items: center;
		gap: 8px;
		font-size: 13px;
		letter-spacing: 0.02em;
		color: var(--muted);
		border: 1px solid var(--border);
		background: var(--panel);
		padding: 6px 12px;
		border-radius: 999px;
	}
	.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-2); box-shadow: 0 0 12px var(--accent-2); }
	h1 {
		font-size: clamp(56px, 13vw, 104px);
		line-height: 0.95;
		margin: 22px 0 8px;
		letter-spacing: -0.04em;
		background: linear-gradient(100deg, var(--fg) 20%, var(--accent) 60%, var(--accent-2));
		-webkit-background-clip: text;
		background-clip: text;
		color: transparent;
	}
	.tagline { font-size: clamp(18px, 2.6vw, 24px); margin: 0 0 18px; }
	.lede { color: var(--muted); max-width: 58ch; margin: 0 0 28px; }
	.lede strong { color: var(--fg); font-weight: 600; }
	pre {
		background: var(--code-bg);
		border: 1px solid var(--border);
		border-radius: 14px;
		padding: 16px 18px;
		overflow-x: auto;
		margin: 0 0 28px;
	}
	code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 14px; }
	.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 44px; }
	a.button {
		text-decoration: none;
		font-weight: 600;
		font-size: 15px;
		padding: 11px 20px;
		border-radius: 12px;
		border: 1px solid var(--border);
		transition: transform 0.12s ease, background 0.12s ease, border-color 0.12s ease;
	}
	a.button:hover { transform: translateY(-1px); }
	a.primary { background: linear-gradient(100deg, var(--accent), var(--accent-2)); color: #0b0d12; border-color: transparent; box-shadow: var(--shadow); }
	a.ghost { color: var(--fg); background: var(--panel); }
	ul.features { list-style: none; padding: 0; margin: 0; display: grid; gap: 14px; }
	ul.features li { display: grid; grid-template-columns: 26px 1fr; gap: 12px; color: var(--muted); }
	ul.features b { color: var(--fg); font-weight: 600; }
	.check { color: var(--accent-2); font-weight: 700; }
	footer { width: min(760px, 92vw); margin: 0 auto; padding: 24px 0 40px; color: var(--muted); font-size: 13px; border-top: 1px solid var(--border); }
</style>
</head>
<body>
<main>
	<span class="badge"><span class="dot"></span> OpenCode · Cloudflare Workers · DeepSeek V4.1 Flash</span>
	<h1>eryn</h1>
	<p class="tagline">An OpenCode coding agent that lives in your Discord.</p>
	<p class="lede">Mention <strong>@eryn</strong> in a server and it opens a thread for the request, runs it, and streams the answer as it is written. Reply in the thread and the agent keeps going in the same session — no re-explaining.</p>
	<pre><code>@eryn refactor the parser and add tests for the edge cases</code></pre>
	<div class="actions">
		<a class="button primary" href="${INSTALL_URL}" target="_blank" rel="noreferrer">Install</a>
		<a class="button ghost" href="https://github.com/oscartbeaumont/eryn" target="_blank" rel="noreferrer">View source</a>
		<a class="button ghost" href="/health">Health</a>
	</div>
	<ul class="features">
		<li><span class="check">✓</span><span><b>Threaded sessions.</b> Each thread is one durable OpenCode session, stored in a Durable Object.</span></li>
		<li><span class="check">✓</span><span><b>Live streaming.</b> Replies are edited into Discord as the model writes, spilling into new messages past 2000 characters.</span></li>
		<li><span class="check">✓</span><span><b>Stoppable.</b> Send <code>/stop</code> (or say <code>stop</code>) in a thread to cancel the run.</span></li>
	</ul>
</main>
<footer>OpenCode runs embedded in a Durable Object. Inference via OpenCode Go.</footer>
</body>
</html>`;
}
