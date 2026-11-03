# Eryn implementation contract

The authoritative interface inside the single `eryn` Worker. The narrative
design is `~/design/eryn/REDESIGN.md`.

## 1. Composition

`src/index.ts` is the Worker entrypoint. It exports the two Durable Object
classes, answers `/health`, the models.dev catalogue, and the external MCP
sign-in callback, and returns `404` for everything else.

```
src/
├─ index.ts       Worker entrypoint and public routes
├─ bot/           BotGatewayV5, slash commands, install flow, session client
├─ session/       BotSessionV5, the OpenCode host, storage, models
├─ discord/       REST, socket, components, stream helpers
├─ mcp/           external MCP client, links, OAuth
├─ opencode/      embedded host storage, shell, workspace
├─ plugins/       the bundled MCP-events plugin
├─ catalogue.ts   filtered models.dev catalogue
├─ config.ts      constants, bindings helpers, logging
├─ crypto.ts      sealing and signing
├─ deploy.ts      deploy-id header and restart plumbing
└─ errors.ts      tagged errors
```

There is no console package and no MCP gateway package. All UI is Discord.

## 2. Bindings (generated from `cloudflare.config.ts`)

`env.BOT_GATEWAY` and `env.BOT_SESSION` (DO namespaces), plus
`DISCORD_BOT_TOKEN`, `ENCRYPTION_KEY`, `SESSION_SECRET`, `PUBLIC_ORIGIN`,
`DISCORD_KEEPALIVE_SECONDS`, `DISCORD_TURN_TIMEOUT_SECONDS`, and `CF_VERSION`.

## 3. Durable Objects

| Class | Name | Serves |
| --- | --- | --- |
| `BotGatewayV5` | `"bot"` | the Discord socket, slash commands, threads, the install DM |
| `BotSessionV5` | guild id | OpenCode host, per-guild provider keys, guild MCP links |

### Internal routes (bot DO ↔ bot DO)

`BotGateway` calls the guild's `BotSession` for anything durable:

```
POST https://bot.internal/config        { guildId }                       -> { ready, model, providers, links }
POST https://bot.internal/providers     { guildId }                       -> { integrations: IntegrationOption[] }
POST https://bot.internal/models        { guildId }                       -> { models: ModelOption[] }
POST https://bot.internal/provider/connect  { guildId, integrationID, key?, methodID?, ... } -> { ok } | { url } | { status }
POST https://bot.internal/model         { guildId, model }                -> { ok }
POST https://bot.internal/links         { guildId }                       -> { links: McpLink[] }
POST https://bot.internal/link/add      { guildId, link }                 -> { ok }
POST https://bot.internal/link/remove   { guildId, linkId }               -> { ok }
POST https://bot.internal/link/probe    { guildId, url, token? }          -> McpProbe
POST https://bot.internal/link/test     { guildId, linkId }               -> McpProbe
POST https://bot.internal/link/oauth/start     { guildId, name, url, channelId?, resourceMetadataUrl?, scope? }
                                                                          -> { ok, attemptId, url } | { ok: false, error }
POST https://bot.internal/link/oauth/status    { guildId, attemptId }     -> { status, message?, link? }
POST https://bot.internal/link/oauth/complete  { guildId, attemptId, code?, error? } -> { ok, status, message?, link?, tools? }
POST https://bot.internal/prompt        { ...PromptRequest, config }      -> { ok }
POST https://bot.internal/interrupt     { threadId, gone? }               -> { stopped }
```

`McpProbe` is `{ ok, tools: { name, title?, description? }[], serverName?, needsAuth?, resourceMetadataUrl?, scope?, error? }`.

## 4. Route ownership

| Path | Serves |
| --- | --- |
| `/api/bot/models-catalogue` | the filtered models.dev catalogue for an embedded host |
| `/api/bot/mcp/callback` | an external MCP authorization server returning to the bot |
| `/health` | Worker and bot socket status |
| everything else | `404` |

## 5. Models (all parsed with Effect `Schema`)

```ts
McpLink         { id, name, url, token?, oauth?: McpOAuth, tools: ToolAccess, createdAt }
McpOAuth        { refreshToken?, clientId, clientSecret?, tokenEndpoint, expiresAt, scope?, resource? }
McpToolSummary  { name, title?, description? }
PendingMcpAuth  { attemptId, name, url, channelId?, state, clientId, clientSecret?, tokenEndpoint,
                  resource?, scope?, codeVerifier, redirectUri, status, message?, linkId?, createdAt }
ToolAccess      { groups: Record<string, "none"|"read"|"write"|"all">,
                  tools?: { include?: string[]; exclude?: string[];
                            access?: Record<string, "read"|"write"> } }
```

Provider keys, MCP bearer tokens, and external MCP OAuth tokens are sealed
(AES-GCM, `ENCRYPTION_KEY`).

## 6. Conventions

- Idiomatic Effect: `Context.Service` + `Layer` for I/O subsystems, `Schema` for
  every parse (HTTP bodies, storage records, tool inputs, upstream responses).
  Errors are tagged values.
- A Durable Object is a thin shell: it composes layers over its own storage and
  delegates. Business logic lives in services that can be tested without a Worker.
- Log prefix: `[eryn:bot:…]`.
- Storage records are versioned by key prefix, e.g. `provider:`, `session:`,
  `guild:`, `link:`, `mcp:auth:`.
- No `any` in public signatures; no throwing strings.
