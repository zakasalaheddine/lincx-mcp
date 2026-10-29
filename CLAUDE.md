# CLAUDE.md — lincx-mcp-server

This is the working context for Claude Code on this project.
Read this fully before making any changes.

---

## What this project is

An MCP (Model Context Protocol) server that gives Claude access to the Lincx / Interlincx platform.
It handles authentication, multi-network context, and exposes business tools as MCP tools.

The server is **HTTP-only** — there is no stdio transport. Everything runs on one
bare `http.createServer` on `PORT` (5001 dev default; the platform sets it in
production), routed by `http-hash-router`:
- the MCP Streamable HTTP transport at `POST /mcp` (stateless — see below)
- the browser login UI and OAuth endpoints
- `/health`

All MCP clients (Claude Code, Desktop, claude.ai) connect by URL. Credentials never pass through Claude.

### Scope: this server is a *connection* to Lincx, nothing more

Its only job is auth + network context + thin, single-endpoint Work API tools.
**Do not add orchestration, rendering, mock-data synthesis, multi-call fan-out,
or local file bundling here.** Every business tool should map to roughly one
Work API call. Multi-step workflows (template render/preview, zone load-trace,
etc.) live in a separate Claude Code skills/scripts plugin that consumes these
tools — they were intentionally removed from this server. The one tolerated bit
of server-side logic is `report_query`'s aggregation, kept purely to avoid
dumping thousands of raw rows into context (it exposes `raw: true` to opt out).

---

## Project structure

```
src/
├── index.js                  # Bootstrap — starts server.js
├── server.js                 # The server itself — MCP tool registration + start({ port })
├── constants.js              # Env vars with defaults — edit here first before touching logic
│
├── http/
│   ├── respond.js            # json / send / html / redirect / noContent
│   ├── request.js            # query / header / clientIp / readBody (100kb limit)
│   └── router.js             # http-hash-router table — the whole URL surface
│
├── services/
│   ├── auth.js               # loginWithCredentials() → POST ix-id.lincx.la/auth/login
│   ├── tokenService.js       # AES-GCM wrap + HMAC-signed OAuth tokens
│   ├── sessionManager.js     # unwrap bearer → auth context / validateSession
│   ├── networkService.js     # fetchUserNetworks() → GET WORK_API_BASE_URL/api/networks
│   └── workApi.js            # workApiRequest() — injects Bearer token; adds ?networkId to list GETs (passed via options.networkId); the NO_NETWORK guard and the query param apply to GET only, so a create POST to a list path isn't refused. It never touches request bodies — a write tool puts networkId in its own body
│
└── tools/
    ├── authTools.js          # auth_login, auth_status, auth_logout
    ├── networkTools.js       # network_list, network_refresh
    ├── _shared.js            # paginationShape / includeShape / READONLY_ANNOTATIONS + getEntityWithIncludes — reuse these in new tools
    ├── resources.js          # MCP Resources: lincx://networks + lincx://{entity}/{id} templates
    └── (add new domain tool files here)
```

`get_*` tools take `include: ['parents']` (via `includeShape` + `getEntityWithIncludes`)
instead of separate `get_*_parents` tools — keeps the per-request tool surface small.

---

## Critical rules — never violate these

### Logging goes to stderr, never stdout
- **Never use `console.log`** anywhere in this codebase — always use `console.error`.
- This includes inside Express route handlers, services, and tools.
- Why this is a hard rule: the server is HTTP-only today, but it began as a stdio
  MCP server where **stdout was the JSON-RPC wire protocol** — a stray `console.log`
  would corrupt the stream. Keeping logging on stderr preserves clean stdout in
  case a stdio transport is ever reintroduced, and keeps container logs uniform.

### Claude never controls auth context
- `auth_token` — stored in session server-side only, never returned to Claude
- `network_id` — required per business tool call
- Identity comes from the OAuth bearer on the request: `await resolveLincxSession(extra)`, which reads `extra.requestInfo.headers.authorization`, unwraps the encrypted access token, and yields `{ auth_token, user_id, email }` — never from `extra.sessionId` (always `undefined` under the stateless transport) and never from a module-global. There is no Redis session store.

### Business tools require network_id
Every business tool that reads or writes Work API data requires a `network_id`.
```js
// RIGHT — spread the shared network context shape and pass network_id to workApiRequest
import { requiredNetworkIdShape } from './_shared.js'

inputSchema: z.object({
  ...requiredNetworkIdShape,
  limit: z.number().int().min(1).max(100).default(20)
}).strict()

// in the handler:
const data = await workApiRequest(v.session, 'GET', '/api/your-endpoint', { networkId: network_id, params: { ... } })
```

### Always validate session before any API call
Every business tool must call `validateSession(auth)` before touching the Work API.
It checks: the bearer resolved to an auth context and the Lincx JWT has not expired. Network membership is enforced by the Work API, not here. `network_id` is passed directly to `workApiRequest` in `options.networkId`.

### Never log OAuth tokens
Access tokens and auth codes are bearer credentials. Never log them in full —
at most log the first 8 chars or a SHA hash. Same applies to the Lincx JWT
(`auth_token`).

---

## Multi-tenancy model

Work API list endpoints require `?networkId=<id>` in the query string. POST/PUT child-entity requests carry `networkId` in the JSON body — set by the write tool itself, NOT injected by `workApiRequest` (which only handles the query param; any future body injection must skip array bodies, or it corrupts JSON Patch payloads). Get-by-id, parents, reports, clones, deletes, and network endpoints do not attach `networkId` at all.
There is no separate Network Service — networks are fetched from `WORK_API_BASE_URL/api/networks`.

The caller passes `networkId` in the `options` object to `workApiRequest()`:

```js
workApiRequest(v.session, 'GET', '/api/creative-asset-groups', { networkId: 'svce6t', params: { limit: 20 } })
```

Example request shape:
```
GET /api/creative-asset-groups?networkId=svce6t
GET /api/projects?networkId=svce6t&limit=20&offset=0
POST /api/campaigns          { ..., "networkId": "svce6t" }
GET /api/campaigns/c1        // no networkId; resolved from entity id
```

`workApiRequest()` in `services/workApi.js` handles this automatically — always use it, never call axios directly in tools.

---

## Authentication flow (OAuth 2.1 + PKCE)

The MCP client (Claude desktop, claude.ai, Claude Code) drives authentication.
The user logs in once in a browser; the client stores the resulting tokens and
sends `Authorization: Bearer <access_token>` on every `/mcp` request.

```
1. Client → POST /mcp without Authorization
   ← 401 + WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"

2. Client fetches /.well-known/oauth-protected-resource → /.well-known/oauth-authorization-server
3. Client → POST /oauth/register { redirect_uris: [...] }  ← { client_id }

4. Client opens browser → GET /oauth/authorize?response_type=code&client_id=...
   &redirect_uri=...&state=...&code_challenge=...&code_challenge_method=S256

5. Server signs the auth-request into `ctx`, redirects browser to /login?ctx=<ctx>
6. User submits email+password to POST /api/login?ctx=<ctx>
7. Server: loginWithCredentials() → issueAuthCode()
   → JSON { success: true, redirect: "<redirect_uri>?code=...&state=..." }
   Browser navigates to redirect.

8. Client → POST /oauth/token { grant_type: "authorization_code", code, code_verifier, ... }
   ← { access_token, token_type: "Bearer", expires_in }  (no refresh_token)

9. Client → POST /mcp with Authorization: Bearer <access_token> → unwraps to Lincx JWT
10. When the Lincx JWT expires, the client re-authenticates (no refresh tokens).
```

Identity server: `https://ix-id.lincx.la` (authentic-server) — unchanged.
Login endpoint: `POST /auth/login` with body `{ email, password }`.
Response shape: `{ success: boolean, data: { authToken: string } }`.
Token type: JWT (Lincx), ~30 day expiry. The OAuth access token is an opaque
AES-GCM-sealed payload wrapping the Lincx JWT; it lives for the JWT's
remaining lifetime. Clients only ever see opaque OAuth tokens — the JWT is
ciphertext wherever it transits (auth code and access token alike).

**Wrapped-token architecture:** The OAuth access token is an AES-GCM wrapping
of the Lincx JWT. The server unwraps it on each request; there is no Redis
session store. The bearer is the ONLY identity — there is no MCP session id and
no `mcp:session:<id>` binding (see § Stateless transport).

---

## Auth context model

There is no session store. `resolveLincxSession` unwraps the bearer and yields
the auth context for the request:

```js
{
  auth_token,      // Lincx JWT — injected as Bearer on every API call
  user_id,         // decoded from the JWT's sub/user_id/email field
  email,
  expires_at       // the JWT's exp (seconds)
}
```

Networks are not cached anywhere — `network_list` / `auth_status` call
`fetchUserNetworks(auth_token)` live on every invocation.

Token TTLs (all self-contained, verified by `tokenService.js` — `typ` binds each
token to its family):
- `client_id` — 90 days (HMAC-signed, public metadata)
- `ctx` (pending auth-request) — 10 min (HMAC-signed; reusable — a password typo
  must not burn the login link)
- auth `code` — 60 sec (AES-GCM sealed; **reusable within the window — NOT
  single-use.** Deliberate: the sealed envelope leaks nothing and PKCE binds
  redemption to the verifier, so replay needs a code+verifier pair inside the
  TTL. A replay cache would need shared state this deployment does not run —
  revisit if the instance count grows)
- access token — the wrapped JWT's `exp` (~30 days); no refresh tokens

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WORK_API_BASE_URL` | Yes | `http://localhost:3050` | Work API — all requests go here |
| `IDENTITY_SERVER` | No | `https://ix-id.lincx.la` | Lincx auth server |
| `PORT` | No | `5001` | Express HTTP port (login UI + MCP over HTTP) |
| `WRAPPING_KEY` | Yes | — | ≥32-char secret for AES-GCM access-token wrapping and HMAC-signed OAuth tokens. Server refuses to start without it. Injected by the platform in production, never committed. |
| `NODE_ENV` | No | `development` | Set to `production` to disable the `/dev/*` debug routes |
| `PUBLIC_BASE_URL` | No | `http://localhost:<PORT>` | Used when building browser login URLs returned to Claude |
| `RESPONSE_SIZE_LIMIT` | No | `30000` | Hard per-response character ceiling enforced by `toolGuard`. Raise if your client tolerates larger tool results; floored at 5k. The soft serializer budget (`CHARACTER_LIMIT`) derives from it (−5k) |

There is no `NETWORK_API_BASE_URL` — networks come from `WORK_API_BASE_URL/api/networks`.

---

## Build and run

```bash
npm install          # first time only
npm start            # run the server (node src/index.js) on PORT — no build step
npm run lint         # standard src/ scripts/ — the compiler's replacement
npm test             # ava (config lives in package.json)
npm run smoke <url>  # read-only post-deploy checks against a live server
npm run soak  <url>  # SOAK_TOKEN=… — holds a session an hour, proves ONE instance
npm run dev          # tunnel (ngrok, else cloudflared) + node --watch (see below)
npm run dev:local    # node --watch only — no tunnel, http://localhost:5001
```

**`npm run dev`** (`scripts/dev-tunnel.mjs`) starts a tunnel — **ngrok** if it is
installed, else **cloudflared** (`npm run dev:ngrok` / `npm run dev:cloudflared`
force one) — learns the generated https URL from the agent, then boots the watch
server with `PUBLIC_BASE_URL` set to **that URL** and prints a banner with the
`<url>/mcp` to paste into a Claude Desktop / claude.ai connector. Those clients
require https, hence the tunnel.

`PUBLIC_BASE_URL` matching the URL the client hits is not cosmetic: the OAuth
discovery document is built from it, so a stale value makes the client fetch
discovery over https and then read a `registration_endpoint` on
`http://localhost` — which it refuses, reporting only *"Couldn't register with
… sign-in service"*. Nothing fails server-side, which is what makes it expensive
to diagnose. Two guards exist now: the tunnel script refuses to start if
something already owns `PORT` (otherwise the tunnel serves a stale server with
its own `PUBLIC_BASE_URL`), and `routes/wellKnown.js` logs a one-line warning
when discovery is served for a host that does not match `PUBLIC_BASE_URL`.

On the ngrok free plan the edge shows a browser interstitial the first time the
LOGIN PAGE is opened — one click ("Visit Site"). API traffic is unaffected, and
`--request-header-add ngrok-skip-browser-warning` does not suppress it (the edge
decides before traffic policy runs). `npm run dev:cloudflared` has no
interstitial.

Use **`npm run dev:local`** for plain local work with no tunnel (Claude Code via
`mcp-remote`, or curl).

No external services are needed — auth state is self-contained in the sealed
tokens, so there is no Redis to run and nothing is lost on restart. The only
required env is `WRAPPING_KEY` (see `.env.example`).

---

## Connecting an MCP client

The server is HTTP-only, so clients connect by URL — there is no stdio command form.

- **Production:** point the client at `https://<your-domain>/mcp`.
- **Local dev:** run `npm run dev`, then connect to `http://localhost:5001/mcp`.

`claude.ai` and Claude Desktop take the URL directly (Settings → Connectors).
For Claude Code or any stdio-only client, bridge the URL with `mcp-remote`:

```json
{
  "mcpServers": {
    "lincx": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://localhost:5001/mcp"]
    }
  }
}
```

`mcp-remote` runs the OAuth dance in the browser and proxies it over stdio. For
`PUBLIC_BASE_URL` to match the URL the client hits, leave it unset locally (it
defaults to `http://localhost:<PORT>`).

---

## How to add a new business tool

1. Create `src/tools/yourDomainTools.js`
2. Follow this pattern:

```js
import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError } from '../services/workApi.js'
import { requiredNetworkIdShape } from './_shared.js'

export function registerYourDomainTools (server) {
  server.registerTool('your_tool_name', {
    title: 'Human Readable Name',
    description: 'Clear description of what this does and what it returns.',
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      limit: z.number().int().min(1).max(100).default(20)
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ limit, network_id }, extra) => {
    const auth = await resolveLincxSession(extra)
    if (!auth) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(auth)
    if (!v.valid || !v.session) return { content: [{ type: 'text', text: `Error: ${v.error}` }] }

    try {
      const data = await workApiRequest(v.session, 'GET', '/api/your-endpoint', { networkId: network_id, params: { limit } })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: handleWorkApiError(err) }] }
    }
  })
}
```

3. Register it in `createMcpServer()` in `src/server.js` (NOT `src/index.js` — that
   is the bootstrap that loads secrets before importing the server):
```js
import { registerYourDomainTools } from './tools/yourDomainTools.js'
registerYourDomainTools(server)
```

4. Run `npm run lint`

---

## Implemented Tools

### Auth
- `auth_login` — returns browser login URL
- `auth_status` — check session state
- `auth_logout` — destroy session

### Networks
- `network_list` — list available networks (active only by default; `includeArchived`, `limit`/`offset` paging via `next_offset`)
- `network_refresh` — re-fetch networks from API, then return them in `network_list`'s slim/paged shape (same `includeArchived`/`limit`/`offset`/`verbose` args). It used to dump the raw list — 354 full objects, 82k chars — so the tool was unreachable behind the 30k guard with an empty input schema advertising pagination that did not exist. `fetchUserNetworks` throws on an upstream failure and returns `[]` only when the account truly has none, so an empty result is unambiguous.

### Resources (MCP Resources, `src/tools/resources.js`)
Pull-based reference data — read by URI, not via a tool call. Not part of the
per-request tool schema, so they cost nothing per turn.
- `lincx://networks` — networks the session can access + the active one (the `network_list` tool stays as the discovery surface)
- `lincx://{entity}/{id}` — resource templates mirroring `get_<entity>` for all 13 entity types (campaign, zone, ad, ad-group, creative, template, channel, site, publisher, advertiser, experience, creative-asset-group, dimension-set). Templates aren't listed in `resources/list` (no per-request cost); they let clients reference/cache entities.

Deliberately NOT resources: dimension sets / event-stats keys stay as tools — they're inputs to `report_query` and the model discovers them more reliably via a planned tool call.

### Templates (M1)
- `list_templates` — `GET /api/templates` (paginated, limit/offset); filter by `publisherId`
- `get_template` — `GET /api/templates/{id}` — includes HTML + CSS source; `include: ['parents']` adds parent hierarchy. `part: 'html' | 'css'` returns that one field as raw text, unelided — the read an edit must start from, since a large template's html is elided in the full response (`pddd6d`: html 16.7k + css 8.4k + `notes.history` > 25k). Ceiling: a single field over `CHARACTER_LIMIT` is refused ("must not be edited through this server"), never returned half-read
- `get_template_versions` — `GET /api/templates/{id}/versions`
- `get_template_version` — `GET /api/templates/{id}/versions/{version}`
- `create_template` (write) — `POST /api/templates`. Validates before anything is sent: ids via `entityId()` (every write-tool id — ids land in URL paths and `fetch` normalises `..`), non-blank html (upstream `minLength: 1` passes whitespace; `name` is trimmed by upstream's `name` format, the tool's own check just fails earlier), no `[elided: ` marker in html/css (`elidedField` — `get_template` elides a large template's html, and copying from that read would save the marker as the template), balanced mustache sections (`mustacheError` — upstream accepts any html, so a broken `{{#ads}}` would only fail at serve time), html+css ≤ 80k chars (`/mcp` bodies cap at 100kb), and `contentError` — what an LLM actually gets wrong: markdown code fence around the source, control characters / lone surrogates, placeholder comments (a comment whose WHOLE body is `rest unchanged` / `...` / `omitted` etc. — `/* fill remaining space */` passes, so a live template with ordinary comments stays editable; a heuristic regex) standing in for omitted code, and markup left open (`<!--`, `<script>`/`<style>` count mismatch, unbalanced css `{}` / `/*`, `</style` in css — each swallows the publisher's page). The name also rejects control characters/newlines. Then pre-flight GETs the publisher AND the CAG: each must exist, be in `network_id`, not be archived. The CAG check is the one upstream lacks — `integrity-check.js` drops `creativeAssetGroup` before matching ids, so without it a template binds to another network's CAG. `notes` is not accepted (extra history rules; not needed to ship a template). Returns `{ id, name, networkId, publisherId, creativeAssetGroupId, version }`, never the html/css. Content over 25k chars in one field can be created (cap is 80k total) but not edited through this server: `get_template part` refuses a field over `CHARACTER_LIMIT`. Not idempotent: a timeout or 5xx (upstream commits to Redis before GCS) says "may exist, check list_templates" rather than inviting a duplicate-creating retry.
- `update_template_content` (write) — `POST /api/templates/{id}/patch` with a JSON Patch the tool builds itself from a **closed set**: `test /networkId`, `replace /html`, `add /css` (`templatePatch`; `add` because css is optional upstream and `replace` on a missing path throws). Raw ops from the model are never accepted. **An edit goes live immediately on every zone using the template** (and zone template tests) — no draft/publish step upstream; the description says so. Not `PUT`: PUT validates the request body against the full schema, so every edit would need a GET and a re-send of untouched fields. `test /networkId` scopes the edit atomically, no pre-flight GET; its failure maps to "template X is not in network Y". **Every patch 422 is cut to its first line**: fast-json-patch's message carries the operation and the WHOLE stored document, and upstream returns it as `details` — passed through, a wrong-network edit would dump another network's template into context. Same validation as `create_template` (ids, non-blank html, balanced mustache, no `[elided: ` marker, ≤ 80k, `contentError`: no code fence / control characters / placeholder comment / unclosed comment-script-style-brace — on an edit a placeholder like `<!-- rest unchanged -->` would overwrite the live template with the placeholder), plus at least one of html/css; empty css clears it. The elision guard is the one that matters most: an edit made from a truncated read would write the marker over the live template. Deliberately NOT editable: `creativeAssetGroupId` (upstream rewrites every zone using the template with the new CAG — silently changes ad-group eligibility in all of them; and it is load-bearing that the tool refuses it: upstream's patch → `update` path never runs the integrity check or the linked-entity lookup, and `forbidParentsChange` does not list `creativeAssetGroupId`, so a patch could point every zone on a template at ANY 6-char id with no check the CAG exists or is in the network — the `.strict()` schema and `templatePatch`'s closed op set are the only guard, do not make it editable without adding that check), `tieringEnabled` (changes what serving returns), `networkId`/`publisherId` (forbidden upstream), `name`/`notes`. Returns `{ id, name, version }`; version is upstream's md5(html, css, CAG) scheme, so content identical to an older version reuses that number. Last-write-wins, no version guard. Known gap: the UI appends a `notes.history` system note per edit, this tool doesn't — `get_user_actions` still records the `update` row (`trackUserAction` runs in the patch endpoint).

### Creative Asset Groups (M1)
- `list_creative_asset_groups` — `GET /api/creative-asset-groups` (paginated)
- `get_creative_asset_group` — `GET /api/creative-asset-groups/{id}` — includes field schema defining what data ads must provide

### Zones (M2)
- `list_zones` — `GET /api/zones` (paginated); filter by `publisherId`/`channelId`/`siteId`
- `get_zone` — `GET /api/zones/{id}` — `include: ['parents']` adds parent hierarchy
- `get_zone_report` — `GET /api/zones/{id}/report` (params: resolution, startDate, endDate)

### Ads (M2)
- `list_ads` — `GET /api/ads` (paginated); filter by `adGroupId`/`campaignId`/`advertiserId` (upstream priority in that order)
- `get_ad` — `GET /api/ads/{id}` — `include: ['parents']` adds parent hierarchy
- `get_zone_ads` — `GET /api/ads/ad?zoneId=` — ad-serving endpoint, returns { ads, template }. `debug: true` hits `/api/ads/ad/debug` (ad-group match/reject diagnostics)

### Ad Groups (M2)
- `list_ad_groups` — `GET /api/ad-groups` (paginated); filter by `campaignId`/`advertiserId`
- `get_ad_group` — `GET /api/ad-groups/{id}` — `include: ['parents']` adds parent hierarchy

### Creatives (M2)
- `list_creatives` — `GET /api/creatives` (paginated); filter by `advertiserId`
- `get_creative` — `GET /api/creatives/{id}` — `include: ['parents']` adds parent hierarchy

### Campaigns (M2)
- `list_campaigns` — `GET /api/campaigns` (paginated); filter by `advertiserId`
- `get_campaign` — `GET /api/campaigns/{id}` — `include: ['parents']` adds parent hierarchy

### Channels (M2)
- `list_channels` — `GET /api/channels` (paginated); filter by `publisherId`
- `get_channel` — `GET /api/channels/{id}` — `include: ['parents']` adds parent hierarchy

### Sites (M2)
- `list_sites` — `GET /api/sites` (paginated); filter by `publisherId`/`channelId`
- `get_site` — `GET /api/sites/{id}` — `include: ['parents']` adds parent hierarchy

### Publishers (M2)
- `list_publishers` — `GET /api/publishers` (paginated)
- `get_publisher` — `GET /api/publishers/{id}`

### Dimension Sets (M3)
- `list_dimension_sets` — `GET /api/dimension-sets` (paginated)
- `get_dimension_set` — `GET /api/dimension-sets/{id}` — dimensions available for report_query

### Reporting (M3)
- `get_event_stats_keys` — `GET /api/event-stats` — unique event key-values for last 31 days (use to discover filter dimensions)
- `report_query` — `GET /api/reports/{dimensionSetId}` with required date range. Row granularity follows the dimension set: with the `hour` dimension upstream returns hourly rows, without it one row per UTC day. This tool **aggregates server-side** and returns compact rolled-up sums (grand total by default, or grouped by `groupBy` e.g. `['zone']` / `['zone','date']`). `raw: true` returns the unaggregated rows. `filter` (e.g. `{ advertiser: 'Acme' }`) scopes the report to one entity — the upstream endpoint has NO entity filter (scoped only by the dimension set's networkId), so filtering is applied server-side over the fetched rows (`filterReportRows`), which is what keeps a per-offer/hourly pull under the size guard. Filter keys are auto-added to `d`; a key absent from every row errors (not a dimension of the set) rather than silently returning zero. `timezone` (IANA, e.g. `America/Denver`) buckets date/hour in local time — upstream is UTC-only, so the tool fetches ±1 UTC day of padding, rebuckets each hourly row via `Intl` (DST-correct), then trims to the requested local range (`rebucketRowsToTimezone`/`shiftUtcDate`). A non-UTC `timezone` **requires `hour`**: on a daily row there is nothing to redistribute, and the old `hour ?? 0` stamped each one 18:00 the previous Denver day — every date shifted by one and the window summed the wrong days, silently (issue #68). Two guards now: a **pre-flight** `GET /api/dimension-sets/{id}` checks the set carries every needed dimension (`groupBy`, `filter` keys, `hour` for a non-UTC tz) and errors naming the gap before the report fetch; a **row fallback** refuses when rows come back without a valid hour anyway (lookup failed, set edited mid-session). `rebucketRowsToTimezone` never fabricates an hour. The server only names the gap — picking a set that has the dimensions is the plugin skill's job. When grouped output would still overflow, the `groups` array is capped to the top-ranked groups (by loads/revenue) with a `groupsTruncated` note (`capGroups`) — graceful degradation like the list tools' `next_offset`, never a hard guard error. The hard ceiling is `RESPONSE_SIZE_LIMIT` (env-tunable, default 30k). Server-side rollup keeps a week of data (hundreds of rows) under the response-size limit instead of truncating — the pattern to follow for any high-volume endpoint.

### Dimension set writes (a "report" in Reports Center)
- `create_dimension_set` (write) — `POST /api/dimension-sets`. Makes a report carrying the dimensions a question needs when no existing one has them; **prefer it over editing** a report others use. `normalizeDimensions` sends what upstream demands: `date, networkId` (or `date, hour, networkId`) first — any other order is rejected — duplicates dropped, id/name pairs added (`zone` ⇒ `zoneId`, mirroring lincx-core's `dPairs`). An active report with the same dimension set is returned instead of creating a duplicate (upstream rejects those too, so this only makes the answer useful). **A dimension name the network has never used is registered upstream as a permanent custom dimension** — a typo is not rejected — so `unknownDimensions` refuses names outside the core event columns and the network's existing reports unless `allowNewDimensions: true`. Upstream limits (50 active reports, 12 extra dimensions, no clone of a system report, `eventString` forbidden) pass through as 422 text. Not idempotent: a timeout/5xx says "may exist, check list_dimension_sets".

- `add_dimensions_to_set` (write) — `GET` then `PUT /api/dimension-sets/{id}` with `{ networkId, name, dimensions }`. Adds dimensions (typically `hour`) to an existing report; **adds only, never removes**. Editing changes a report other people use (row counts, exports), so the description says prefer `create_dimension_set` and ask the user first. The GET-by-id has no network scope, so the tool checks `networkId === network_id` itself and refuses an archived set; the merged list goes through the same `normalizeDimensions` / `unknownDimensions` as create. Nothing to add ⇒ no write. A result equal to another active report is rejected upstream with that report's name (passed through). Not `PATCH /{id}` — that is *unarchive*; `/{id}/patch` is JSON Patch, which would have to keep upstream's dimension order by hand. Last-write-wins, no version guard.

### Zone Inventory (composite)
- `get_zone_targeting_inventory` — composite: which ad groups are DIRECTLY targeted to a zone (via `params.zoneId`) and whether each is fully live (campaign + ad group + a live ad with a viable, non-archived creative), or where it's off. Scans the whole network's ad-groups/campaigns/ads/creatives **internally** (each list GET returns the full set — the MCP normally slices it client-side only to fit the LLM guard; internal calls bypass that) and returns only the compact matched rollup (`zone`, `summary`, `groups[]` with per-level flags + `off_reason`, `conflicting[]`, `scan`), size-capped like `report_query`. `exceptParams.zoneId` = exclusion (a group targeting AND excepting the zone is reported as `conflicting`). A level is "on" only if `enabled && !archived`; A campaign also counts as on only **inside its `dateStart`/`dateEnd` flight window** (`dateEnd` inclusive, a missing bound open) — an enabled campaign whose window has passed reports `campaign_on:false` with `off_reason` `campaign-window`, distinct from `campaign` (switched off or archived). `has_live_viable_ad` is a per-ad conjunction, and counts only ads that pass their own targeting rules here (`adServesInZone` against the zone's `zoneRequest` — the tool fetches the zone's channel for `channelType`; an ad that depends on the visit still counts). Group-level rules beyond `zoneId` do not change this tool's row set or `fully_live` — the eligibility tools report them. So the two tools' "live" counts can now differ on the same zone, by design: `fully_live` here ignores a group's other rules, while `get_zone_eligible_ad_groups`' `directlyTargetedLive` counts `verdict: 'eligible'` groups with a live ad that serves every visit keeping the zone's defaults (`offers.live > 0`, #91). The gap is exactly the targeted groups reading `fully_live: true` here that tool reports as `excluded` or `conditional` — for those rules, and also for a `creativeAssetGroupId` that does not match the zone's, which `fully_live` never checked (seeded G09 — targets Z0, blacklists Z0's template — is `fully_live: true` here and never serves) — plus the eligible groups whose live ads all depend on the visit (`directlyTargetedLiveOnConditionalAds`), since `has_live_viable_ad` counts a geo-only ad as live. Before #81 both ignored those rules, which is why Rex's 10-01 comparison (`ow7zky` 80 targeted / 40 live) agreed. Both tool descriptions say so; making this tool params-aware was considered and rejected, since it would change what `fully_live` means. **Never drops ad groups** (the answer is exhaustive by contract): the full rollup rides in the `content` TEXT — a one-line header, a blank line, then compact JSON `{ zone, mode, summary, groups[], conflicting[], scan }`. It is NOT in `structuredContent`: MCP hosts (claude.ai included) feed only `content` to the model, so rows placed only in `structuredContent` are invisible — the model saw just the header. Text is the reliable channel (same as `report_query`); carrying the payload once (no `structuredContent` copy) also means the size guard counts it once, so more rows fit (83 rows ≈ 24k < 30k, full with names). If a mega-zone would still overflow, `fitZoneInventory` first sheds the optional `name` field (`namesOmitted:true`; ids+flags stay, ~105+ rows) and only as a last resort returns ids-only with `complete:false` and a "re-run with mode:'off'/'live'" instruction — never a silent partial. The **second sanctioned server-side composite** alongside `report_query` — the deliberate exception to the one-tool-≈-one-call rule, justified the same way (never dump a whole entity list into context). Each `groups[]` row also carries `scoped_via[]` — how the group is scoped to the zone: `ad-group-whitelist` (always — the selection criterion), `ad-level-whitelist` (an ad in the group also whitelists the zone), `ad-level-blacklist` (an ad excludes the zone via `ad.exceptParams.zoneId`), `zone-selection` (group shares the zone's `creativeAssetGroupId`; never set when the zone has no CAG, since no CAG filter applies there). Annotate-only, group grain; the selected set is unchanged. Offer-grain (`ad group × ad`) scoping and free-radical counts live in `get_zone_eligible_ad_groups`.

### Zone eligibility join (composite)
An **archived zone** — or a segments-on zone with no segments whose own lists fail on every visit, which `findTopAds` refuses outright (`refusesEveryVisit`, `refusedZoneText`; reach skips those and names them in `scan.refusedZonesSkipped`) — is refused outright by all three zone-keyed tools and the inventory — the serving engine refuses one before any ad group is considered (`throwIfZoneArchived`), so they return that verdict alone rather than a rollup of unreachable rows; `get_ad_group_zone_reach` skips archived zones and reports how many in `scan.archivedZonesSkipped`. The general eligibility primitive (`tools/eligibility.js`, pure + network-agnostic): an ad group is **eligible** in a zone when it is **not archived** (archived = out of service), its `creativeAssetGroupId` matches the zone's — or the zone has **no** CAG, in which case that filter does not apply at all and every group passes it, exactly as `filterByCreativeAssetGroupId` behaves upstream (a falsy zone CAG, so `null` counts as absent) — it is not blacklisted (`exceptParams.zoneId` = blacklist, the opposite of `params`, and always wins), and it is in scope — the group's `params.zoneId` names the zone OR it targets **zero** zones (open within its CAG → *free radical*, leaks in with no direct targeting) — and every OTHER targeting rule passes too (see *Every targeting rule* below). **Ad-level** `params`/`exceptParams` are a per-ad LAST check (`adVerdict` / `adServesInZone`): they decide WHICH ads serve within an eligible group — an ad blacklisting the zone is hidden while its siblings still serve — and gate `has_live_viable_ad` in the rollup; they are not a group-scoping mechanism (`filterAdgroups()` runs before `filterAds()` in the serving engine, so an ad-level whitelist can never rescue an ineligible group). One pure join, three thin reads (same whole-network scan, compact result in the content text):
- `get_zone_eligible_ad_groups` — zone → groups bucketed by how they are SCOPED (each row's `verdict` says whether it serves): `directlyTargeted[]` (ad-group-whitelisted & not blacklisted — reconciles to the inventory tool's targeted set; config-broken-but-targeted groups stay here with `eligible:false` + `reasons`/`conflicts`/`paramBlocks`, never dropped, and so do conditional ones), `freeRadicals[]` (eligible OR conditional without direct targeting: via the shared CAG, or via no CAG filter at all on a zone with no CAG — such a row has an empty `via[]`, since there is no whitelist and no shared CAG to name), `conflicting[]` (targets+excepts), `inertWhitelists[]`, `excludedByDefault[]` (untargeted, blocked only by an overridable zone default). Each row carries the live rollup (`fully_live`, `off_reason[]`, `scoped_via[]`) plus `eligible`, `verdict`, `conditional`, `via[]`, `reasons[]`, `conflicts[]`, `conditions[]`, `paramBlocks[]`, `matchedKeys[]`, `offers`.
- `get_ad_group_zone_reach` — group → every zone it can serve/leak into (the flip). Archived zones are never reachable and are skipped (`scan.archivedZonesSkipped`). `zones[]` holds eligible AND conditional zones (`summary.reaches`/`targeted`/`freeRadical` count eligible only, `conditional` the rest); `excludedByDefault[]` the default-blocked ones. Fetches `GET /api/channels` once for every zone's `channelType`.
- `explain_serve` — (zone, adGroup|ad) pair → eligible? by what `via[]`? if not, `reasons[]` + `paramBlocks[]` (the zone-blacklist flag is `blacklisted` — on explain and reach rows alike; it was `excluded`, which read as a contradiction next to `verdict`) — the "why did X serve here" direction. The header is `IS eligible` (plus `; holds only while the visit leaves k at its zone default v`, or `…lands on a segment with template t…` for a segment-sourced match, when it rests on one), `is CONDITIONAL … only for visits where k ∈ [v]` / `… serves except for visits where …`, or `is NOT eligible` naming each block (and "a visit overriding k would change this" on a default). With an `adId` it answers at the offer grain: the top-level `verdict` / `conditions` / `paramBlocks` / `matchedKeys` / `contradiction` / `excludedByDefault` are the PAIR's (`pairExcludedByDefault`: only when every cause on the group and the ad is one a visit could lift) (group and ad together, matching the header — they were the group's alone, which could read `conditional` with an empty `conditions[]`), and `offer: { verdict, conditional, conditions[], paramBlocks[], matchedKeys[], scoped_via[], freeRadical, conflicts[], live, off?, campaign_on, adgroup_on }` keeps the ad's own rules apart. The liveness fields are the same as an `offers.ads[]` entry's (#97): one GET each for the ad group's campaign and the ad's creative, a 404 reading as missing; the header ends `; the ad is live`, `; the ad is switched on, but not eligible here (see reasons)` (live but excluded — `live` is the chain alone, so it reads as rendering otherwise), `; the ad is NOT live (off: …)`, or `; whether the ad is live is unknown (…)`: a lookup failing for any reason but a 404 (a 403 on a campaign hidden from the user) sets `liveUnknown` rather than failing the call, so the targeting answer survives: `live` is `false` when what was read already shows the ad off (`off` lists only those causes — an unread campaign says nothing about the chain), else `null`; `campaign_on` / `adgroup_on` are kept when they were read. `offer.reasons` carries the ad's own reasons (`adReasons`), which the pair's `reasons` drops under an excluded group.

**Every targeting rule, not just `zoneId` (#81).** lincx-core runs every `params` / `exceptParams` key through the params indexer (`getQueryCommands`), and an ad group's legacy `geo` / `devices` fields through `adGroupModel.selectBy`, against the request `xtendOptions` builds. The tools used to test `zoneId` alone, so on the seeded fixture (local `ybdob7`, zone Z0) they reported 13 eligible groups where lincx-core served 6. Now, all pure in `tools/eligibility.js`:
- `zoneRequest(zone, channel)` models that request as far as config decides it — the tools never assume a visit. It is `zoneResolved` (the zone's keys and defaults) plus `pickSegments` (the segment pick); simulating a visit for parity checks lives only in `src/tests/helpers/visitRequest.js`, built from those two. **Fixed** (the zone's own): `zoneId`, `networkId`, `creativeAssetGroupId`, `publisherId`, `zoneType` = `zone.type`, `channelType` = the channel's `type` (one extra channel GET). A missing channel (404, or no `channelId`) refuses the zone in every zone tool (`missingChannelText`; reach names them in `scan.missingChannelZonesSkipped` — after looking up by id each channel the permission-filtered `/api/channels` list leaves out, so a channel merely hidden from the user lands in `scan.unreadableChannelZonesSkipped`, never "does not exist") — upstream's `channel.get` throws NotFound on every visit — and any other channel-fetch failure is rethrown, never guessed past. **Default**: `templateId` and every `dataAttributesDefault` key — decided, but a real request can override them. **Segment**: on a zone with `segmentsStatus: 'on'`, `templateId` is the template of the candidate `selectNextSegment` picks — each segment that passes its own `allowlist`/`blocklist` (falling back to `params`/`exceptParams`) and has allocation, plus the zone's own template only when the zone passes its lists and those segments leave allocation under 100 (a segment whose lists read a visit key is a possible candidate, and only the certain ones count toward that 100). Segment lists compare strictly (`includes` / `_.isEqual` upstream), unlike the params index's string compare. The draw is over 100 in segment order, so a segment past a cumulative 100% (of segments certain to pass) is never a candidate. Hiding rows of a zone some visit is served on is the dangerous direction, so a segment pick that fails is never a refusal while any visit gets through: when only default-keeping visits get no candidate (lists failing only on a default — `templateId` included), the candidates come from visits overriding those defaults, `zone.refusesDefaultVisits` + `overriddenOnServedVisits` name them, and the rows judge those keys as visit keys (a group matching the rejected default reads conditional); when no unpinned visit gets one, a visit pinning a `segmentId` still does (`findTopAds` takes it by id, unchecked), so the rows are judged against every segment with `zone.servesOnlyPinnedVisits`. `segmentPickFlags` / `segmentPickNote` carry both onto zone views, headers and reach rows. Only a segments-on zone with no segments and failing lists is refused. Both candidate passes run before `request.segments` is set, so a list on `templateId` reads the zone's template, and a visit naming a `templateId` still goes through the pick (`templateId || segment.templateId`). When `templateId` is among those overridden defaults, the segment pick no longer decides the template — the visit's own `templateId` wins — so it is judged as a visit key too. Known limits, both erring safe: in such a zone a row needing the rejected default reads conditional rather than "never" (the rows do not see what the lists require), and a `complete` parity call on it takes the possible-candidates path instead of being refused. The partial-404 share is reported (#92): when the zone fails its own lists and the segments that pass cover less than 100%, `selectNextSegment` gives the zone no share of its 100-point draw, so a draw past the passing segments matches nothing and `findTopAds` throws NotFound for that share of unpinned visits; `unservedShare(zone, request)` sets `request.unservedShare = { min, max, atDefaults?, zoneRules }`, percent bounds over unpinned visits (`alloc` with `personaTrafficAllocation`): `max` counts only the segments passing on every visit (`listsVerdict` with `defaultsVary`, which treats a zone default as a value the visit can change either way), `min` is 0 when some visit lets the zone itself pass and otherwise counts every segment that can pass (`defaultsOverridable`), and `atDefaults` is the exact share for visits keeping the defaults, set only when no list there reads a visit key. `zoneRules` (`zoneListRules`) names the rules in the zone's own lists that some visit fails — `{ path, key, op, values, valuesTotal, source, actual? }`; an unserved visit fails at least one, a visit passing all of them is served; source `request` (a visit key), `zone-default` (overridable either way) or `zone` (a value the zone sets, failing every visit) — and `segmentPickNote` words each as the condition the unserved visits meet ("geoState is not TX", "s1 is abc (true at the zone default abc)"), so the header says which visits can go unserved, not only how many — verified live on local lincx-core: across five zones, every visit failing a listed rule 404'd at about the share and every visit passing them all was served. The header calls a share exact only when `min === max`, and on a range adds that segments whose lists exclude each other can leave the real share well inside it; in `explain_serve` the NOTE says "this answer" rather than "the rows below". Known limit: segments whose lists exclude each other (persona splits by device or geo) never pass together, so the real share can sit well inside the bounds — verified live on local lincx-core: mobile-only 40% + desktop-only 40% reads 20–100% while every visit gets ~60%, `segmentPickFlags` carries it to zone views and reach rows, and `segmentPickNote` adds a header NOTE. Only on the normal pick path: the `refusesDefaultVisits` / `servesOnlyPinnedVisits` fallbacks already describe a whole class of refused visits. Candidates that agree decide; candidates that disagree make the row conditional (`source: 'segment'`), and that condition lists `candidates[] { segmentId (null = the zone itself), templateId, passes }`. A visit naming a `templateId` (data attribute, or a `lincx-`/`adverse-`/`tgt-`-prefixed page param — the tag strips the prefix) beats every segment; one naming a `segmentId` pins that segment. On a segments zone `segmentId` and `segmentName` are set by the pick too (`options.segmentId = segment.id`, `options.segmentName = segment.name`, the zone itself giving its own id and name) and read per candidate like `templateId` (`SEGMENT_KEYS`; candidates carry all three); elsewhere they are visit keys. A visit can name any `templateId` but pin only a segment the zone has (`request.pinnable`), so a `segmentId` / `segmentName` block or clash is overridable only when an existing segment satisfies it. **Request-only**: everything else. `device`, `deviceOs`, `geoState` and the `dateTime*` keys are request-only even when `dataAttributesDefault` names them — the endpoint sets them after the defaults are merged (UA, `geoState: ''`, `getDateTimes`), so a zone default never reaches the index for them.
- `paramsVerdict(entity, request)` applies the indexer's semantics: empty list = no rule; a `params` list needs the key present with a listed value (absent excludes — strict whitelist); an `exceptParams` list fires on a listed value and never on an absent key; values compare as `String(v)`; legacy `geo` matches the request uppercased (so `params.geoState` is case-sensitive and `geo` is not); a list naming every value a key can take — all 168 `dateTime*` day-hours (adverse-static saves the full grid routinely), all seven devices, all three `deviceOs` values — is no rule as a whitelist and, as a blacklist, a block with `source: 'always'` (no visit passes it, so it is never "excluded by the request"). `exceptParams.position` / `zoneId-position` / `templateId-position` are skipped: they are slot rules `tagDisallowedPosition` applies after selection, never a request key. Rules beyond `zoneId` are evaluated only for a group that can reach the zone at all; an out-of-scope group carries no `paramBlocks`, so nothing reads as a cause a request could fix. A request-only key becomes a **condition** (`op: 'requires'` or `'excludes'`), never a verdict.
- **Three states.** `verdict: 'eligible' | 'conditional' | 'excluded'`; a block wins over a condition; conditions that can never all hold on one visit — within an entity, or between a group and its ad (group: mobile only; ad: never mobile; or two different templates on a segments zone) — exclude with reason `conditions-contradict` / `ad-conditions-contradict` and `contradiction: <key>` (`contradiction()`; a template clash only the segment pick causes — a template a visit could name would satisfy it — carries `contradictionOverridable: true` and goes to `excludedByDefault`, but a hard clash on a visit key is checked first and wins, and keeps the group out of `excludedByDefault` even when it also has an overridable block; a key carrying a legacy `geo` rule and capped lists are not judged). "Eligible" holds for every visit that leaves the zone's defaults alone: an entry in `matchedKeys` with source `zone-default`/`segment` means a visit overriding that key (tag data attribute, prefixed page param, or a `pageUrlKeys`-mapped URL param) drops the row — the descriptions say so. Zone-set keys are treated as fixed although a tag sending them would override them too (`...opts` is last); real tags don't. `eligible` stays a boolean, true only for `'eligible'`. Rex's rule (2026-09-27): conditional rows are counted on their own — `directlyTargetedConditional`, `freeRadicalHostsConditional`, `freeRadicalOffersConditional`, each with `…Live` — in neither the eligible nor the excluded counts; the existing counts (and their `…Live` twins) are eligible-only. The `…Live` group counts are read from the offers, not `fully_live` (#91): `directlyTargetedLive` / `freeRadicalHostsLive` need `offers.live > 0` (a live ad that serves every visit that keeps the zone's defaults — the same caveat as "eligible", including `refusesDefaultVisits` / `servesOnlyPinnedVisits` / `unservedShare` zones, where it means the visits the zone serves), an eligible group whose live ads all depend on the visit counts in `directlyTargetedLiveOnConditionalAds` / `freeRadicalHostsLiveOnConditionalAds`, and `…ConditionalLive` needs `offers.conditionalLive > 0`. The group's `verdict` is untouched: lincx-core judges each ad on its own (`filterAds` queries the ad index per ad), so a group's ads are alternatives, which the AND-ed `conditions[]` cannot carry — verified on local lincx-core: a group with a 90210-only ad and a TX-only ad serves both audiences, and one with a mobile-only ad and a never-mobile ad serves every visit (that last case still lands in `…LiveOnConditionalAds`; detecting complementary ads is left out). `summary.conditionKeys` aggregates the keys the conditional rows depend on as `{ requires: { values }, excludes: { values }, groups, segment? }` — whitelist and blacklist values kept apart, `segment: true` on a key the segment pick decides; an ad contradicting its group adds nothing — and `offers.ads[]` gives each ad's own conditions. "Never on mobile" (`exceptParams.device`) is conditional too.
- **Free radical keeps its meaning** (no `params.zoneId`, open within the CAG — Zaka's spec). A free radical that matches another resolved key (`templateId`, a default, `channelType`) stays in `freeRadicals`, and `matchedKeys[]` records the match. One blocked on a zone-fixed key is dropped; one blocked only by an overridable default goes to `excludedByDefault`; one blocked on every visit (`source: 'always'`) is dropped. An ad whitelisting the zone under an `excludedByDefault` group is not flagged inert: a visit overriding the default makes it fire.
- `offerEligibility` and `offerRollup` take one options object (`{ group, adGroup, ad|ads, zone, request, offReasons }`); `adGroupReach(adGroup, zones, requestFor)`.
- **No visit input (decided 2026-10-07).** A first cut took an optional `request` map (+ `requestComplete`) and answered for that traffic; it was dropped. The tools return the verdicts and conditions, and the model reads which visits a conditional row serves on — the descriptions spell out what every real visit carries (`device`, desktop when unknown; `deviceOs`; `geoState`, `''` without geo; the `dateTime*` keys). Why: simulating a visit is serving-engine work beyond this server's scope, and getting it right is subtle (a complete visit always carries `device`/`deviceOs`/`geoState`, and `dateTime*` depends on its clock). The visit simulation used for parity checks — `visitRequest(zone, channel, visit, { complete })` — is a test helper (`src/tests/helpers/visitRequest.js`), not part of the tools' API: `complete` applies those visit defaults and leaves `dateTime*` conditional unless given, a given `segmentId` pins a segment, and a given `templateId` wins over the pick. `eligibility.test.js` also checks the no-visit verdict against every complete visit built from the fixture's own conditions (eligible → all, conditional → some, excluded → none); that checks the join against itself, so a key lincx-core ignores (as the position keys were) only shows in a live `/api/ads/ad` parity run.
- At the offer grain `adVerdict` runs the ad's own keys (`ad-param-mismatch` / `ad-param-blacklisted`); an offer is conditional when its group or its ad is. `freeRadical` stays the zone-only test on any non-excluded pair; `offerRollup` adds `conditional`, `conditionalLive`, `freeRadicalConditional`, `freeRadicalConditionalLive`, and `inScope`/`live`/`freeRadical`/`freeRadicalLive` count certain offers only.

**Free radicals have two grains.** HOST grain = the `freeRadicals[]` row set (`summary.freeRadicalHosts` / `freeRadicalHostsLive`): groups eligible only via the shared CAG — or via no CAG filter at all, on a zone with no CAG. The free radical is the *offer*; the group only **hosts** it — hence the name (it was `freeRadicalGroups`, which read as if the group were the leak). OFFER grain = `(ad group × ad)` pairs that serve *solely* via the CAG — untargeted ad **and** untargeted group, net of blacklists at both levels (`summary.freeRadicalOffers`, `offerEligibility`/`offerRollup` in `tools/eligibility.js`). Host grain **over-counts the leak**: an untargeted group whose only ad is zone-whitelisted is 1 free-radical host but **0** free-radical offers — that ad renders because it is ad-level-TARGETED, not via the CAG. The reconciliation invariant (`directlyTargeted + conflicting` = the inventory tool's targeted set) is untouched by this.

**Both grains carry a live axis, and only the live one is exposure.** `freeRadicalOffers` sums across *dormant* hosts too (field case: `gqe31y` contributes 1 with campaign and ad group both off), so on its own it reads as live leak and is not — `summary.freeRadicalOffersLive` counts only offers whose whole chain is on. The gap between the two is **standing-trap volume**: config one toggle away from landing in the zone, most often the campaign (`dr0xp2` on `6wahzt` — untargeted on the zone's CAG, group/ads/creatives all fine, held out only by campaign `nq7o5x`; 4 offers land the moment it flips). Per row, `offers.freeRadical > 0 && offers.freeRadicalLive === 0` names exactly those hosts, so there is deliberately **no** headline standing-trap counter — an earlier `standingTrapHosts` proposal keyed on `freeRadical: 0 && total > 0`, which catches the ad-level arming paths and *misses* campaign-state suppression, the dangerous one.

Liveness at the offer grain is injected, not derived: `offerRollup` takes an `offReasons(ad)` function (required, no default) returning what keeps the ad dark, empty when live, so `tools/eligibility.js` stays pure and network-agnostic; `enrich()` supplies `'campaign-or-ad-group'` when the row's chain is off plus `adOffReasons(ad, creatives)` (`'ad-disabled'` | `'ad-archived'`, `'creative-missing'` | `'creative-archived'`), and `adLiveViable` — the predicate `has_live_viable_ad` uses in `zoneInventoryTools` — is `adOffReasons(…).length === 0`, so both tools mean the same by live. Every row carries `offers: { total, inScope, live, conditional, conditionalLive, freeRadical, freeRadicalLive, freeRadicalConditional, freeRadicalConditionalLive, adLevelTargeted, adLevelBlacklisted, confinedElsewhere, inertWhitelisted, freeRadicalAdIds[], inertWhitelistedAdIds[], ads[] }` so a pure free-radical subset is derivable. `inScope` is **targeting only** (group eligible + the ad neither blacklisted, confined elsewhere, nor excluded by its own params) and says nothing about on/off state — it was called `serving`, which read as live exposure; `live` is that same set with the chain on.

**Every ad is on its row (#97).** `offers.ads[]` has one entry per ad — `{ adId, verdict, live, off?, conditions?, reasons?, paramBlocks?, contradiction?, contradictionOverridable? }`, empty fields left out — so one call per zone says what can render down to the ad and why each ad does or does not. It replaced `conditionalAds`, which was capped at 10, had no live flag (a switched-off conditional ad read like a live one), and left non-serving ads with no id or reason — an ad blocked on a zone-set key (`params.zoneType`) was in no count but `total`. `verdict` is the pair's (what the counts use); `conditions` / `reasons` / `paramBlocks` are the ad's OWN (`offerEligibility`'s `adReasons`: `adVerdict`'s reasons plus a `conditions-contradict` only the pair causes — never an excluded group's own), kept even under an excluded group — `combineVerdicts` stops at the group, so the pair's `reasons` would have made a zone-blacklisting ad on an `excludedByDefault` row read like a clean one — so an excluded ad with none is out because its group is. `live` is the whole chain whatever the verdict. The counts, the group `verdict` and `fully_live` are unchanged (#91). `filter` (`ROW_FILTERS`) narrows the rows before `fitEligibility` pages: `liveOnlyOnConditionalAds` (eligible, `offers.live === 0`, `offers.conditionalLive > 0` — the groups `…LiveOnConditionalAds` counts) or `hasLiveConditionalAd` (`offers.conditionalLive > 0`); `page.filter` echoes it, `page.total` / `next_offset` count the filtered rows, `summary` stays whole-zone. Size was not measured on prod (no prod read): a group with enough ads (~100 with modest rules) makes its row exceed the budget on its own. That row comes back as a stub `{ id, name, verdict, omitted }` with `complete: false` and `next_offset` advancing past it — it used to return ids for the whole remaining window with no `next_offset`, so one big group made every row after it unreachable in full. `ads[]` is never stripped or capped; `explain_serve` gives that group's detail.

`conflicts[]` surfaces config contradictions (`targets-and-excepts`, `whitelisted-cag-mismatch`,
`inert-ad-level-whitelist`), and stays open for more signals.

**Inert ad-level whitelists (`inertWhitelists` bucket).** An ad whose `params.zoneId` names a
zone its GROUP cannot reach is dead config: `filterAdgroups()` drops the group before
`filterAds()` is consulted, so the whitelist never fires while the UI reads as "this ad is
targeted here". Field-found on Adnet (`xvret6`) 2026-08-04 — 18 ads across 8 groups, 6 of them
live, from a Facebook-zone carve-out rolled out on the ads while the parent groups were never
scoped to `upd39v`. These groups were previously **dropped from every bucket**, so the defect
was invisible to the tools that exist to find it. `zoneEligibility` now returns a fourth
bucket for them (any excluded cause now, params included, except a default-only block, which goes to `excludedByDefault`) and `offerEligibility` sets `conflicts: ['inert-ad-level-whitelist']`;
`offerRollup` counts `inertWhitelisted` + `inertWhitelistedAdIds[]`, and the summary totals
`inertWhitelistGroups` / `inertWhitelistOffers`. Nothing in the bucket serves, and it is
disjoint from `directlyTargeted`/`conflicting` by construction (an inert group is neither
ad-group-whitelisted nor eligible), so the reconciliation invariant is untouched.

**`scoped_via` is one shared enum** (`SCOPED_VIA` in `tools/eligibility.js`) across every
tool that emits the field — `ad-group-whitelist`, `ad-group-blacklist`, `ad-level-whitelist`,
`ad-level-blacklist`, `zone-selection`. The group-grain rollup in `zoneInventoryTools` was
missing `ad-group-blacklist`; same field name over two domains is a trap for a consumer
reading the tools together. `Eligibility.via` is a *different, narrower* field (why the group
is eligible: whitelist / CAG) and deliberately stays at two values.

**`get_zone_eligible_ad_groups` pages, it does not degrade.** An eligibility row is ~560
chars (the inventory row plus `eligible`/`via`/`reasons`/`conflicts`/`offers`), so the
review fixture — 83 targeted + 124 free radicals — is ~118k against a 30k guard; even a
single-bucket, names-omitted response is ~48k. Shedding row bodies (the old behavior) threw
away the offer payload that is the entire reason to call the tool. `fitEligibility`
(exported, tested in `src/tests/eligibilityFit.test.ts`) instead returns FULL rows and pages:
`bucket` (`all` | `directlyTargeted` | `freeRadicals` | `conflicting` | `inertWhitelists` | `excludedByDefault`, paged in that order) narrows the rows,
`offset` walks them, and the response carries `page: { bucket, offset, returned, total,
next_offset? }` plus `complete`. Paging runs over one flat list (the selected buckets
concatenated in fixed order) so `offset` is unambiguous even for `bucket:'all'`. `complete` is
absolute, not offset-relative — true only when the one response holds the entire selected
slice (`offset === 0 && next_offset === undefined`); an offset-relative flag would say
`complete:true` on a tail page holding 37 of 207 rows, and a reconciliation check against
`summary` would then read as a regression. `summary` is
always exact over the whole set regardless of `bucket`/`offset` — with `bucket:'all'` and
`complete:true` the arrays match the summary counts one-for-one (`freeRadicals` = `freeRadicalHosts + freeRadicalHostsConditional`). Only a single row larger
than the whole budget falls back to a stub for that row + `complete:false`, paging on past it. `complete:false` (not
`truncated`) is the family-wide "not the whole answer" flag, matching `fitZoneInventory`.

### Zone Tier Analysis
- `get_analysis` — `GET /api/analysis/{id}`. The poll target — no polling tool exists here by design (that would be orchestration). Returns `header\n\ncompact JSON`, same channel as `get_zone_targeting_inventory`. `queued`/`running` docs carry no `input`/`output` at all and get a `note` telling the caller to poll again — the most common shape, not an edge case.
- `list_analyses` — `GET /api/analysis`. Newest-first, **cursor-paged not offset-paged** (`cursor` = the `_id` of the last row; `next_cursor` returned on a full page). Summary fields only.

`fitAnalysis` (exported, unit-tested in `src/tests/analysisFit.test.ts`) always drops `output.rawResponse` and `input.prompt`, then sheds input sections in a fixed order — `rankDistribution` → `zoneMetrics` → the ranked-optimization context (duplicated into `output.json` by the API's finalize step) → the non-monetizing/default-tier lists → `localTiers` last, since that peer comparison is what carries the narrative. Whatever it drops lands in an `omitted[]` array, and `output.json` (the tier verdict) is never shed: a silently partial tier table is one the model completes with invented rows.

### Audit log
- `get_user_actions` — `GET /api/networks/{network_id}/user-actions`. Who created,
  cloned, updated, archived, unarchived, moved or reassigned an entity, and when —
  the question `explain_serve` cannot answer (it knows a group is disabled, never
  who disabled it). Filters `type` / `model` / `user` / `dateStart` / `dateEnd` are
  the endpoint's own; **`entityId` is applied server-side** (upstream has no
  entity filter), the same shape as `report_query`'s `filter` and for the same
  reason — otherwise "who turned THIS ad group off" means paging a network's whole
  log through context.
  - The network is in the **PATH**, not the `?networkId` query param, so this is
    the one read where the tool's `network_id` argument is interpolated into the
    URL instead of being handed to `workApiRequest` as `options.networkId` —
    passing it there would be a silent no-op (`needsNetworkIdInQuery` matches
    exact list paths only). The argument is still required and still the only
    source of scope, same as every other business tool.
  - Rows are requested with `fields: ['*']` by default: the standard projection
    keeps `{ id, name }` + status fields and an action row has none of them, so
    the default would return near-empty rows that read as "no data".
  - **Entity grain, not field grain.** An `update` row does not say which field
    changed or its previous value. The caveat is in the tool description AND in
    the response (`grain`), because the model reads the response — `type: update`
    next to a delivery drop is exactly the row it would otherwise present as a
    cause. This is why #7 stays blocked: it needs field grain or a versions
    endpoint, and this is neither.
  - **Four upstream shapes, each of which fails by returning nothing.** An empty
    change log reads as "nobody touched it", so none of these may be left to
    chance (all verified against `lincx-core`'s `server/user-actions.js` and
    `server/endpoints/user-actions/index.js`; the MCP's tests mock the Work API,
    so they pin our end of the contract only):
    - `model` matches the STORED value, which is `_.camelCase(model.name)`
      filtered by an exact `_.isMatch` — `'AdGroup'` against a stored `'adGroup'`
      is `false` with no error. Hence `ACTION_MODELS`, a closed `z.enum` of the 17
      camelCased model names: a rejected argument is recoverable, an empty audit
      log is not. Add to it when lincx-core adds a tracked model.
    - both dates are ajv `format: 'date-time'` — a bare `2026-08-01` is a 422.
      `toDateTime()` normalises, **asymmetrically**: the upstream range is
      `_id: { $gte: key(dateStart), $lt: key(dateEnd) }`, an EXCLUSIVE end, so a
      bare end date expands to the FOLLOWING midnight or the whole of the day you
      asked about drops out. Both bounds are then folded to `Z`, because upstream
      compares them with `>` — a lexicographic string compare that a mixed
      `+02:00`/`Z` pair can trip.
    - with no dates upstream defaults the window to the **last 14 days**, so a
      group archived three weeks ago returns `total: 0`. `resolveWindow()`
      resolves and SENDS the window instead, and the envelope echoes it as
      `window: { dateStart, dateEnd, defaulted }` — the exact bounds the answer
      covers, not a re-derivation. The default start is anchored to the **end**,
      not to now: upstream's now-anchored default 422s ("dateStart should be
      earlier then dateEnd") on a `dateEnd` older than two weeks, a reasonable
      request with no business failing.
    - rows arrive **oldest first** (ascending `_id`, which is time order), which
      puts "who just turned this off" on the last page of a busy network.
      `newestFirst()` sorts on `timestamp` — same one line as `.reverse()`, minus
      the dependency on Mongo's ordering — and it also makes
      `listEnvelopeToText`'s truncation shed the oldest rows rather than the ones
      being asked about.
  - `_id` is a pathkey (`networkId-eventId\xff<networkId>\xff<eventId>`) and
    upstream stores no `eventId` field. `withEventId()` trades one for the other:
    passed through, `_id` duplicates two fields the row already has and puts a raw
    `\xff` in the response; dropped outright, it takes the only per-event
    identifier with it.

### Advertisers (M3)
- `list_advertisers` — `GET /api/advertisers` (paginated)
- `get_advertiser` — `GET /api/advertisers/{id}`

### Experiences (M3)
- `list_experiences` — `GET /api/experiences` (paginated); filter by `publisherId`/`channelId`/`siteId`
- `get_experience` — `GET /api/experiences/{id}`

---

## No usage analytics

There is deliberately **no** `/stats` route, no `usage:events` log and no
`UsageEvent` recording. It was removed (#32): the only consumer was adoption
tracking, it stored `user_id`/`email` in an untrimmed Redis list with no TTL, and
without Redis it is wiped on every deploy anyway. Do not add per-call telemetry
back here — `toolGuard` already logs one JSON line per call to **stderr** (tool
name, duration, response chars, param KEYS, status), which is what the platform's
log sink is for.

---

## Deployment

No build step and no container: the platform runs `npm ci --omit=dev`, starts
`node src/index.js`, sets `PORT`, and health-checks `/health`. A
TLS-terminating proxy must sit in front and overwrite `X-Forwarded-For`.
Config splits two ways — committed platform config for non-secret vars and the
platform's secret store for `WRAPPING_KEY`; `.env` is local dev only.
`PUBLIC_BASE_URL` must equal the URL clients actually hit. Users get one URL —
`https://<your-domain>/mcp`.

Two facts that constrain code changes:
- **Stateless transport — nothing lives in the process.** `createTransport()` in
  `src/server.js` sets `sessionIdGenerator: undefined` and builds a fresh
  transport + `McpServer` **per request**, closed on `res.close`. The SDK refuses
  to reuse a stateless transport (message-id collisions between clients), so it
  must never be hoisted or cached. Consequences to keep in mind:
  - No MCP session id is minted, read or sent. A client's stale `mcp-session-id`
    header is ignored rather than answered with a 400 re-initialize — that is what
    makes a redeploy invisible to connected clients.
  - Identity comes from the OAuth bearer: `resolveLincxSession(extra)` reads
    `extra.requestInfo.headers.authorization`, unwraps the sealed token (local
    AES-GCM — no store lookup) and memoises the auth context on `extra`, so a
    second resolve in the same request is free.
  - **Neither `GET` nor `DELETE` is registered on `/mcp`** — the router answers
    405, the one status the SDK client tolerates for both. GET only ever served
    the standalone SSE stream, which stateless mode cannot hold open
    (`enableJsonResponse: true` means POST answers with JSON). 405 on DELETE is
    the spec's "server does not allow clients to terminate sessions", now
    literally true. Do not make DELETE a 200: that is a success status on a
    security operation that revokes nothing. Logging out is `auth_logout`.
  - **`/mcp` is rate limited in two tiers, and it must stay two.** A pre-auth
    tier keyed by client address (600/min) runs first and bounds what an
    unauthenticated caller can force; a per-account tier keyed by the resolved
    **`user_id`** (120/min) runs after the bearer resolves. One tier is not enough
    in either direction: keyed only by address, claude.ai's shared egress puts
    every user in one bucket; keyed only by the bearer, an attacker mints a fresh
    bucket per request *before* auth and the key Map grows without bound. Never
    key on the raw `Authorization` header — `Bearer x` and `bearer  x` are the
    same user to the parser and different buckets to a hash. Never key on the
    **session id** either: a fresh UUID per login means N logins buy N × the
    limit. Four things hold this together, each with a test:
    - a tier-2 rejection **refunds** its tier-1 slot, or one user hitting their
      own cap burns the address budget everyone behind that egress shares
    - the 429 still carries `WWW-Authenticate`, or a rate-limited newcomer can
      never reach OAuth discovery — the same failure that got a query-param
      access gate rejected (see the next bullet)
    - budget is charged **per JSON-RPC message**, not per HTTP request, and
      batches are capped at `MCP_MAX_BATCH`: the transport executes every message
      in an array, so one POST once ran 500 tool calls against a budget of 1
    - the key ceiling **rejects new keys** rather than clearing the map; clearing
      wiped the flooder's own exhausted bucket and doubled what got served
  - **`clientIp()` is a trust boundary, not a logging convenience.** It keys the
    limiter above and the brute-force guard on `POST /api/login`, and
    `X-Forwarded-For` is client-supplied unless a proxy overwrites it. The
    deployment fronts the app and does overwrite it, which is why
    `TRUSTED_PROXY_HOPS` defaults to 1 — but a deployment that exposes the
    process directly MUST set it to 0 or every rate limit becomes decorative
    (measured: 700/700 served against a 600 cap by rotating the header). The
    opposite error is unmeasured: more proxies in front than configured collapses
    every caller into one bucket.
  - **`/oauth/*` is deliberately single-tier**, one per-address bucket per
    endpoint (`register` 10/min, `token` 600/min, `authorize` 120/min). No second
    tier is possible *at the gate*: `client_id`, the auth code and the refresh
    token are all caller-supplied and unvalidated when the limiter runs, so keying
    on them is the same bypass as keying on the bearer. Separate buckets are what
    stops a DCR flood from 429ing token refresh and the login page for everyone
    behind one shared egress, and `token` matches `mcpIpLimiter`'s order of
    magnitude because it sits on that same claude.ai egress. **One exception, not
    yet built:** the `/oauth/token` refresh branch resolves a server-minted
    `record.lincx_session_id` mid-handler (`refreshTokens()`), which is exactly
    where `mcpUserLimiter` sits on `/mcp` — a post-validation tier IS possible
    there. Until it exists, 600/min is also the per-caller ceiling on refresh
    rotation, and rotation does not revoke the access tokens it supersedes
    (measured: 26 rotations, 26 distinct access tokens, all live; at 600/min and a
    3600s access TTL that is ~36k live tokens per caller, against ~1.8k under the
    old shared 30/min).
  - Running more than one instance is not a correctness problem (the transport
    is stateless) — but the rate limiter counts in-process, so N instances
    silently means N × the per-caller limits.
- **No auth gate in front of `/mcp`.** OAuth 2.1 (DCR + PKCE) is the sole identity
  layer — `/mcp` must be able to answer `401 WWW-Authenticate: Bearer
  resource_metadata=...` to unauthenticated callers. A query-param "access key" gate
  is intentionally NOT used: it suppresses the RFC-9728 challenge and is dropped by
  some clients between the discovery probe and post-OAuth calls. To kill access
  deploy-wide, stop the app or rotate `WRAPPING_KEY` (invalidates every token).

---

## Known issues and open work

### Login 401 — resolved
The earlier `ix-id.lincx.la/auth/login` 401 no longer reproduces; field testing
authenticated cleanly end-to-end (OAuth dance + Work API calls). Left here only as
a pointer: if it resurfaces, add temporary request/response logging in
`services/auth.js` (log status + `err.response?.data`, never the password/token)
and diff against the web app's login request in DevTools.

### Response size — access persistence & the guard (field-test Qs)
- **Do sessions survive redeploys?** Yes — trivially. Tokens are self-contained
  sealed payloads; any instance with the same `WRAPPING_KEY` can open them, so
  access outlives redeploys, restarts, and instance swaps. Only rotating
  `WRAPPING_KEY` drops access (there is no per-token revocation — `auth_logout`
  is client-side only).
- **Is the 30k guard hard or tunable?** Tunable via `RESPONSE_SIZE_LIMIT` (see the
  env table). The intended path for a legitimately large pull is server-side
  narrowing, not a bigger dump: `report_query` `filter` + `groupBy` aggregation
  (and `groupsTruncated`/`rawTruncated` when still large), and the list tools'
  `fields` selection + `limit`/`offset` paging with `next_offset`.

### An outputSchema'd tool's error message reached the user as -32602 — fixed
`report_query` is the only tool with an `outputSchema`, and the SDK's
`validateToolOutput` throws `Output validation error: … has an output schema but no
structured content was provided` for any result that carries neither
`structuredContent` nor `isError`. Every error return in the tool is a plain text
message, so *every* failure — missing `hour` for a timezone, a nonexistent set id,
an expired session — surfaced as that protocol error instead of its reason: a
misconfigured report read as a broken connector. `isError: true` is the SDK's own
opt-out, and `installToolGuards` now sets it on any schema'd result that has no
`structuredContent` (the SDK's own condition, not a message sniff, so it holds for
future `outputSchema` tools). Do NOT fix this by adding `isError` at each return
site in a tool — the guard is the one place every handler routes through.

The corollary is on the tool side: under a schema'd tool, **a correct empty answer
must be a payload, not a message.** `report_query`'s "no rows matched filter" used to
return a bare text return, so the guard had to flag it `isError` — a zero that read
as a failed call, while the *same* zero from an empty upstream came back a success
(same answer, two verdicts; clients render `isError` as a failure, so the model
retries instead of reporting "$0"). It now falls through with `rows: []` and returns
the normal structured zero (`rowsScanned: 0`, `total: {}`, `rowsFetched` intact),
carrying the value hints in an optional `note` — which rides in the `content` text
too (raw mode appends it to its header), since hosts feed only `content` to the
model. The guard firing at all now means a tool bug, so it logs a line to stderr,
and it runs **before** `logMetrics` — flagging after the log made that call record
`status: ok` while the client was handed an error.

### List paging never stalls on one oversized row — fixed
`listEnvelopeToText` drops trailing items to fit `CHARACTER_LIMIT`. A single row larger
than the whole budget (field-found: ad group `ducqqp`, 232KB of `params.zoneId`) emptied
`kept`, so `next_offset = offset + 0 = offset` and the documented "page until `next_offset`
is absent" walk looped forever — every row past the poison one unreachable. It now returns
an `{ id, _omitted }` stub for that row, sets `truncated.returned: 0` +
`truncated.skipped_oversized: <id>`, and advances `next_offset` by 1. Pinned in
`src/tests/listEnvelope.test.ts` (including a walk-terminates test over an all-poison
collection). The list family keeps `truncated`/`has_more`/`next_offset` as its contract —
`complete` is the zone-composite family's flag, where there is no cursor to page with.

### `fields` takes dotted paths; a wrong path is reported, not silent — fixed
`fields: ['params.zoneId']` used to match nothing and return no error: rows came back
looking clean with the data absent, and there was no way to shrink a page below the
parent object. Paths now resolve segment-by-segment and project the leaf under its
dotted key (`{"params.zoneId": [...]}`), and any requested field matching zero rows on
the page comes back in the envelope's `unknown_fields`. This is what makes a
whole-network sweep affordable on a collection holding a runaway array.

`fitEntityToText` also elides large ARRAYS, not just large strings. An entity whose bulk
is 20k short strings (`ducqqp`, 232KB of `params.zoneId`) had no string leaf big enough
to shed, so the caller previously got a bare `_truncated` note with no entity data at
all; the array is now shed as a unit (`[elided: N items, M chars]`) and every other
field survives.

### Network response shape — confirmed
`GET /api/networks` returns `{ data: [...] }`, each network carrying an `archived`
boolean (absent when active — upstream deletes the flag on unarchive). `getAll`
returns active + archived together, so `network_list`/`auth_status` filter to
active by default (`includeArchived` to opt in) and page with `limit`/`offset`.
`networkService.js` still accepts the other tolerant shapes; harmless, low priority.

### Token expiry handling
authentic-server JWTs expire after ~30 days. `validateSession()` decodes the JWT's
`exp` claim (`isJwtExpired` in `services/auth.js` — an unverified read; the Work API
still verifies the signature) and short-circuits with a clear "session has expired,
use 'auth_login'" prompt before any Work API call, instead of letting every tool 401.
It fails open when `exp` is unreadable. Re-login is still manual (no auto-refresh of
the Lincx JWT — and no OAuth refresh tokens; the client re-authenticates).

---

## JavaScript conventions

Plain ESM JavaScript — no TypeScript, no build step. `npm run lint` (`standard`)
is what replaced the compiler; run it before you commit. Tests run on `ava`
(`npm test`) — one process per test FILE, but tests *within* a file run
concurrently, so anything sharing a module-level store or a global is
`test.serial`.

- All imports keep the `.js` extension — ESM does not resolve extensionless paths
- Tool handlers always return `{ content: [{ type: "text", text }], structuredContent? }`
- `z.object({}).strict()` on all tool input schemas to reject unexpected params.
  zod is a **protocol** dependency (the MCP SDK needs runtime schemas), not a
  leftover of the TypeScript era — do not remove it
- `camelcase` is disabled per-file where OAuth params and Work API / tool-output
  fields are snake_case: those names are on the wire, not a style choice
- `src/http/` owns everything Express used to do — `respond.js` (json/html/redirect),
  `request.js` (query/header/clientIp/readBody, incl. the 100kb limit), `router.js`
  (the route table). Never write to `res` directly in a route; use the helpers, which
  no-op once `headersSent`
