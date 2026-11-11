/**
 * The public legal pages.
 *
 * Eryn has no web app, but Discord asks for Terms of Service and Privacy Policy
 * URLs when an application is listed. These pages are static text served by the
 * Worker; nothing here reads storage or talks to another service.
 */

const CONTACT = "oscar@otbeaumont.me";
const UPDATED = "3 November 2026";

function shell(title: string, body: string): Response {
	return new Response(
		`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · eryn</title>
<meta name="color-scheme" content="dark">
<style>
:root { color-scheme: dark; --bg: #0b0b0c; --fg: #ededed; --muted: #a1a1aa; --line: #27272a; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
       font: 16px/1.7 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 48rem; margin: 0 auto; padding: 3rem 1.5rem 5rem; }
nav { margin-bottom: 3rem; color: var(--muted); font-size: 0.9rem; }
nav a { color: var(--muted); }
h1 { margin: 0 0 0.5rem; font-size: clamp(2rem, 7vw, 3.5rem); line-height: 1; letter-spacing: -0.04em; }
.updated { margin: 0 0 2.5rem; color: var(--muted); font-size: 0.9rem; }
h2 { margin: 2.5rem 0 0.75rem; font-size: 1.15rem; letter-spacing: -0.01em; }
p, li { color: var(--muted); }
p { margin: 0 0 1rem; }
ul { margin: 0 0 1rem; padding-left: 1.25rem; }
li { margin-bottom: 0.4rem; }
a { color: var(--fg); }
footer { margin-top: 4rem; padding-top: 1.5rem; border-top: 1px solid var(--line);
         color: var(--muted); font-size: 0.9rem; }
footer a { color: var(--muted); margin-right: 1rem; }
</style>
</head>
<body>
<main>
<nav><a href="/">← eryn</a></nav>
${body}
<footer>
<a href="/terms">Terms of Service</a>
<a href="/privacy">Privacy Policy</a>
<a href="mailto:${CONTACT}">Contact</a>
</footer>
</main>
</body>
</html>`,
		{
			headers: {
				"content-type": "text/html; charset=utf-8",
				"cache-control": "public, max-age=3600",
				"x-content-type-options": "nosniff",
			},
		},
	);
}

export function termsPage(): Response {
	return shell(
		"Terms of Service",
		`<h1>Terms of Service</h1>
<p class="updated">Last updated: ${UPDATED}</p>

<p>These terms govern your use of Eryn, a Discord bot operated by Oscar Beaumont. By adding Eryn to a Discord server or using it, you agree to these terms. If you do not agree, do not use Eryn.</p>

<h2>The service</h2>
<p>Eryn runs an OpenCode agent in Discord threads. It can answer requests, work with files in a virtual workspace, and use external MCP servers and inference providers configured by the server's administrators. Eryn is not affiliated with Discord, OpenCode, or any model or MCP provider.</p>

<h2>Who can use it</h2>
<p>You must be old enough to use Discord under Discord's terms and old enough to consent to the processing described in our Privacy Policy. If you use Eryn on behalf of a server, you represent that you have authority to configure it and to accept these terms for that server.</p>

<h2>Server configuration and credentials</h2>
<p>Each server chooses its own inference provider, model, and MCP servers. Server administrators are responsible for the accounts and credentials they connect, for the costs those providers charge, and for making sure they have permission to use them. Do not connect credentials you are not authorised to use.</p>

<h2>Acceptable use</h2>
<p>You may not use Eryn to:</p>
<ul>
<li>break the law, infringe someone's rights, or violate Discord's terms or another service's terms;</li>
<li>harass, threaten, or harm another person, or violate their privacy;</li>
<li>distribute malware, attempt unauthorised access, or interfere with Eryn or another service;</li>
<li>send spam or run automated abuse;</li>
<li>make high-impact decisions about people without human review; or</li>
<li>resell or rebrand Eryn without permission.</li>
</ul>
<p>We may suspend or remove access when we believe this section has been violated, when a server creates a security or cost risk, or when required by law.</p>

<h2>AI output</h2>
<p>Eryn uses language models and tools that can be wrong, incomplete, or unsafe. Its output is not professional advice and should be checked before you rely on it. You are responsible for what you do with the output.</p>

<h2>Third-party services</h2>
<p>Eryn depends on Discord, Cloudflare, inference providers chosen by each server, and any MCP servers a server links. Those services have their own terms and privacy practices. We do not control them and are not responsible for their availability, output, or charges.</p>

<h2>Availability and changes</h2>
<p>Eryn is provided as-is. We may change, limit, or stop the service at any time, and we do not promise uninterrupted availability or that any particular model or MCP server will remain available.</p>

<h2>Disclaimers and limitation of liability</h2>
<p>To the extent permitted by law, Eryn is provided without warranties of any kind, and we are not liable for indirect, incidental, special, consequential, or punitive damages, or for lost data, profits, or business, arising from your use of Eryn. Nothing in these terms excludes liability that cannot legally be excluded.</p>

<h2>Changes to these terms</h2>
<p>We may update these terms. The date above will change when we do. If a change is material, we will make reasonable efforts to make it visible in the service. Continuing to use Eryn after a change means you accept the updated terms.</p>

<h2>Contact</h2>
<p>Questions about these terms can be sent to <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>`,
	);
}

export function privacyPage(): Response {
	return shell(
		"Privacy Policy",
		`<h1>Privacy Policy</h1>
<p class="updated">Last updated: ${UPDATED}</p>

<p>This policy explains what Eryn processes, why, and what choices you have. Eryn is operated by Oscar Beaumont and is reachable at <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>

<h2>What we collect</h2>
<ul>
<li><strong>Discord identifiers.</strong> User ids, usernames and display names, server ids and names, channel and thread ids, and the messages or interactions needed to run a request.</li>
<li><strong>Conversation data.</strong> Messages that mention Eryn, messages in threads Eryn owns, attachments you send to it, and the agent's replies and tool activity. This is stored in the server's own Durable Object so a thread can continue.</li>
<li><strong>Server configuration.</strong> The inference provider and model a server chooses, provider API keys or OAuth credentials, and linked MCP server URLs, names, tokens, and OAuth refresh data.</li>
<li><strong>Operational data.</strong> Errors, deploy ids, health information, and request metadata used to run and debug the service. We do not intentionally log message content, but an error report can contain technical details about a failed request.</li>
<li><strong>Usage analytics.</strong> Page views, install-button clicks, and coarse product events such as a turn finishing, its duration, the provider and model involved, and whether setup completed. Server events use a pseudonymous server identifier derived from the Discord server id. They do not include message text, prompts, replies, attachments, usernames, channel names, tool arguments, or the Discord identifiers themselves.</li>
</ul>
<p>The website uses <a href="https://posthog.com" rel="noreferrer">PostHog</a> for page views and install clicks. PostHog is configured without advertising cookies, session recording, autocapture, or IP geolocation; browser storage is used only to keep an anonymous visitor id. Server-side product events are sent to the same project and contain only the coarse values described above.</p>

<h2>How we use it</h2>
<p>We use this data to run Eryn: to answer requests, continue threads, use the provider and MCP servers a server configured, keep credentials working, diagnose failures, prevent abuse, and comply with legal obligations. We do not sell personal data.</p>

<h2>Legal bases</h2>
<p>Where data protection law requires a legal basis, we rely on performing the service you asked for, our legitimate interests in running and securing Eryn, and consent where a server explicitly connects an account or provider. You can withdraw consent by removing the connection or asking us to delete the data.</p>

<h2>What we share</h2>
<ul>
<li><strong>Discord</strong> receives the messages and interactions needed to operate the bot.</li>
<li><strong>Cloudflare</strong> hosts the Worker, Durable Objects, logs, and error aggregation.</li>
<li><strong>PostHog</strong> receives the website and product analytics described under <em>What we collect</em>.</li>
<li><strong>Inference providers</strong> chosen by each server receive the prompts and context needed to answer a request.</li>
<li><strong>MCP servers</strong> linked by a server receive the requests and arguments Eryn sends to their tools.</li>
<li><strong>Model catalogue sources</strong> such as models.dev/opencode.ai are read for model metadata.</li>
</ul>
<p>We may also disclose data when required by law or to protect the service and its users.</p>

<h2>How long we keep it</h2>
<p>Server configuration and conversation history stay in that server's Durable Object so the service keeps working. Provider credentials and MCP links remain until an administrator removes them. Conversation history may outlive the Discord thread it came from. Operational logs are kept for a limited period for debugging and security. When data is no longer needed, we delete it or remove the identifiers that link it to a person.</p>

<h2>Security</h2>
<p>Provider keys and MCP tokens are sealed with AES-GCM under a deployment encryption key and are not sent back to Discord. Data is stored in Cloudflare's Durable Objects and access is limited to operating the service. No system is perfectly secure, so please do not send secrets you would not want processed by the provider and MCP servers you configured.</p>

<h2>Your choices and rights</h2>
<p>Server administrators can remove provider credentials and MCP links from <code>/eryn setup</code>. You can ask us to access, correct, export, or delete data about you, or to object to processing. Send requests to <a href="mailto:${CONTACT}">${CONTACT}</a> with the Discord user or server id involved. You may also have the right to complain to a data protection authority.</p>

<h2>Children</h2>
<p>Eryn is not directed at children under 13 or anyone below the minimum age required by Discord in their country. Do not use Eryn if you are below that age.</p>

<h2>International transfers</h2>
<p>Cloudflare and the providers a server chooses may process data in other countries. They apply their own safeguards for those transfers.</p>

<h2>Changes to this policy</h2>
<p>We may update this policy. The date above will change when we do. Material changes will be made visible in the service where practical, and the updated policy will apply when posted.</p>

<h2>Contact</h2>
<p>Privacy questions and deletion requests can be sent to <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>`,
	);
}
