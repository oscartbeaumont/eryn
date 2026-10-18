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
Durable Object, each thread's agent is an embedded OpenCode host
(`@opencode/sdk/workerd`) whose database is that object's SQLite storage, and a
registry Durable Object holds each guild's encrypted credential.

```
                     ┌──────────────────────────────┐
  browser ── OAuth ──▶ Worker (Effect HTTP)          │
                     │  /console  /auth/callback       │
                     └──────────────┬───────────────┘
                                    │ encrypted key
                                    ▼
                              ErynRegistry (singleton DO, SQLite)
                                    ▲
                                    │ apiKey + model
Discord ── gateway WS ─▶ ErynGateway (singleton DO) ──fetch──▶ ErynSession (one DO per thread)
                             ▲                                        │
                             └──────────── Discord REST ◀────────────┘   embedded OpenCode → OpenCode Go
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
- **One ping, at the end.** The requester is mentioned exactly once, in a reply
  to the finished answer, when the run completes (or is stopped or fails).
  Nothing pings them while the agent is still working.
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
`cloudflare.config.ts`). A cron trigger wakes the gateway object every minute so
the bot reconnects after a deploy.

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
| `SESSION_SECRET`               | secret | —                             | Signs the OAuth state and session cookies           |
| `GITHUB_APP_ID`                | secret | —                             | GitHub App id (optional; enables the GitHub tools)  |
| `GITHUB_APP_PRIVATE_KEY`       | secret | —                             | GitHub App private key, PEM (optional)              |
| `GITHUB_APP_SLUG`              | text   | empty                         | GitHub App URL slug, for the install link           |
| `PUBLIC_ORIGIN`                | text   | `https://eryn.otbeaumont.me`  | Origin linked from Discord messages                 |
| `DISCORD_KEEPALIVE_SECONDS`    | text   | `60`                          | Gateway keepalive alarm interval                    |
| `DISCORD_TURN_TIMEOUT_SECONDS` | text   | `900`                         | Seconds before a turn is interrupted                |

Each guild's key is stored in `ErynRegistry` encrypted with AES-GCM under
`ENCRYPTION_KEY`. The plaintext is read only by the gateway, over the internal
Durable Object binding, and passed to the thread's session for that turn.

## Known limits

- The virtual filesystem lives in the thread's Durable Object storage, one key
  per file, and is scoped to the thread — it is not the host's filesystem, and
  very large files are bounded by Durable Object storage limits. The shell is
  `just-bash`, so it covers common commands but not every Unix tool (or real
  network access).
- Guild channels only; DMs have no threads and are ignored.
- A gateway outage between an eviction and the next alarm is not replayed unless
  Discord still holds the resumable session, so a mention in that window can be
  missed.
