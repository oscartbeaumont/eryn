# eryn

An OpenCode coding agent that lives in your Discord. Mention **@eryn** in a
server and it opens a thread for the request, runs it through an embedded
OpenCode server, and streams the reply as it is written. Reply in the thread and
the agent keeps going in the same session — no re-explaining.

Everything runs on Cloudflare: the HTTP surface is an
[Effect](https://effect.website) `HttpRouter`, the Discord gateway lives in a
Durable Object, and each thread's agent is an embedded OpenCode host
(`@opencode/sdk/workerd`) whose database is that object's SQLite storage.

```
Discord ── gateway WS ──▶ ErynGateway (singleton DO)  ──fetch──▶ ErynSession (one DO per thread)
                              ▲                                        │
                              └──────────── Discord REST ◀────────────┘   embedded OpenCode
                                                                           │
                                                                      OpenCode Go (DeepSeek V4.1 Flash)
```

- `ErynGateway` holds one gateway connection, turns mentions into threads, and
  remembers which threads it owns. It hosts no agent work, so a long turn can
  never stall the heartbeat.
- `ErynSession` is one Durable Object per thread. It owns an embedded OpenCode
  host and streams `session.text.*` events into the thread.
- The public Worker only serves a landing page at `/` and `/health`. Discord
  traffic never touches the public HTTP surface.

## Behaviour

- **Mention to start.** A guild mention opens a thread named after the request
  and creates a session. A mention already inside a thread answers there. Because
  Discord also creates a managed role with the bot's name, the bot accepts a ping
  of either its user (`<@…>`) or that role (`<@&…>`).
- **Follow-ups.** Any human message inside a thread Erynn owns goes straight to
  that thread's session — no mention needed.
- **Streaming.** The reply is written into a Discord message and edited as the
  model produces tokens (at most one edit every 1.5s, spilling into new messages
  past 2000 characters). The final transcript is written when the turn ends, so a
  throttled edit can never lose output.
- **Stop.** Run `/stop` (a slash command), or say `stop` / `cancel` /
  `!stop` in the thread, to interrupt the running turn. The session is kept.
- **First prompt wins the thread name.** Threads archive after 24 hours of
  inactivity.

## Setup

Requirements: Node `^22.18.0 || >=23.5.0` (the `cf` CLI needs it) and pnpm.

```sh
pnpm install
cp .dev.vars.example .dev.vars
```

### 1. OpenCode Go key

Subscribe to [OpenCode Go](https://opencode.ai/console), copy the API key, and
put it in `.dev.vars` as `OPENCODE_API_KEY`. The default model is
`opencode-go/deepseek-v4.1-flash` (`src/agent.ts`).

### 2. Discord application

1. Create an application at <https://discord.com/developers/applications> and
   add a bot. Copy the token into `.dev.vars` as `DISCORD_BOT_TOKEN`.
2. Enable **Message Content Intent** under *Bot → Privileged Gateway Intents*.
   Without it the bot sees empty message content.
3. Invite the bot with the `bot` scope and the *Send Messages*, *Create Public
   Threads*, *Send Messages in Threads*, *Read Message History*, and *Use
   Application Commands* permissions.
4. Optionally set `DISCORD_GUILD_ID` to register `/stop` in one guild
   immediately; otherwise it is registered globally and can take up to an hour.
5. Optionally set `DISCORD_CHANNELS` to limit the bot to specific channels and
   their threads (same JSON as the `discord` skill's `config.json`):

   ```json
   { "channels": { "general": { "id": "123456789012345678" } } }
   ```

## Deploy

```sh
pnpm run typecheck
pnpm run deploy -- --secrets-file .dev.vars
```

The Worker is published to `eryn.otbeaumont.me` (config in
`cloudflare.config.ts`). A cron trigger wakes the gateway object every minute so
the bot reconnects after a deploy; the first request to `/` or `/health` does it
too.

Local development:

```sh
pnpm dev
```

With an empty `DISCORD_BOT_TOKEN`, the bot stays disabled and the landing page
still works.

## Configuration

| Binding                        | Kind   | Default                    | Purpose                                            |
| ------------------------------ | ------ | -------------------------- | -------------------------------------------------- |
| `OPENCODE_API_KEY`             | secret | —                          | OpenCode Go credential                             |
| `DISCORD_BOT_TOKEN`            | secret | —                          | Discord bot token (empty disables the bot)         |
| `DISCORD_GUILD_ID`             | text   | empty                      | Register `/stop` in this guild for instant use     |
| `DISCORD_CHANNELS`             | text   | empty (all)                | JSON allowlist of channels and their threads       |
| `DISCORD_KEEPALIVE_SECONDS`    | text   | `60`                       | Gateway keepalive alarm interval                   |
| `DISCORD_TURN_TIMEOUT_SECONDS` | text   | `900`                      | Seconds before a turn is interrupted               |

## Known limits

- The OpenCode Workerd profile has no local filesystem or process execution, so
  the agent runs as a conversational assistant: it reasons, plans, and can use
  network-based tools, but cannot edit files or run a shell. See
  <https://opencode.ai/v2/docs/build/sdk/cloudflare>.
- Guild channels only; DMs have no threads and are ignored.
- A gateway outage between an eviction and the next alarm is not replayed unless
  Discord still holds the resumable session, so a mention in that window can be
  missed.
