# eryn

Two things that used to be one: an **MCP server** you host, and a **Discord bot**
that runs an OpenCode agent. They are separate packages — `eryn-gateway` and
`eryn-bot` — that do not import each other, deployed today as a single Worker and
composed by `src/index.ts`.

```
eryn/
├─ packages/
│  ├─ gateway/   @oscartbeaumont/eryn-gateway   the MCP server + the console's API
│  ├─ bot/       @oscartbeaumont/eryn-bot       the Discord bot + the OpenCode agent
│  └─ console/   @oscartbeaumont/eryn-console   the web UI (a Solid SPA)
└─ src/index.ts  the one file that knows all three exist
```

## The gateway

`https://eryn.otbeaumont.me/mcp/<name>` is a Streamable HTTP MCP endpoint. A user
creates any number of **hosted MCP servers** in the console; each is a named set
of tools plus the accounts it may act through, and each has its own URL and its
own tokens.

- **Accounts.** Connect as many Discord, GitHub, and Google Calendar accounts as
  you like at `/console/accounts`. Each shows its avatar, username, and name, and
  links to its public profile where the provider has one. GitHub can be a personal
  token or Eryn's OAuth app; Google Calendar is OAuth with full read and write.
- **Tools.** Four groups — `builtin`, `discord`, `github`, `google_calendar` —
  configured per hosted server as a coarse `none`/`read`/`write`/`all` per group
  plus optional per-tool overrides. Read and write are derived from each tool's
  own nature, so a new tool is classified without a hand-maintained list.
- **Auth.** OAuth 2.1 with RFC 9728 protected-resource metadata, RFC 8414
  authorization-server metadata, RFC 7591 dynamic client registration, and PKCE.
  A token names the exact hosted server it was issued for, which is what makes one
  origin safe: the subject routes the request, and the object serves only that
  server.
- **Events.** The MCP Events extension alongside core MCP: `events/list`,
  `events/subscribe` (webhook), `events/stream` (SSE push, resumable by cursor),
  `events/poll`, `events/unsubscribe`, and core `subscriptions/listen`. Today the
  source is `discord.message.created`, fed by a Discord socket the gateway opens
  lazily — only while something is subscribed.

Core MCP is served by Effect's `McpServer`; the events extension is served beside
it, because it is a draft that sits outside the negotiated core protocol.

## The bot

Mention **@eryn** in a Discord server and it opens a thread, runs the request
through an embedded OpenCode server, and streams the reply. Reply in the thread
and it keeps going in the same session.

**Setup is a conversation, not a web page.** Add the bot and it DMs whoever added
it (found in the audit log) to start setup. Everything is a slash command:

| Command | Does |
| --- | --- |
| `/eryn setup provider` | Connect an inference provider for this server (key or OAuth) |
| `/eryn setup model` | Pick the model, from this server's own catalogue |
| `/eryn setup status` | Whether the server is ready |
| `/eryn mcp add` | Connect an external MCP server by URL |
| `/eryn mcp link` | Link one of *your* hosted MCP servers to this server, with tool limits |
| `/eryn mcp list` / `remove` | Manage them |
| `/eryn stop` | Interrupt the running turn |
| `/eryn help` | What to do next |

Every server brings its own provider keys, sealed and stored in that guild's own
Durable Object. Inference is billed to the server, not to the operator.

**Nothing is connected implicitly.** The agent uses only the MCP servers an admin
has explicitly linked, with the tokens those links carry. There is no
auto-minted token and no impersonation: linking a hosted server is a deliberate,
revocable act by someone with Manage Server, and it can only ever narrow what the
hosted server already exposes.

The MCP-events OpenCode plugin is bundled with the bot and is **server-agnostic**:
`mcpevents_subscribe`, `mcpevents_unsubscribe`, and `mcpsubscribe_listen` take a
configured server name or an explicit `url` + `headers`, so they work with Eryn's
own MCP and with any external one.

## Layout

| Durable Object | Package | Name | Holds |
| --- | --- | --- | --- |
| `BotGateway` | bot | `bot` | the one Discord socket, slash commands, threads, the install DM |
| `BotSession` | bot | guild id | OpenCode host, provider keys, MCP links, the virtual filesystem |
| `GatewayUser` | gateway | Eryn user id | accounts, hosted servers, grants, the MCP endpoints |
| `GatewayDiscord` | gateway | `hub` | the lazy Discord socket and the event subscriptions |

One Worker composes both packages; the console is static assets served by the
runtime. Nothing else is required.

## Development

```sh
pnpm install
cp .dev.vars.example .dev.vars
pnpm dev          # cf dev
pnpm typecheck    # cf workers types && tsc && tsc -p tsconfig.client.json
pnpm deploy       # cf deploy
```

The Discord OAuth flow needs a registered redirect URI, so sign-in works against
the deployed origin rather than a local one.

## Configuration

```
DISCORD_BOT_TOKEN            the bot's token; also the Discord tools and events socket
DISCORD_CLIENT_ID            the application id
DISCORD_CLIENT_SECRET        the console's sign-in
ENCRYPTION_KEY               base64url 32-byte key sealing every stored credential
SESSION_SECRET               signs sessions, OAuth state, and MCP tokens
GITHUB_OAUTH_CLIENT_ID       the OAuth App used to connect GitHub accounts
GITHUB_OAUTH_CLIENT_SECRET
GOOGLE_CLIENT_ID             for Google Calendar accounts
GOOGLE_CLIENT_SECRET
PUBLIC_ORIGIN                the origin used in links and OAuth callbacks
POSTHOG_*                    analytics; an empty POSTHOG_KEY disables it
DISCORD_KEEPALIVE_SECONDS    the bot socket's keepalive alarm interval
DISCORD_TURN_TIMEOUT_SECONDS how long one turn may run
```

Credentials are sealed with AES-GCM under `ENCRYPTION_KEY`; only a key's first
characters are ever in the clear, and only so the console can identify it.

## Known limits

- Local (stdio) MCP servers cannot be reached: a Worker has no process plane.
- The virtual filesystem lives in the guild's Durable Object storage, one key per
  file, and is shared by that server's threads.
- Discord channels only; DMs have no threads and are ignored.
- Events today come from Discord only; GitHub and Google Calendar events are not
  sources yet.
- The bot's agent no longer carries GitHub workspace tools — clone, branch, and
  pull request live in the gateway's GitHub tools now.
