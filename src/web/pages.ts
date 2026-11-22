/**
 * The browser app.
 *
 * Server-rendered HTML with ordinary form posts. There is no client bundle to
 * keep in sync and no state to hydrate: an action is a POST, and the answer is
 * a redirect to the page that shows the result.
 */

const CSS = `
:root { color-scheme: dark; --bg:#08080a; --panel:#0d0d10; --line:#222227; --ink:#f4f4f5; --muted:#a1a1aa; --faint:#71717a; --accent:#f4f4f5; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
a { color:inherit; }
header.top { border-bottom:1px solid var(--line); }
.wrap { max-width:64rem; margin:0 auto; padding:0 1.25rem; }
.row { display:flex; align-items:center; justify-content:space-between; gap:1rem; }
h1 { font-size:1.6rem; letter-spacing:-.03em; margin:0; }
h2 { font-size:1.05rem; letter-spacing:-.01em; margin:0 0 .75rem; }
p.lead { color:var(--muted); margin:.4rem 0 0; }
.card { background:var(--panel); border:1px solid var(--line); border-radius:.6rem; padding:1.1rem 1.15rem; margin-top:1rem; }
.grid { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(20rem,1fr)); }
label { display:block; font-size:.78rem; text-transform:uppercase; letter-spacing:.08em; color:var(--faint); margin:.7rem 0 .3rem; }
input,select,textarea { width:100%; background:#111116; color:var(--ink); border:1px solid var(--line); border-radius:.45rem; padding:.55rem .65rem; font:inherit; }
textarea { min-height:9rem; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.82rem; }
button { margin-top:.9rem; background:var(--accent); color:#08080a; border:0; border-radius:.45rem; padding:.55rem .85rem; font-weight:600; cursor:pointer; }
button.ghost { background:transparent; color:var(--ink); border:1px solid var(--line); }
ul.items { list-style:none; padding:0; margin:.5rem 0 0; }
ul.items li { display:flex; align-items:center; justify-content:space-between; gap:1rem; padding:.55rem 0; border-top:1px solid var(--line); }
ul.items li:first-child { border-top:0; }
code,.mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.82rem; }
.muted { color:var(--muted); } .faint { color:var(--faint); font-size:.85rem; }
.pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:.1rem .5rem; font-size:.72rem; color:var(--muted); }
.error { border:1px solid #7f1d1d; background:#1f0b0d; color:#fecaca; border-radius:.5rem; padding:.7rem .8rem; margin-top:1rem; }
.ok { border:1px solid #14532d; background:#0b1f12; color:#bbf7d0; border-radius:.5rem; padding:.7rem .8rem; margin-top:1rem; }
form.inline { display:inline; }
footer { color:var(--faint); padding:2.5rem 0; font-size:.82rem; }
@media (max-width:640px){ .row{flex-direction:column; align-items:flex-start;} }
`;

export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export interface PageOptions {
	readonly title: string;
	readonly body: string;
}

export function page(options: PageOptions): string {
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		'<meta name="color-scheme" content="dark">',
		'<meta name="theme-color" content="#08080a">',
		'<link rel="icon" href="/favicon.ico">',
		"<title>" + escapeHtml(options.title) + " · Eryn</title>",
		"<style>" + CSS + "</style>",
		"</head>",
		"<body>",
		options.body,
		"</body>",
		"</html>",
	].join("\n");
}

export function html(value: string, status = 200): Response {
	return new Response(value, {
		status,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"referrer-policy": "same-origin",
		},
	});
}

export function topBar(input: { email?: string; back?: string }): string {
	const who = input.email ?? "";
	const back = input.back ? '<a href="' + escapeHtml(input.back) + '">← Back</a>' : "";

	return [
		'<header class="top"><div class="wrap row" style="padding-top:.9rem;padding-bottom:.9rem">',
		'<div class="row" style="gap:.9rem"><strong>eryn</strong>' + back + "</div>",
		'<div class="row" style="gap:.9rem">',
		who ? '<span class="faint">' + escapeHtml(who) + "</span>" : "",
		who
			? '<form method="post" action="/logout" class="inline"><button class="ghost" type="submit">Sign out</button></form>'
			: '<a class="faint" href="/login">Sign in</a>',
		"</div></div></header>",
	].join("");
}

export function errorBox(message: string | undefined): string {
	return message ? '<div class="error">' + escapeHtml(message) + "</div>" : "";
}

export function okBox(message: string | undefined): string {
	return message ? '<div class="ok">' + escapeHtml(message) + "</div>" : "";
}

export function loginPage(input: { error?: string; sent?: boolean; email?: string }): Response {
	const body = [
		topBar({}),
		'<main class="wrap" style="padding-top:2.5rem;max-width:28rem">',
		"<h1>Sign in</h1>",
		'<p class="lead">We send a six-digit code to your email. No password.</p>',
		errorBox(input.error),
		input.sent ? okBox("A code is on its way.") : "",
		'<div class="card">',
		input.sent
			? [
					'<form method="post" action="/verify">',
					'<label for="email">Email</label>',
					'<input id="email" name="email" type="email" required autocomplete="email" value="' +
						escapeHtml(input.email ?? "") +
						'">',
					'<label for="code">Code</label>',
					'<input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="one-time-code">',
					'<button type="submit">Sign in</button>',
					"</form>",
				].join("")
			: [
					'<form method="post" action="/login">',
					'<label for="email">Email</label>',
					'<input id="email" name="email" type="email" required autocomplete="email">',
					'<button type="submit">Send code</button>',
					"</form>",
				].join(""),
		"</div></main>",
	].join("");

	return html(page({ title: "Sign in", body }));
}

export interface ServerSummary {
	readonly id: string;
	readonly name: string;
}

export function dashboardPage(input: {
	readonly email: string;
	readonly servers: readonly ServerSummary[];
	readonly error?: string;
}): Response {
	const list = input.servers.length
		? '<ul class="items">' +
			input.servers
				.map(
					(server) =>
						'<li><a href="/app/servers/' +
						escapeHtml(server.id) +
						'">' +
						escapeHtml(server.name) +
						'</a><span class="pill mono">' +
						escapeHtml(server.id) +
						"</span></li>",
				)
				.join("") +
			"</ul>"
		: '<p class="muted">No servers yet. Create one below.</p>';

	const body = [
		topBar({ email: input.email }),
		'<main class="wrap" style="padding-top:2rem">',
		"<h1>Servers</h1>",
		'<p class="lead">A server is one agent, its files, and the conversations it can reach.</p>',
		errorBox(input.error),
		'<div class="grid">',
		'<section class="card"><h2>Your servers</h2>' + list + "</section>",
		'<section class="card"><h2>New server</h2>',
		'<form method="post" action="/app/servers">',
		'<label for="name">Name</label>',
		'<input id="name" name="name" placeholder="Work" required maxlength="80">',
		'<button type="submit">Create server</button>',
		"</form></section>",
		"</div></main>",
		'<footer class="wrap">Eryn · <a href="/">Home</a></footer>',
	].join("");

	return html(page({ title: "Servers", body }));
}
