<p align="center">
  <img src="assets/brand/banner.webp" alt="Eryn — an OpenCode agent for Discord" width="100%">
</p>

# eryn

Eryn is a Discord bot that runs an [OpenCode](https://opencode.ai) agent inside a
thread. Mention `@eryn` in a server and it opens a thread for the request, works
through it, and posts the reply. Replies in the thread continue the same
session. Eryn can also subscribe to a channel, where it answers every message
in the channel itself and keeps one session for that channel.

The hosted instance is at [eryn.otbeaumont.me](https://eryn.otbeaumont.me).
There is no web dashboard; setup happens in Discord.

## What it does

- Gives each request its own thread, with a persistent session for follow-ups.
- Can be subscribed to a channel, where it replies to every message in the
  channel without needing a mention and keeps one session per channel.
- Lets every Discord server connect its own inference provider and choose its
  own model. The server pays for its own inference.
- Gives the agent a virtual filesystem and a sandboxed shell for working through
  a task.
- Links external MCP servers, with OAuth or a bearer token, and keeps their
  tokens fresh.
- Stops a running turn with `/eryn stop`.

## Getting started

1. Add Eryn to a server from the hosted instance.
2. The person who added it gets a DM with a setup button. If that does not
   arrive, run `/eryn setup` in the server.
3. Choose **Connect provider**, connect the provider, then pick a model from the
   list Eryn shows next. OpenCode Go is available through the **OpenCode
   Console** connection; it is not a separate provider.
4. Mention `@eryn` in a channel to start a thread. To make Eryn answer in a
   channel directly, ask it in a thread to join that channel.

Everything is a slash command under `/eryn`. Configuration requires Manage
Server; stopping a run and reading help do not.

| Command | Permission | Purpose |
| --- | --- | --- |
| `/eryn setup` | Manage Server | Open the setup menu: connect or remove a provider, choose a model, manage MCP servers, and see whether the server is ready |
| `/eryn stop` | Everyone | Stop the run in the current thread; the session stays intact for the next message |
| `/eryn help` | Everyone | Show the commands and where setup lives |

### Setup menu

`/eryn setup` is the only configuration surface. Each screen replaces the last
one, so nothing is left behind in the channel.

| Screen | What it does |
| --- | --- |
| **Connect provider** | Pick a provider from the common list, browse the full catalogue, or search by name. Connect with an API key, a browser sign-in, or a device code. |
| **Choose model** | Browse or search the models from a connected provider, or type a `provider/model` reference. Shown once a provider is connected. |
| **Remove provider** | Choose a connected provider and confirm its removal. |
| **MCP servers** | List, link, test, and remove external MCP servers. See [MCP servers](#mcp-servers). |

The install DM opens the same menu, but MCP servers and provider removal stay in
the server because both are guild-wide.

### Agent tools

The model can call these during a turn. They are not typed by users.

| Tool | What it does |
| --- | --- |
| `read` | Read a file from the virtual workspace, with line numbers |
| `write` | Create or overwrite a file in the workspace |
| `edit` | Replace text in a file; fails if the target is absent or ambiguous |
| `list` | List files in the workspace |
| `bash` | Run a sandboxed shell command (`ls`, `cat`, `grep`, `sed`, `find`, `mkdir`, `mv`, `rm`, …) |
| `discord_list_channels` | List channels and active threads, with ids, names, and parent ids |
| `discord_list_threads` | List the server's active threads |
| `discord_read_messages` | Read recent messages from a channel or thread, newest first |
| `discord_send_message` | Send a message, optionally as a reply; this is how the agent answers |
| `discord_create_thread` | Create a public thread, optionally attached to a message |
| `discord_subscribe_message` | Watch a message so Eryn joins the thread created from it |
| `discord_unsubscribe_message` | Stop watching a message for a new thread |
| `discord_archive_thread` | Archive or close a thread, optionally locking it |
| `discord_join_thread` | Join a thread and answer its messages without a mention |
| `discord_leave_thread` | Leave a thread and stop answering it |
| `discord_join_channel` | Subscribe Eryn to a channel and answer every message there |
| `discord_leave_channel` | Unsubscribe Eryn from a channel |
| `discord_react` | Add or remove an emoji reaction |
| `discord_edit_message` | Edit a message the bot is allowed to edit |
| `discord_delete_message` | Delete a message the bot is allowed to delete |
| `discord_pin_message` | Pin or unpin a message |

## MCP servers

Open the setup menu with `/eryn setup` and choose **MCP servers**. Linking
accepts an external MCP server's streamable HTTP URL. Eryn tests it before
saving it: it calls `initialize` and `tools/list`, reports the tools it found,
and lets you repeat the test later.

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
assets/          public images served by Cloudflare static assets
src/
├─ index.ts       Worker entrypoint, landing page, health, MCP callback
├─ bot/           bot gateway object, slash commands, install flow
├─ session/       per-guild Durable Object, OpenCode agent, storage
├─ discord/       Discord REST and gateway socket
├─ mcp/           external MCP probe, linking, OAuth
└─ plugins/       OpenCode plugins, one self-contained directory each
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

### Brand assets

`assets/` is both the source directory and the Worker's public directory. The
favicon, square mark, apple touch icon, and wide banner are served as Cloudflare
static assets; `/brand/*` and `/favicon.ico` are routed through the Worker's
`ASSETS` binding so they keep the long-lived cache and `nosniff` headers. The
landing page and the sign-in pages use the favicon, and
`/brand/banner.webp` is the social preview image. Add or replace files in
`assets/` and deploy; there is no generated source to keep in sync.

### Configuration

| Variable | Purpose |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Discord bot token for the socket, commands, and messages |
| `ENCRYPTION_KEY` | Base64url 32-byte key for sealing stored credentials |
| `SESSION_SECRET` | Signs MCP sign-in state and callback links |
| `PUBLIC_ORIGIN` | Origin used in links and OAuth callbacks |
