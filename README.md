# eryn

Eryn is a **Discord bot** that runs an OpenCode agent. Mention **@eryn** in a
server and it opens a thread, runs the request, and streams the reply. Reply in
the thread and it keeps going in the same session.

There is no web console and no hosted MCP server. Everything a server needs is
configured in Discord, and the whole deployment is one Cloudflare Worker.

## Setup

**Setup is a conversation, not a web page.** Add the bot and it DMs whoever added
it (found in the audit log) to start setup. Everything is a slash command:

| Command | Does |
| --- | --- |
| `/eryn setup provider` | Connect an inference provider for this server (key or OAuth) |
| `/eryn setup model` | Pick the model, from this server's own catalogue |
| `/eryn setup status` | Whether the server is ready |
| `/eryn mcp add` | Add and test an external MCP server |
| `/eryn mcp list` / `test` / `remove` | Manage and check linked MCP servers |
| `/eryn stop` | Interrupt the running turn |
| `/eryn help` | What to do next |

Every server brings its own provider keys, sealed and stored in that guild's own
Durable Object. Inference is billed to the server, not to the operator.

**Nothing is connected implicitly.** The agent uses only the MCP servers an admin
has explicitly linked, with the tokens those links carry. Linking is a deliberate,
revocable act by someone with Manage Server.

**Adding an MCP server is a conversation, not a form.** `/eryn mcp add` takes any
external MCP server's streamable HTTP URL. The server is tested before it is
stored: Eryn calls `initialize` and `tools/list`, reports the tools it found, and
offers a **Test** button that repeats the check. If the server answers `401` with
the RFC 9728 challenge, Eryn runs the OAuth 2.1 client flow itself — protected-
resource and authorization-server metadata discovery, dynamic client registration
(RFC 7591), PKCE, and a signed `state` that returns to `/api/bot/mcp/callback` —
and stores the access and refresh tokens with the link. A server that wants a
static bearer instead gets told to add it with a token in the same modal. Access
tokens are refreshed as they expire, so a link keeps working until it is removed.

The MCP-events OpenCode plugin is bundled with the bot and is **server-agnostic**:
`mcpevents_subscribe`, `mcpevents_unsubscribe`, and `mcpsubscribe_listen` take a
configured server name or an explicit `url` + `headers`, so they work with any
linked MCP server.

## Layout

```
eryn/
├─ src/
│  ├─ index.ts       the Worker entrypoint, health check, MCP sign-in callback
│  ├─ bot/           the singleton bot object, slash commands, install flow
│  ├─ session/       one Durable Object per guild: OpenCode host, keys, links
│  ├─ discord/       Discord REST and gateway socket primitives
│  ├─ mcp/           external MCP client, linking, and OAuth
│  ├─ opencode/      the embedded host's storage, shell, and workspace
│  └─ plugins/       the bundled MCP-events plugin
├─ cloudflare.config.ts
└─ vite.config.ts
```

| Durable Object | Name | Holds |
| --- | --- | --- |
| `BotGatewayV5` | `bot` | the one Discord socket, slash commands, threads, the install DM |
| `BotSessionV5` | guild id | OpenCode host, provider keys, MCP links, the virtual filesystem |

One Worker composes both objects. Nothing else is required.

## Development

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm dev          # cf dev
pnpm typecheck    # cf workers types && tsc
pnpm run deploy   # cf deploy
```

### Deploying

A deploy does not restart a live Durable Object: it keeps running the code it
started with, and its own `versionMetadata()` binding keeps reporting that
deploy. So the Worker sends its deploy id to every object it calls, and an
object that sees a new one schedules a restart (an alarm a second out) instead
of failing the request. A turn or tool call in flight finishes first.

The restart is signalled in memory and armed as an alarm; the alarm aborts with
`{ retryAlarm: false }`, since an interrupted alarm otherwise retries in a
backoff chain with the bot offline. The signal must not be persisted: an abort
discards the event's storage writes, so a stored marker survives the restart
and makes every replacement instance restart again. The keepalive alarm is
armed after the restart alarm, never over it.

The call that discovers a restart is often the one the restart kills, so the
wake that pokes the bot keeps poking for a few seconds even when its first call
fails: that is what makes the replacement instance connect immediately instead
of leaving the bot offline until the next cron tick. Socket work is counted too,
so a restart waits for a message or interaction already being handled rather
than cutting off the reply.

That makes a deploy take effect within a second or two, with no renames:

```sh
pnpm run deploy
curl -s https://eryn.otbeaumont.me/health
# {"ok":true,"service":"eryn","deploy":"<worker deploy>","bot":{"connected":true,"deploy":"<bot object deploy>","restart":false}}
```

`deploy` and `bot.deploy` matching means the objects are running the code you
just shipped; if they differ, the object has not restarted yet.

## Configuration

```
DISCORD_BOT_TOKEN            the bot's token: the socket, slash commands, threads
ENCRYPTION_KEY               base64url 32-byte key sealing every stored credential
SESSION_SECRET               signs external MCP sign-in state and callback links
PUBLIC_ORIGIN                the origin used in links and OAuth callbacks
DISCORD_KEEPALIVE_SECONDS     the bot socket's keepalive alarm interval
DISCORD_TURN_TIMEOUT_SECONDS  how long one turn may run
```

Credentials are sealed with AES-GCM under `ENCRYPTION_KEY`; a key is never
sent back out of the guild object.

## Known limits

- Local (stdio) MCP servers cannot be reached: a Worker has no process plane.
- External MCP servers must be reachable over https. Loopback over http is
  accepted so a server can be tried in development.
- An external MCP server that only supports an authorization code flow without
  dynamic client registration has to be added with a bearer token.
- The virtual filesystem lives in the guild's Durable Object storage, one key per
  file, and is shared by that server's threads.
- Discord channels only; DMs have no threads and are ignored.
