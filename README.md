# eryn

An OpenCode coding agent that lives in your Discord. Mention **@eryn** in a
server and it opens a thread for the request, runs it through an embedded
OpenCode server, and streams the reply as it is written. Reply in the thread and
the agent keeps going in the same session.

**Every server brings its own OpenCode Go key.** A server admin signs in with
Discord at `https://eryn.otbeaumont.me/console`, picks a server they administer,
and pastes their own key. Inference is billed to them — nothing runs on the
operator's account. Keys are encrypted at rest and used only for that server.

Everything runs on Cloudflare: the HTTP surface is an
[Effect](https://effect.website) `HttpRouter`, the Discord gateway lives in a
Durable Object, the agent is an embedded OpenCode host
(`@opencode/sdk/workerd`) whose database is that object's SQLite storage, and a
registry Durable Object holds each guild's encrypted credential.

**One Durable Object per Discord server.** The guild id *is* the object name, so
a server's OpenCode database, virtual filesystem, GitHub binding, and credential
all live in storage nothing else can be routed to. That is the security
boundary: two servers can never share a workspace, a session, or a key.

The MCP server is also published, so the same tools are available to any
harness (OpenCode, Claude, Cursor, …) over OAuth 2.1 — see
[MCP server](#mcp-server).

```
                     ┌──────────────────────────────┐
  browser ── OAuth ──▶ Worker (Effect HTTP)          │
                     │  /console  /auth/callback       │
                     │  /mcp  /.well-known  /oauth     │
                     └──────────────┬───────────────┘
                                    │ encrypted key
                                    ▼
                              ErynRegistry (singleton DO, SQLite)
                                    ▲
                                    │ apiKey + model
Discord ── gateway WS ─▶ ErynGateway (singleton DO) ──fetch──▶ ErynSession (one DO per guild)
                             ▲                                        │
                             └──────────── Discord REST ◀────────────┘   embedded OpenCode → OpenCode Go

harness ── OAuth 2.1 + Streamable HTTP ──▶ /mcp  (bearer token, signed by the Worker)
```

## Agent capabilities

The Workerd OpenCode profile has no host filesystem or process plane, so Eryn
supplies its own through two decoupled plugins (`src/opencode/`):

- **`eryn.workspace`** replaces the built-in `read`/`write`/`edit`/`bash` tools
  with implementations backed by a virtual filesystem stored in the thread's
  Durable Object, and by [`just-bash`](https://github.com/vercel-labs/just-bash)
  for shell commands. `bash`, the file tools, and GitHub all see the same files,
  so the agent can genuinely create and run a small project.
- **`eryn.github`** adds `github_issues`, `github_issue`, `github_clone`,
  `github_branch`, `github_commit`, and `github_pull_request`, authenticated as a
  GitHub App. `github_clone` downloads a repository tarball straight into the
  workspace; edits are committed and a PR opened without a local `git`.

## MCP server

`POST https://eryn.otbeaumont.me/mcp` is a Streamable HTTP MCP endpoint built
with Effect's `McpServer` (`src/mcp/server.ts`). It negotiates every revision
from 2026-07-28 down to 2024-11-05, so stock clients work unchanged.

It is protected by a small OAuth 2.1 authorization server (`src/mcp/oauth.ts`):

| Endpoint                                       | Purpose                                  |
| ---------------------------------------------- | ---------------------------------------- |
| `/.well-known/oauth-protected-resource`        | RFC 9728 protected-resource metadata      |
| `/.well-known/oauth-authorization-server`      | RFC 8414 authorization-server metadata    |
| `POST /oauth/register`                         | RFC 7591 dynamic client registration      |
| `/console/mcp/authorize`                       | Consent screen (the Solid app)            |
| `POST /oauth/token`                            | `authorization_code` + `refresh_token`    |

Point a client at the URL and it discovers, registers, and authorizes itself:

```json
{ "mcp": { "servers": { "eryn": { "type": "remote", "url": "https://eryn.otbeaumont.me/mcp" } } } }
```

Visiting `/console/mcp` shows the setup and can run the whole flow in the
browser as a self-test. Discord and GitHub connections are staged there but
parked: the tools behind them land in a later change, and today the only tool is
`random_number`.

**Eryn's own sessions need no setup.** When a guild's object builds its OpenCode
host it mints a short-lived bearer token with the same secret the endpoint
verifies, and passes it as a header, so the cloud agent uses the MCP without an
OAuth round trip. That is the same public endpoint any harness uses; nothing is
special-cased.

Tokens are HMAC-signed blobs, not rows: the client, the authorization code, and
both tokens are stateless, so there is no store to provision or expire.

## Sleeping and cost

A Discord bot has to be connected to hear a mention, and Cloudflare only
hibernates Durable Objects that accept *inbound* WebSockets — an object holding
an outbound socket stays resident. So exactly one object, `ErynGateway`, is
billed for duration while the bot is online. It holds only the socket and the
thread ownership map: no database, no OpenCode host, no per-turn work.

Everything else sleeps:

- **Per-guild objects** are created on the first prompt and register no alarm or
  timer, so they are evictable the moment a turn ends and the answer is written.
- **No per-minute cron.** The gateway's own alarm is the mechanism; the
  scheduled trigger is a slow safety net (`*/15 * * * *`) for a cold start after
  a deploy, and `DISCORD_KEEPALIVE_SECONDS` (default 840) keeps alarm wake-ups
  to tens per day instead of 1440.
- **Session resume.** The alarm cycles the socket before Cloudflare's 15 minute
  cap, resuming the Discord session, so a reconnect loses no messages.
- **Kill switch.** Clearing `DISCORD_BOT_TOKEN` makes the gateway object return
  without connecting, which stops all continuous compute.

The unavoidable part is the one resident gateway object; there is no way to
receive arbitrary Discord messages without a persistent gateway connection.

## Behaviour

- **Mention to start.** A guild mention opens a thread named after the request
  and creates a session, and the requester is added to the thread. The bot
  accepts a ping of either its user (`<@…>`) or its managed role (`<@&…>`).
- **Follow-ups.** Any human message inside a thread Eryn owns goes straight to
  that thread's session — no mention needed.
- **Progress and streaming.** While the agent works, the reply message shows a
  rotating spinner and a short status line (`Thinking…`, then `Working…` once
  tools run). As tokens arrive the spinner gives way to the answer, edited in
  place at most once every 1.5s and spilling into new messages past 2000
  characters. The final transcript is written when the turn ends, so a throttled
  edit can never lose output.
- **One message.** The answer streams into a single message; there is no
  separate completion reply. The requester is added to the thread silently (via
  the thread-members API, no ping), so they follow it and Discord notifies them.
- **Stop.** Run `/stop`, or say `stop` / `cancel` / `!stop` in the thread, to
  interrupt the running turn. The session is kept.
- **Unconfigured servers.** A mention in a server with no key gets a short reply
  pointing at the setup page instead of running inference.

## Operator setup

Requirements: Node `^22.18.0 || >=23.5.0` (the `cf` CLI needs it) and pnpm.

```sh
pnpm install
cp .dev.vars.example .dev.vars
```

### 1. Discord application

1. Create an application at <https://discord.com/developers/applications> and
   add a bot. Copy the token to `DISCORD_BOT_TOKEN`.
2. Enable **Message Content Intent** under *Bot → Privileged Gateway Intents*.
3. Under *OAuth2*, copy the **Client Secret** to `DISCORD_CLIENT_SECRET` and add
   the redirect URI `https://eryn.otbeaumont.me/auth/callback`.
4. Invite the bot with the `bot` scope and the *Send Messages*, *Create Public
   Threads*, *Send Messages in Threads*, *Read Message History*, and *Use
   Application Commands* permissions (the landing page's **Install** button does
   this).

### 2. Generate secrets

```sh
echo "ENCRYPTION_KEY=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
echo "SESSION_SECRET=$(openssl rand -hex 32)"
```

Put both in `.dev.vars`.

### 3. GitHub App (optional)

The GitHub tools authenticate as a GitHub App, so no personal token is stored.

1. Create an App at <https://github.com/settings/apps/new>. Set its **Setup URL**
   (and enable *Redirect on update*) to
   `https://eryn.otbeaumont.me/github/callback`.
2. Grant repository permissions: **Contents: Read and write**, **Issues:
   Read-only**, **Pull requests: Read and write**, **Metadata: Read-only**.
3. Generate a private key. Put the App id, the whole PEM, and the App's URL slug
   into `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and `GITHUB_APP_SLUG`.
4. In `/console`, an admin clicks **Install GitHub App** for their server and sets
   the `owner/repo` to work in.

Without these, Eryn still works; the GitHub tools are simply absent.

### 4. Deploy

```sh
pnpm run typecheck
pnpm run deploy -- --secrets-file .dev.vars
```

The Worker is published to `eryn.otbeaumont.me` (config in
`cloudflare.config.ts`). A slow cron trigger (`*/15 * * * *`) is a safety net for
the gateway object; the object's own alarm is what keeps the bot connected.

Local development: `pnpm dev`. The Discord OAuth flow needs a registered
redirect URI, so sign-in only works against the deployed origin.

## Connecting a server (what an admin does)

1. Install Eryn from the landing page's **Install** button.
2. Open `https://eryn.otbeaumont.me/console` and sign in with Discord.
3. Pick the server, paste an OpenCode Go API key, choose a model, and save.

The setup page lists only servers the user can manage
(`MANAGE_GUILD`/`ADMINISTRATOR`/owner), and every save re-checks that permission
against Discord. Removing a key takes effect for new turns immediately.

## Configuration

| Binding                        | Kind   | Default                       | Purpose                                             |
| ------------------------------ | ------ | ----------------------------- | --------------------------------------------------- |
| `DISCORD_BOT_TOKEN`            | secret | —                             | Discord bot token (empty disables the bot)          |
| `DISCORD_CLIENT_SECRET`        | secret | —                             | OAuth2 client secret for the setup sign-in          |
| `ENCRYPTION_KEY`               | secret | —                             | base64url 32-byte key encrypting guild credentials  |
| `SESSION_SECRET`               | secret | —                             | Signs OAuth state, session cookies, and MCP tokens  |
| `GITHUB_APP_ID`                | secret | —                             | GitHub App id (optional; enables the GitHub tools)  |
| `GITHUB_APP_PRIVATE_KEY`       | secret | —                             | GitHub App private key, PEM (optional)              |
| `GITHUB_APP_SLUG`              | text   | empty                         | GitHub App URL slug, for the install link           |
| `PUBLIC_ORIGIN`                | text   | `https://eryn.otbeaumont.me`  | Origin linked from Discord messages                 |
| `MCP_INTERNAL_URL`             | text   | empty (→ `PUBLIC_ORIGIN/mcp`) | Where Eryn's own sessions reach the MCP             |
| `DISCORD_KEEPALIVE_SECONDS`    | text   | `840`                         | Gateway keepalive alarm interval                    |
| `DISCORD_TURN_TIMEOUT_SECONDS` | text   | `900`                         | Seconds before a turn is interrupted                |

Each guild's key is stored in `ErynRegistry` encrypted with AES-GCM under
`ENCRYPTION_KEY`. The plaintext is read only by the gateway, over the internal
Durable Object binding, and passed to the guild's object for that turn.

## Known limits

- The virtual filesystem lives in the guild's Durable Object storage, one key
  per file, and is shared by that server's threads — it is not the host's
  filesystem, and very large files are bounded by Durable Object storage limits.
  The shell is `just-bash`, so it covers common commands but not every Unix tool
  (or real network access).
- Guild channels only; DMs have no threads and are ignored.
- A gateway outage between an eviction and the next alarm is not replayed unless
  Discord still holds the resumable session, so a mention in that window can be
  missed.
- The MCP's consent screen issues tokens to anyone who can reach it. Today that
  only exposes a random number generator; enabling the Discord or GitHub tools
  must gate approval on a linked account.
