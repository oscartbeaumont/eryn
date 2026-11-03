# eryn

Eryn is a Discord bot that runs an [OpenCode](https://opencode.ai) agent inside a
thread. Mention `@eryn` in a server and it opens a thread for the request, works
through it, and streams the reply. Replies in the thread continue the same
session.

The hosted instance is at [eryn.otbeaumont.me](https://eryn.otbeaumont.me).
There is no web dashboard; setup happens in Discord.

## What it does

- Gives each request its own thread, with a persistent session for follow-ups.
- Lets every Discord server connect its own inference provider and choose its
  own model. The server pays for its own inference.
- Gives the agent a virtual filesystem and a sandboxed shell for working through
  a task.
- Links external MCP servers, with OAuth or a bearer token, and keeps their
  tokens fresh.
- Bundles the MCP-events tools so the agent can subscribe to events from any
  linked MCP server.
- Stops a running turn with `/eryn stop`.

## Getting started

1. Add Eryn to a server from the hosted instance.
2. The person who added it gets a DM with a setup button. If that does not
   arrive, run `/eryn setup` in the server.
3. Choose **Connect provider**, connect the provider, then pick a model from the
   list Eryn shows next. OpenCode Go is available through the **OpenCode
   Console** connection; it is not a separate provider.
4. Mention `@eryn` in a channel to start a thread.

Everything is a slash command:

| Command | Purpose |
| --- | --- |
| `/eryn setup` | Setup menu: connect or remove a provider, choose a model, manage MCP servers, and see status |
| `/eryn mcp add` | Add and test an external MCP server |
| `/eryn mcp list` | List linked MCP servers |
| `/eryn mcp test` | Check that linked servers still respond |
| `/eryn mcp remove` | Remove a linked MCP server |
| `/eryn stop` | Stop the current turn |
| `/eryn help` | Show the available commands |

Configuration commands require Manage Server. `/eryn stop` and `/eryn help` are
available to everyone.

## MCP servers

Open the setup menu with `/eryn setup` and choose **MCP servers**, or use
`/eryn mcp add` directly. Both accept an external MCP server's streamable HTTP
URL. Eryn tests it before saving it: it calls `initialize` and `tools/list`,
reports the tools it found, and lets you repeat the test later.

If the server asks for OAuth, Eryn handles the sign-in and stores the access and
refresh tokens with the link. A server that wants a static bearer token can be
added with one instead. Tokens are refreshed as they expire.

Only servers an admin has explicitly linked are available to the agent.

## Limits

- Local stdio MCP servers are not supported; a Worker has no local process.
- External MCP servers must use HTTPS. HTTP loopback is allowed for local
  development.
- An MCP server that only supports an authorization-code flow without dynamic
  client registration must be added with a bearer token.
- The agent's filesystem lives in the guild's Durable Object, not in a real
  machine.
- Eryn works in Discord servers only. DMs are ignored.

## Technical details

Eryn is a single Cloudflare Worker. The Worker serves the landing page, the
health check, the filtered models.dev catalogue used by the embedded agent, and
the external MCP sign-in callback. The bot itself is made of two Durable
Objects:

| Object | Scope | Responsibility |
| --- | --- | --- |
| `BotGatewayV5` | `bot` | Discord gateway socket, slash commands, threads, install DMs |
| `BotSessionV5` | guild id | OpenCode host, provider credentials, MCP links, virtual filesystem |

Each guild's credentials and MCP tokens are sealed with AES-GCM under
`ENCRYPTION_KEY` and stay in that guild's session object.

### Source layout

```
src/
├─ index.ts       Worker entrypoint, landing page, health, MCP callback
├─ bot/           bot gateway object, slash commands, install flow
├─ session/       per-guild Durable Object, OpenCode agent, storage
├─ discord/       Discord REST and gateway socket
├─ mcp/           external MCP client, linking, OAuth
├─ opencode/      embedded host storage, shell, filesystem
└─ plugins/       bundled MCP-events plugin
```

### Development

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm dev          # cf dev
pnpm typecheck    # cf workers types && tsc
pnpm run check    # typecheck + build
```

`pnpm run deploy` deploys the Worker. Use `pnpm run deploy` rather than
`pnpm deploy`, which is pnpm's own deploy command.

A deploy replaces the Worker but not a running Durable Object. The Worker sends
its deploy id to each object; when an object sees a new id it waits for any
in-flight work to finish and restarts on the new code. The health endpoint
reports both ids so you can confirm the deployment has taken effect:

```sh
curl -s https://eryn.otbeaumont.me/health
# {"ok":true,"service":"eryn","deploy":"<worker deploy>","bot":{"connected":true,"deploy":"<bot object deploy>","restart":false}}
```

### Configuration

| Variable | Purpose |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Discord bot token for the socket, commands, and messages |
| `ENCRYPTION_KEY` | Base64url 32-byte key for sealing stored credentials |
| `SESSION_SECRET` | Signs MCP sign-in state and callback links |
| `PUBLIC_ORIGIN` | Origin used in links and OAuth callbacks |
| `DISCORD_KEEPALIVE_SECONDS` | Interval for the socket keepalive alarm |
| `DISCORD_TURN_TIMEOUT_SECONDS` | Maximum length of one agent turn |
