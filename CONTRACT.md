# Eryn implementation contract

The authoritative interface between the three packages and the root Worker. Read
this before touching a package. The narrative design is `~/design/eryn/REDESIGN.md`.

## 1. Composition

The root `src/index.ts` is the only file that imports more than one package. Each
package exposes:

```ts
// packages/<pkg>/src/index.ts
export function handle(request: Request): Promise<Response | undefined>; // undefined = not mine
export class <Durable> extends DurableObject<Env> {}
```

- `@oscartbeaumont/eryn-gateway` exports `handle`, `GatewayUser`, `GatewayDiscord`.
- `@oscartbeaumont/eryn-bot` exports `handle` (returns `undefined`; the bot has no
  public HTTP), `wake(env)`, `BotGateway`, `BotSession`.
- `@oscartbeaumont/eryn-console` is a client-only Solid SPA. It is not imported
  by the Worker; `index.html` loads it and `cf` serves its build.

**No package imports another package.** They meet only over HTTP/DO routes and the
generated ambient `Env`. Small shared utilities (`crypto`) are duplicated, not
shared.

## 2. Bindings (generated from `cloudflare.config.ts`)

`env.GATEWAY_USER`, `env.GATEWAY_DISCORD`, `env.BOT_GATEWAY`, `env.BOT_SESSION`
(DO namespaces), plus `DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET`, `ENCRYPTION_KEY`, `SESSION_SECRET`, `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`, `GITHUB_OAUTH_CLIENT_ID`,
`GITHUB_OAUTH_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`PUBLIC_ORIGIN`, `POSTHOG_*`, `DISCORD_KEEPALIVE_SECONDS`,
`DISCORD_TURN_TIMEOUT_SECONDS`.

## 3. Durable Objects

| Class | Package | Name | Serves |
| --- | --- | --- | --- |
| `GatewayUser` | gateway | Eryn user id | MCP endpoint (`/mcp/:name`), the console API, and internal routes the bot calls |
| `GatewayDiscord` | gateway | `"hub"` | the lazily-opened Discord socket + MCP event subscriptions/streams |
| `BotGateway` | bot | `"bot"` | the Discord socket, slash commands, threads, the install DM |
| `BotSession` | bot | guild id | OpenCode host, per-guild provider keys, guild MCP links |

### Internal routes (bot → gateway)

The bot holds no credential that impersonates a user: it asks the gateway, over
the `GATEWAY_USER` binding, for a guild-scoped token on explicit admin consent.

```
POST https://gateway.internal/grant      { userId, guildId, mcpServerId, tools }  -> { ok, url, token }
POST https://gateway.internal/grants     { userId }                               -> { grants: Grant[] }
POST https://gateway.internal/revoke     { userId, guildId, mcpServerId }         -> { ok }
POST https://gateway.internal/servers    { userId }                               -> { servers: ServerSummary[] }
```

### Internal routes (bot DO ↔ bot DO)

`BotGateway` calls the guild's `BotSession` for anything durable:

```
POST https://bot.internal/config        { guildId }                       -> { ready, model, providers, links }
POST https://bot.internal/providers     { guildId }                       -> { integrations: IntegrationOption[] }
POST https://bot.internal/provider/connect  { guildId, integrationID, key?, methodID?, ... } -> { ok } | { url } | { status }
POST https://bot.internal/model         { guildId, model }                -> { ok }
POST https://bot.internal/links         { guildId }                       -> { links: McpLink[] }
POST https://bot.internal/link/add      { guildId, link }                 -> { ok }
POST https://bot.internal/link/remove   { guildId, linkId }               -> { ok }
POST https://bot.internal/prompt        { ...PromptRequest, config }      -> { ok }
POST https://bot.internal/interrupt     { threadId, gone? }               -> { stopped }
```

## 4. Route ownership

| Path | Owner |
| --- | --- |
| `/mcp`, `/mcp/*` | gateway |
| `/oauth/*`, `/.well-known/*` | gateway |
| `/auth/*`, `/github/*`, `/google/*` | gateway |
| `/api/**` except `/api/bot/**` | gateway |
| `/api/bot/**` | bot (reserved; unused today) |
| `/health` | root |
| everything else | console SPA (static assets) |

## 5. Gateway HTTP API (the console's contract)

Discord sign-in sets the `eryn_session` cookie.

```
GET  /api/config                     -> { posthog: { key, uiHost } | null }
GET  /api/session                    -> { signedIn, account?: { id, name, avatarUrl } }
GET  /auth/discord | /auth/callback | /auth/logout
GET  /api/accounts                   -> { signedIn, accounts: AccountSummary[], providers: ProviderSummary[] }
POST /api/accounts                   { action, ... }
GET  /github/callback | /google/callback
GET  /api/tools                      -> { groups: ToolGroup[] }
GET  /api/servers                    -> { signedIn, servers: ServerSummary[] }
POST /api/servers                    { action, ... }
GET  /api/mcp/authorize              -> consent describe
POST /api/mcp/authorize              -> consent decide
```

`POST /api/accounts` actions: `add-discord`, `start-github-oauth`,
`add-github-pat { token }`, `start-google-oauth`, `unlink { id }`,
`label { id, label }`.

`POST /api/servers` actions: `create { name, title? }`, `update { id, name?, title?, enabled? }`,
`delete { id }`, `accounts { id, accountIds[] }`, `tools { id, tools }`,
`tools-list { id }`, `revoke-grant { id, guildId }`.

## 6. Models (all parsed with Effect `Schema`)

```ts
AccountSummary  { id, provider: "discord"|"github"|"google", label,
                  profile: { id, username, name?, avatarUrl?, url? }, createdAt }
ProviderSummary { id, name, connect: ("oauth"|"pat")[], configured }
ToolAccess      { groups: Record<string, "none"|"read"|"write"|"all">,
                  tools?: { include?: string[]; exclude?: string[] } }
ToolGroup       { id, name, tools: { name, title, description, group, access: "read"|"write" }[] }
ServerSummary   { id, name, title?, enabled, accounts: { id, provider, label }[],
                  tools: ToolAccess, endpoint, grants: { guildId }[] }
Grant           { guildId, mcpServerId, toolNames: string[], createdAt }
McpLink         { id, kind: "eryn"|"external", name, url, mcpServerId?, tools: ToolAccess, createdAt }
```

Accounts, provider keys, and MCP tokens are sealed (AES-GCM, `ENCRYPTION_KEY`).

## 7. Conventions

- Idiomatic Effect: `Context.Service` + `Layer` for I/O subsystems, `Schema` for
  every parse (HTTP bodies, storage records, tool inputs, upstream responses),
  `effect/http`'s `HttpRouter` for HTTP, `effect/ai`'s `McpServer` for the MCP
  endpoint. Errors are tagged values.
- A Durable Object is a thin shell: it composes layers over its own storage and
  delegates. Business logic lives in services that can be tested without a Worker.
- Log prefix: `[eryn:gateway:…]` / `[eryn:bot:…]`.
- Storage records are versioned by key prefix, e.g. `account:`, `server:`,
  `grant:`, `session:`, `guild:`.
- No `any` in public signatures; no throwing strings.
