/** The server settings page: messaging, inference, MCP, and plugins. */

import { escapeHtml, errorBox, html, okBox, page, topBar } from "./pages.ts";
import type { ServerPolicy } from "../core/policy.ts";

export interface ServerPageData {
	readonly email: string;
	readonly id: string;
	readonly name: string;
	readonly model: string;
	readonly ready: boolean;
	readonly channels: ReadonlyArray<{
		readonly id: string;
		readonly provider: string;
		readonly name?: string;
		readonly enabled: boolean;
	}>;
	messaging: {
		discord?: { configured?: boolean; guildId?: string; guildName?: string };
		imessage?: { configured?: boolean; fromNumber?: string };
		webhookUrl?: string;
	};
	readonly providers: ReadonlyArray<{ integrationID: string; method: string }>;
	readonly links: ReadonlyArray<{ id: string; name: string; url: string }>;
	readonly mcp: ReadonlyArray<{ name: string; status: string; error?: string }>;
	readonly policy: ServerPolicy;
	readonly discordRoles: ReadonlyArray<{ id: string; name: string }>;
	readonly models: ReadonlyArray<{ id: string; name: string }>;
	readonly automations: ReadonlyArray<{
		channelId: string;
		channelName?: string;
		id: string;
		name: string;
		status: string;
		runCount: number;
	}>;
	readonly oauth?: {
		readonly integrationID: string;
		readonly attemptID: string;
		readonly url: string;
		readonly instructions: string;
		readonly mode: string;
	};
	readonly claim?: string;
	readonly plugins: ReadonlyArray<{ id: string; name: string; version: string; enabled: boolean }>;
	readonly guilds: ReadonlyArray<{ id: string; name: string }>;
	readonly guild?: string;
	readonly guildChannels: ReadonlyArray<{ id: string; name: string }>;
	readonly error?: string;
	readonly ok?: string;
}

function section(title: string, content: string): string {
	return '<section class="card"><h2>' + escapeHtml(title) + "</h2>" + content + "</section>";
}

function option(value: string, label: string, selected = false): string {
	return (
		'<option value="' +
		escapeHtml(value) +
		'"' +
		(selected ? " selected" : "") +
		">" +
		escapeHtml(label) +
		"</option>"
	);
}

export function serverPage(data: ServerPageData): Response {
	const base = "/app/servers/" + encodeURIComponent(data.id);
	const discordConfigured = data.messaging.discord?.configured === true;
	const imessageConfigured = data.messaging.imessage?.configured === true;

	const channelRows = data.channels.length
		? '<ul class="items">' +
			data.channels
				.map(
					(channel) =>
						"<li><div><code>" +
						escapeHtml(channel.id) +
						"</code> " +
						'<span class="faint">' +
						escapeHtml(channel.provider) +
						(channel.name ? " · " + escapeHtml(channel.name) : "") +
						'</span></div><form method="post" action="' +
						base +
						'/channels/detach" class="inline"><input type="hidden" name="channelId" value="' +
						escapeHtml(channel.id) +
						'"><button class="ghost" type="submit">Disconnect</button></form></li>',
				)
				.join("") +
			"</ul>"
		: '<p class="muted">No conversations connected.</p>';

	const discord = data.guilds.length
		? section(
				"Discord",
				[
					'<form method="post" action="' + base + '/messaging/discord">',
					'<label for="guildId">Guild</label>',
					'<select id="guildId" name="guildId" required>',
					data.guilds
						.map((guild) =>
							option(guild.id, guild.name, data.messaging.discord?.guildId === guild.id),
						)
						.join(""),
					"</select>",
					'<button type="submit">Save Discord server</button>',
					"</form>",
					discordConfigured
						? '<p class="faint">Connected to guild <code>' +
							escapeHtml(data.messaging.discord?.guildId ?? "") +
							'</code>. <a href="/install?guild=' +
							encodeURIComponent(data.messaging.discord?.guildId ?? "") +
							'">Grant permissions</a></p>'
						: '<p class="faint">Install the bot in a guild, then choose it here. <a href="/install">Add to Discord</a></p>',
				].join(""),
			)
		: '<section class="card"><h2>Discord</h2><p class="muted">Discord is not reachable. Check DISCORD_BOT_TOKEN.</p></section>';

	const discordChannels =
		discordConfigured && data.guildChannels.length
			? '<form method="post" action="' +
				base +
				'/channels/attach">' +
				'<input type="hidden" name="provider" value="discord">' +
				'<input type="hidden" name="containerId" value="' +
				escapeHtml(data.messaging.discord?.guildId ?? "") +
				'">' +
				'<label for="discordChannel">Connect a channel</label>' +
				'<select id="discordChannel" name="channelId" required>' +
				data.guildChannels
					.map((channel) => option(channel.id, "#" + channel.name))
					.join("") +
				"</select>" +
				'<label for="discordChannelName">Name</label>' +
				'<input id="discordChannelName" name="name" placeholder="Optional">' +
				'<button type="submit">Connect channel</button></form>'
			: "";

	const imessage = section(
		"iMessage",
		[
			'<form method="post" action="' + base + '/messaging/imessage">',
			'<label for="apiKeyId">SendBlue API key id</label>',
			'<input id="apiKeyId" name="apiKeyId" required autocomplete="off">',
			'<label for="apiSecret">SendBlue API secret</label>',
			'<input id="apiSecret" name="apiSecret" type="password" required autocomplete="off">',
			'<label for="fromNumber">SendBlue number</label>',
			'<input id="fromNumber" name="fromNumber" placeholder="+15551234567" required>',
			'<label for="ownerNumber">Your number (owner)</label>',
			'<input id="ownerNumber" name="ownerNumber" placeholder="+15557654321" required>',
			'<p class="faint">Only this number acts with owner permissions. Every other number is blocked until you grant it a role.</p>',
			'<button type="submit">Save SendBlue keys</button>',
			"</form>",
			imessageConfigured ? okBox("iMessage is configured.") : "",
			data.messaging.webhookUrl
				? '<p class="faint">Webhook URL</p><code style="word-break:break-all">' +
					escapeHtml(data.messaging.webhookUrl) +
					"</code>"
				: "",
			'<form method="post" action="' + base + '/channels/attach">',
			'<input type="hidden" name="provider" value="imessage">',
			'<label for="phone">Connect a phone number</label>',
			'<input id="phone" name="channelId" placeholder="+15557654321" required>',
			'<label for="phoneName">Name</label>',
			'<input id="phoneName" name="name" placeholder="Optional">',
			'<button type="submit">Connect conversation</button>',
			"</form>",
		].join(""),
	);

	const inference = section(
		"Inference",
		[
			data.providers.length
				? '<ul class="items">' +
					data.providers
						.map(
							(provider) =>
								"<li><code>" +
								escapeHtml(provider.integrationID) +
								'</code><span class="pill">' +
								escapeHtml(provider.method) +
								'</span><form method="post" action="' +
								base +
								'/inference/disconnect" class="inline"><input type="hidden" name="integrationID" value="' +
								escapeHtml(provider.integrationID) +
								'"><button class="ghost" type="submit">Remove</button></form></li>',
						)
						.join("") +
					"</ul>"
				: '<p class="muted">No inference providers connected.</p>',
			'<form method="post" action="' + base + '/inference/oauth/start">',
			'<label for="oauthIntegration">Integration id (OAuth)</label>',
			'<input id="oauthIntegration" name="integrationID" placeholder="opencode" required>',
			'<label for="oauthMethod">Method id</label>',
			'<input id="oauthMethod" name="methodID" placeholder="oauth">',
			'<button type="submit">Connect with OAuth</button>',
			"</form>",
			'<form method="post" action="' + base + '/inference/connect">',
			'<label for="integrationID">Integration id</label>',
			'<input id="integrationID" name="integrationID" placeholder="opencode" required>',
			'<label for="key">API key</label>',
			'<input id="key" name="key" type="password" required autocomplete="off">',
			'<button type="submit">Connect</button>',
			"</form>",
			'<form method="post" action="' + base + '/inference/model">',
			'<label for="model">Model</label>',
			data.models.length
				? '<select id="model" name="model">' +
						data.models
							.map((model) =>
								option(model.id, model.name + " (" + model.id + ")", data.model === model.id),
							)
							.join("") +
						"</select>"
				: '<input id="model" name="model" value="' + escapeHtml(data.model) + '" required>',
			'<button type="submit">Save model</button>',
			"</form>",
		].join(""),
	);

	const profiles = data.policy.profiles;
	const allRoles = [
		...data.discordRoles,
		...data.policy.roles
			.filter((role) => !data.discordRoles.some((discord) => discord.id === role.roleId))
			.map((role) => ({ id: role.roleId, name: role.roleName })),
	];
	const channelOverrideRows = data.channels
		.map((channel) => {
			const override = data.policy.channelOverrides?.[channel.id];
			const value = override ? JSON.stringify(override, null, 2) : "";

			return (
				'<div class="card"><strong>' +
				escapeHtml(channel.name ?? channel.id) +
				'</strong> <span class="faint">' +
				escapeHtml(channel.provider) +
				"</span>" +
				'<label for="channel-' +
				escapeHtml(channel.id) +
				'">Channel overrides (JSON, optional)</label><textarea id="channel-' +
				escapeHtml(channel.id) +
				'" name="channel:' +
				escapeHtml(channel.id) +
				'">' +
				escapeHtml(value) +
				"</textarea></div>"
			);
		})
		.join("");

	const access = section(
		"Access",
		[
			'<p class="muted">The Discord guild owner always has full access. Every other role starts blocked until you map it to a profile. iMessage numbers are trusted.</p>',
			'<form method="post" action="' + base + '/access/save">',
			'<label for="defaultProfile">Default profile for unmapped roles</label>',
			'<select id="defaultProfile" name="defaultProfile">',
			profiles
				.map((profile) => option(profile.id, profile.name, data.policy.defaultProfileId === profile.id))
				.join(""),
			"</select>",
			allRoles.length
				? '<div class="grid" style="margin-top:1rem">' +
					allRoles
						.map((role) => {
							const mapping = data.policy.roles.find((entry) => entry.roleId === role.id);
							const overrides = mapping?.overrides ? JSON.stringify(mapping.overrides, null, 2) : "";

							return (
								'<div class="card"><input type="hidden" name="rolename:' +
								escapeHtml(role.id) +
								'" value="' +
								escapeHtml(role.name) +
								'"><strong>' +
								escapeHtml(role.name) +
								'</strong><label for="role-' +
								escapeHtml(role.id) +
								'">Profile</label><select id="role-' +
								escapeHtml(role.id) +
								'" name="role:' +
								escapeHtml(role.id) +
								'"><option value="">Blocked</option>' +
								profiles
									.map((profile) =>
										option(
											profile.id,
											profile.name,
											mapping ? mapping.profileId === profile.id : false,
										),
									)
									.join("") +
								'</select><label for="overrides-' +
								escapeHtml(role.id) +
								'">Overrides (JSON, optional)</label><textarea id="overrides-' +
								escapeHtml(role.id) +
								'" name="overrides:' +
								escapeHtml(role.id) +
								'" placeholder="{&quot;invoke&quot;: true}">' +
								escapeHtml(overrides) +
								"</textarea></div>"
							);
						})
						.join("") +
					"</div>"
				: '<p class="faint">Connect Discord and install the bot to see its roles.</p>',
			channelOverrideRows,
			'<button type="submit">Save access</button>',
			"</form>",
		].join(""),
	);

	const automationRows = data.automations.length
		? '<ul class="items">' +
			data.automations
				.map(
					(automation) =>
						"<li><div><code>" +
						escapeHtml(automation.name) +
						"</code> " +
						'<span class="faint">' +
						escapeHtml(automation.channelName ?? automation.channelId) +
						" · " +
						escapeHtml(automation.status) +
						"</span></div><div>" +
						'<form method="post" action="' +
						base +
						'/automations/toggle" class="inline"><input type="hidden" name="channelId" value="' +
						escapeHtml(automation.channelId) +
						'"><input type="hidden" name="automationID" value="' +
						escapeHtml(automation.id) +
						'"><input type="hidden" name="action" value="' +
						(automation.status === "paused" ? "resume" : "pause") +
						'"><button class="ghost" type="submit">' +
						(automation.status === "paused" ? "Resume" : "Pause") +
						"</button></form> " +
						'<form method="post" action="' +
						base +
						'/automations/remove" class="inline"><input type="hidden" name="channelId" value="' +
						escapeHtml(automation.channelId) +
						'"><input type="hidden" name="automationID" value="' +
						escapeHtml(automation.id) +
						'"><button class="ghost" type="submit">Delete</button></form>' +
						"</div></li>",
				)
				.join("") +
			"</ul>"
		: '<p class="muted">No automations. Ask Eryn to schedule something in a conversation.</p>';

	const claimCard = data.claim
		? section(
				"Finish in Discord",
				[
					'<p class="muted">Binding a Discord server proves you can manage it, and only Discord can say that. Run this in the server:</p>',
					'<pre><code>/eryn claim ' + escapeHtml(data.claim) + "</code></pre>",
					'<p class="faint">The code expires in fifteen minutes. Anyone with Manage Server can run it.</p>',
				].join(""),
			)
		: "";

	const oauthCard = data.oauth
		? section(
				"Finish provider sign-in",
				[
					'<p class="muted">' + escapeHtml(data.oauth.instructions) + "</p>",
					'<p><a href="' +
						escapeHtml(data.oauth.url) +
						'" target="_blank" rel="noreferrer">Open the provider sign-in page</a></p>',
					'<form method="post" action="' + base + '/inference/oauth/complete">',
					'<input type="hidden" name="integrationID" value="' + escapeHtml(data.oauth.integrationID) + '">',
					'<input type="hidden" name="attemptID" value="' + escapeHtml(data.oauth.attemptID) + '">',
					'<label for="oauthCode">Code (if the provider shows one)</label>',
					'<input id="oauthCode" name="code" autocomplete="one-time-code">',
					'<button type="submit">Finish sign-in</button>',
					"</form>",
					'<form method="post" action="' + base + '/inference/oauth/check" class="inline">',
					'<input type="hidden" name="integrationID" value="' + escapeHtml(data.oauth.integrationID) + '">',
					'<input type="hidden" name="attemptID" value="' + escapeHtml(data.oauth.attemptID) + '">',
					'<button class="ghost" type="submit">Check status</button>',
					"</form>",
				].join(""),
			)
		: "";

	const mcpState = data.mcp.length
		? '<ul class="items">' +
			data.mcp
				.map(
					(server) =>
						"<li><code>" +
						escapeHtml(server.name) +
						'</code><span class="pill">' +
						escapeHtml(server.status) +
						"</span>" +
						(server.error ? '<span class="faint">' + escapeHtml(server.error) + "</span>" : "") +
						"</li>",
				)
				.join("") +
			"</ul>"
		: "";

	const links = section(
		"MCP servers",
		[
			mcpState,
			data.links.length
				? '<ul class="items">' +
					data.links
						.map(
							(link) =>
								"<li><div><code>" +
								escapeHtml(link.name) +
								"</code> " +
								'<span class="faint">' +
								escapeHtml(link.url) +
								'</span></div><form method="post" action="' +
								base +
								'/links/remove" class="inline"><input type="hidden" name="id" value="' +
								escapeHtml(link.id) +
								'"><button class="ghost" type="submit">Remove</button></form>' +
								'<form method="post" action="' +
								base +
								'/links/test" class="inline"><input type="hidden" name="id" value="' +
								escapeHtml(link.id) +
								'"><button class="ghost" type="submit">Test</button></form></li>',
						)
						.join("") +
					"</ul>"
				: '<p class="muted">No MCP servers linked.</p>',
			'<form method="post" action="' + base + '/links/add">',
			'<label for="linkName">Name</label>',
			'<input id="linkName" name="name" placeholder="github" required>',
			'<label for="linkUrl">URL</label>',
			'<input id="linkUrl" name="url" type="url" placeholder="https://example.com/mcp" required>',
			'<label for="linkElicitation">Approvals</label>',
			'<select id="linkElicitation" name="elicitation"><option value="chat">In this chat</option><option value="browser">Browser</option><option value="agent">Agent</option><option value="off">Off</option></select>',
			'<label for="linkToken">Bearer token (optional)</label>',
			'<input id="linkToken" name="token" type="password" autocomplete="off">',
			'<button type="submit">Add server</button>',
			"</form>",
		].join(""),
	);

	const plugins = section(
		"Plugins",
		[
			data.plugins.length
				? '<ul class="items">' +
					data.plugins
						.map(
							(plugin) =>
								"<li><div><code>" +
								escapeHtml(plugin.name) +
								'</code> <span class="pill">' +
								escapeHtml(plugin.version) +
								(plugin.enabled ? "" : " · disabled") +
								'</span></div><div>' +
								'<form method="post" action="' +
								base +
								'/plugins/toggle" class="inline"><input type="hidden" name="id" value="' +
								escapeHtml(plugin.id) +
								'"><input type="hidden" name="enabled" value="' +
								(plugin.enabled ? "false" : "true") +
								'"><button class="ghost" type="submit">' +
								(plugin.enabled ? "Disable" : "Enable") +
								'</button></form> ' +
								'<form method="post" action="' +
								base +
								'/plugins/remove" class="inline"><input type="hidden" name="id" value="' +
								escapeHtml(plugin.id) +
								'"><button class="ghost" type="submit">Remove</button></form>' +
								"</div></li>",
						)
						.join("") +
					"</ul>"
				: '<p class="muted">No custom plugins.</p>',
			'<form method="post" action="' + base + '/plugins/add">',
			'<label for="pluginName">Name</label>',
			'<input id="pluginName" name="name" placeholder="notes" required>',
			'<label for="pluginCode">Module source</label>',
			'<textarea id="pluginCode" name="code" placeholder="export const tools = { ping: async () => &quot;pong&quot; }" required></textarea>',
			'<label><input type="checkbox" name="allowNetwork" value="1" style="width:auto"> Allow outbound network</label>',
			'<button type="submit">Add plugin</button>',
			"</form>",
		].join(""),
	);

	const reset = section(
		"Files",
		'<p class="muted">The server and channel workspaces live in durable storage. Reset removes every file and restores the seeded defaults. Credentials and conversation history are kept.</p>' +
			'<form method="post" action="' +
			base +
			'/reset"><button class="ghost" type="submit">Reset files</button></form>',
	);

	const body = [
		topBar({ email: data.email, back: "/app" }),
		'<main class="wrap" style="padding-top:2rem">',
		'<div class="row"><div><h1>' + escapeHtml(data.name) + "</h1>",
		'<p class="lead"><code>' + escapeHtml(data.id) + "</code> · " + (data.ready ? "agent running" : "agent idle") + "</p></div></div>",
		errorBox(data.error),
		okBox(data.ok),
		'<div class="grid" style="margin-top:1rem">',
		claimCard,
		discord,
		imessage,
		"</div>",
		access,
		section("Conversations", channelRows),
		section("Automations", automationRows),
		discordChannels ? section("Add a Discord channel", discordChannels) : "",
		'<div class="grid" style="margin-top:1rem">',
		oauthCard,
		inference,
		links,
		"</div>",
		plugins,
		reset,
		"</main>",
		'<footer class="wrap">Eryn</footer>',
	].join("");

	return html(page({ title: data.name, body }));
}
