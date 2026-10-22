# eryn

An OpenCode coding agent that lives in your Discord. Mention **@eryn** in a
server and it opens a thread for the request, runs it through an embedded
OpenCode server, and streams the reply as it is written. Reply in the thread and
the agent keeps going in the same session.

**Every server brings its own provider keys.** A server admin signs in with
Discord at `https://eryn.otbeaumont.me/console`, picks a server they administer,
and connects one or more providers — OpenCode Go, OpenRouter, or anything else
the embedded OpenCode server knows about. Inference is billed to them — nothing
runs on the operator's account. Keys are encrypted at rest and used only for
that server.

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
                                    │ encrypted keys
                                    ▼
                              ErynRegistry (singleton DO, SQLite)
                                    ▲
                                    │ connections + model
Discord ── gateway WS ─▶ ErynGateway (singleton DO) ──fetch──▶ ErynSession (one DO per guild)
                             ▲                                        │
                             └──────────── Discord REST ◀────────────┘   embedded OpenCode → providers

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

Visiting `/console/mcp` shows the setup, runs the whole flow in the browser as a
self-test, and is where your own remote MCP servers are connected. The endpoint
itself is served by the caller's own Durable Object — see
[the gateway](#the-gateway) — and every caller gets `random_number` whatever
else it fronts.

**Eryn's own sessions need no setup.** When a guild's object builds its OpenCode
host it mints a short-lived bearer token with the same secret the endpoint
verifies, and passes it as a header, so the cloud agent uses the MCP without an
OAuth round trip. That is the same public endpoint any harness uses; nothing is
special-cased.

Tokens are HMAC-signed blobs, not rows: the client, the authorization code, and
both tokens are stateless, so there is no store to provision or expire.

## Analytics and observability

Two independent systems, because they answer different questions.

**Workers Observability** (`observability` in `cloudflare.config.ts`) persists
invocation logs and traces to Cloudflare and turns recurring errors into
real-time **Issues**. `redactQueryString` is on, because our own routes carry
OAuth codes, PKCE challenges, and session state in the query string.

**PostHog** covers the web UI: pageviews, a few product events
(`server_key_saved`, `server_key_removed`, `mcp_client_connected`), and
client-side crashes. Signed-in users are identified by their Discord id so
console usage is attributable; anonymous visitors are never turned into person
profiles.

Requests do not go to `posthog.com`. The client points `api_host` at its own
origin and rewrites every ingestion path to `/ingest/...`, and the Worker
proxies that onward:

```
browser → https://eryn.otbeaumont.me/ingest/i/v0/e/  →  https://us.i.posthog.com/i/v0/e/
          https://eryn.otbeaumont.me/ingest/static/* →  https://us-assets.i.posthog.com/static/*
```

Being first-party is the point: ad blockers match on `posthog.com`, so a
proxied request survives. The proxy strips `cookie` and `authorization` before
forwarding, so no Eryn credential ever reaches PostHog.

The project token is served from `GET /api/config` rather than compiled into the
bundle, so analytics can be turned off by clearing `POSTHOG_KEY` with no
rebuild.

### Nothing is captured in development

`initAnalytics` returns immediately unless `import.meta.env.PROD` is true, and
also refuses a loopback hostname, so neither `pnpm dev` nor a production build
served locally reports anything. Crashes that happen before the SDK loads are
buffered and replayed once it does.

Error tracking needed one project-level change as well:
`autocapture_exceptions_opt_in` is enabled on the PostHog project, because
without it the server tells the SDK to leave exception autocapture off.


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

## Connecting your own MCP servers

`/console/mcp` takes a remote MCP server by URL, and Eryn becomes its client:
the Discord agent can call its tools, and the same server can be dropped from
your own harness once the endpoint fronts it.

Only **remote** servers can be connected. A Worker has no process plane, so a
stdio server (`browser-control`, `pencil`, `google-calendar`, …) cannot be
reached at all — it has to keep running locally, or be put behind a public URL
by something like `mcp-proxy`.

**Eryn owns the sign-in.** The MCP authorization spec is OAuth 2.1 with
protected-resource metadata, dynamic client registration, and a `resource`
indicator; `src/mcp/auth.ts` implements all three, and the callback lands on
`/oauth/mcp/callback`. It has to be Eryn's flow: OpenCode's own MCP client
receives its callback on a `127.0.0.1` listener (`createServer` in
`@opencode/core/dist/mcp/oauth.js`), which a Worker can neither open nor be
reached at. So the agent is handed a plain bearer header instead, and the token
is refreshed on use.

Servers belong to a **Discord user**, not to a server, because they are a
person's tools: set them up once and they follow you into every Discord server
you run Eryn in. The agent acts with the **guild owner's** servers — resolved
from Discord once per object — so a server's tools are the owner's, not an
admin's. Tokens and the registered client live in `ErynRegistry` sealed under
`ENCRYPTION_KEY`, alongside provider keys.

### Discord tools

Eight tools let a model work with Discord: list servers, list a server's
channels, read one channel, read a channel's messages with `before`/`after`
pagination, search a server's history by text, list active or archived threads,
post a message, and open a thread.

They live on the MCP endpoint rather than in the agent, so one set serves both.
The agent is told which channel it was invoked in by the `eryn.discord` plugin,
and these take that id and read around it — which is the point: the bot can
gather its own context instead of relying on what someone pasted in.

**They act as the bot, not as the account that connects them.** The bot is the
only identity with the intents and permissions to read history, so the tools are
as visible as the bot is rather than scoped to one Discord server. Turning them
on is therefore a deliberate act — the MCP page's Connect — and one that
reverses: the tools stay registered and their visibility follows the connection,
so disconnecting withdraws them without tearing anything down.

Three limits are worth knowing. **Search depends on Discord's index**, which is
built lazily per server: until it exists the endpoint answers `202` with code
`110000`, and the tool says so rather than reporting no matches — paging a
channel with `discord_messages` always works, and is what the tool points at.
Messages are flattened to text, attachments are named rather than fetched, and a
message is cut at 900 characters. And posting never parses mentions, so a
message the model writes cannot ping a role or everyone by accident.

### GitHub tools

Fourteen tools, for the work a coding agent does around a repository rather than
inside it: `github_whoami`, `github_repos`, `github_repo`, `github_issues`,
`github_issue`, `github_create_issue`, `github_update_issue`, `github_comment`,
`github_search`, `github_pulls`, `github_pull`, `github_create_pull`,
`github_review`, and `github_ci`.

**Two credentials, because the name on an action usually matters.** A personal
access token makes every action carry the user's own name. Eryn's GitHub App,
installed on their account, makes them carry the app's, acting on their behalf —
which is what an installation is for. The same tools serve both; the only
difference is where the bearer token comes from, and `github_whoami` reports
which one is in play. Either is connected on the MCP page.

The app path needs three things, and a deployment can be missing any of them:
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` (secrets), `GITHUB_APP_SLUG` (a text
binding, so the install link can be built), and an actual installation. The MCP
page says so plainly when the app is unavailable rather than offering a button
that would fail, and a token always works.

A personal token is checked against `GET /user` before it is stored, so a typo is
caught when it is pasted rather than by the first tool call a model makes.

**Two GitHub surfaces now exist, and they are different.** These tools are the
MCP endpoint's: REST only, against any repository the credential reaches, for
both a harness and the bot. The agent's older `github_*` tools
(`src/opencode/github.ts`) are the *workspace* ones — clone a tarball into the
virtual filesystem, branch, commit the files, open a pull request — bound per
Discord server by the GitHub App installation on the Bot page. Neither replaces
the other: one reads and writes through the API, the other moves a working tree.

### The gateway

`/mcp` fronts those servers, so a harness points at one URL and drops its own
copies. The endpoint is **one Durable Object per Discord user**, and the token's
subject is what routes a request to it: an external harness gets its own, and
Eryn's sessions get the guild owner's. That is what makes a single URL safe —
Effect's `McpServer` keeps one tool registry per isolate, so a shared endpoint
would answer `tools/list` with every user's tool names and schemas.

Tools are exposed as `<server>_<tool>`, because tool names are flat, and a call
is forwarded to the server it came from with a token refreshed on the way out.
Content is flattened to text: a gateway cannot know which content parts a
harness will accept, and one rejected part would fail the whole call.

**Enable and disable is a visibility flip, not a re-registration.** A tool's
visibility comes from an `EnabledWhen` annotation, so the predicate reads the
object's live set of switched-on servers. That matters twice over: no session is
dropped when the dashboard changes something, and `notifications/tools/list_changed`
can be sent to harnesses that are already connected. The dashboard pokes the
object after a change so the notification goes out immediately rather than on
the next request; the object also re-reads the registry on every request, so a
missed poke only costs promptness.

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
- **Deleted threads.** Deleting a thread cancels the turn still running in it,
  rather than letting it finish with nowhere to write the answer, and the record
  that says the thread is ours goes with it. Deleting the parent channel is the
  one case that cannot be seen, because Discord need not name the threads it
  takes with it.
- **Unconfigured servers.** A mention in a server with no provider connected
  gets a short reply pointing at the setup page instead of running inference.

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
   Eryn also requests the standard `GUILDS` intent, which is what carries the
   thread deletions a running turn is cancelled by; standard intents need no
   toggle.
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
3. Pick the server and connect a provider — search the list, paste an API key,
   or start the provider's own sign-in.
4. Choose a model from the picker — a searchable list of what the connected
   providers can actually reach.

The card makes the state explicit. A server with nothing connected shows a red
**Offline** pill and a **Not ready** banner, because Eryn cannot answer there at
all; once a provider is connected it shows a green **Ready** pill and one row per
provider with its key prefix and a **Disconnect** button. Keys can be revealed
while typing. The model picker is disabled until something is connected, because
there is nothing to ask a provider without a key, and its list is filled from
that server's own OpenCode instance rather than a hardcoded set — the same
catalogue a turn would resolve against, so it cannot drift from what the agent
can use. Any `provider/model` reference can still be typed by hand.

Every provider that instance knows is listed, not only the ones connected here:
a provider someone configured elsewhere still has a catalogue worth seeing, and
the picker marks the models that cannot run yet. Connected providers come first,
and the hint under the field says how many of the listed models are usable.

The provider catalogue behind **Connect a provider** is read defensively, per
provider: a provider whose methods are not shaped like the rest is logged and
skipped rather than throwing, which would empty the whole list and read as
"there are no providers" instead of as a failure. If the list cannot be read at
all, the console says why.

The Bot page lists only servers the user can manage
(`MANAGE_GUILD`/`ADMINISTRATOR`/owner), and every save re-checks that permission
against Discord. Disconnecting a provider takes effect for new turns immediately.

### Providers

The provider list is not Eryn's: it comes from the embedded OpenCode server, so
a provider added upstream appears in the console with no change here. Each
provider declares the **flows** it can be connected with, and Eryn implements
the flows rather than the providers:

| Flow       | What it does                                  | Works in a Worker |
| ---------- | --------------------------------------------- | ----------------- |
| `key`      | Paste an API key, stored encrypted per server | Yes               |
| `oauth`    | The provider's own browser sign-in            | Where the flow needs no local listener |
| `env`      | Read a credential from the environment        | No — there is no per-server environment |
| `command`  | Run a provider's CLI to log in                | No — a Worker has no process plane |
| `external` | Use a credential chain the platform provides  | No |

`key` is what almost every provider offers — models.dev gives every provider it
describes a `key` method — so connecting OpenRouter, Anthropic, Google, or
anything else needs no provider-specific code. `oauth` covers the providers that
only sign in, such as GitHub Copilot and xAI; it runs on the guild's own object,
and a flow that needs a listener on `127.0.0.1` (Poe, ChatGPT, DigitalOcean)
cannot work here and reports that rather than failing silently.

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
| `POSTHOG_KEY`                  | text   | the Eryn project's public token | PostHog project token; empty disables analytics   |
| `POSTHOG_INGEST_HOST`          | text   | `https://us.i.posthog.com`    | Where the `/ingest` proxy forwards events           |
| `POSTHOG_ASSETS_HOST`          | text   | `https://us-assets.i.posthog.com` | Where `/ingest/static/*` is forwarded           |
| `POSTHOG_UI_HOST`              | text   | `https://us.posthog.com`      | PostHog app host, so UI links point at the right instance |
| `DISCORD_KEEPALIVE_SECONDS`    | text   | `840`                         | Gateway keepalive alarm interval                    |
| `DISCORD_TURN_TIMEOUT_SECONDS` | text   | `900`                         | Seconds before a turn is interrupted                |

Each guild's provider keys are stored in `ErynRegistry` encrypted with AES-GCM
under `ENCRYPTION_KEY`, as one sealed list keyed by integration id. The
plaintext is read only by the gateway and the console's own API, over the
internal Durable Object binding, and passed to the guild's object for that turn.

Only the first characters of a key are kept in the clear, and only so the
console can show which provider is configured. Everything else exists solely as
ciphertext, and the API never returns more than that prefix.

### How a credential reaches OpenCode

It is delivered as an **integration credential**, not as provider config:

```ts
await host.integration.connect.key({ integrationID, key, location })
```

This matters. `providers["opencode-go"].settings.apiKey` is accepted by the
config schema but never reaches provider activation, so a provider configured
that way stays invisible — its models do not resolve and every request fails
with `Model unavailable`. The integration store is the channel the provider
registry actually reads. It also lives in the guild object's own database, so
the credential is scoped to that guild's object rather than to an environment
variable shared by whatever else the isolate is running.

The same store is what a sign-in leaves behind, which is why disconnecting a
provider clears it in the guild's own object as well as in the registry: a
credential that came from a sign-in was never in the registry at all.

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
- The MCP's consent screen issues tokens to anyone who can reach it and can sign
  in with Discord, so a token is only as trustworthy as that sign-in. The Discord
  tools are gated on the account explicitly connecting them, but they act as the
  bot — as visible as the bot is, across every server it has been added to, not
  scoped to one. GitHub's tools are still parked.
