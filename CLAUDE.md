# CLAUDE.md — lincx-mcp-server

This is the working context for Claude Code on this project.
Read this fully before making any changes.

---

## What this project is

An MCP (Model Context Protocol) server that gives Claude access to the Lincx / Interlincx platform.
It handles authentication, multi-network context, and exposes business tools as MCP tools.

The server is **HTTP-only** — there is no stdio transport. Everything runs on a
single Express server on `PORT` (5001 dev default, 3000 in production via
`docker-compose.yml`):
- the MCP Streamable HTTP transport at `POST|GET|DELETE /mcp`
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
├── index.ts                  # Entry point — MCP server + Express login UI + HTML templates
├── types.ts                  # All shared TypeScript interfaces (Session, Network, etc.)
├── constants.ts              # Env vars with defaults — edit here first before touching logic
│
├── services/
│   ├── auth.ts               # loginWithCredentials() → POST ix-id.lincx.la/auth/login
│   ├── sessionStore.ts       # Redis (with in-memory fallback) — session persistence
│   ├── sessionManager.ts     # create / validate / switchNetwork / refreshNetworks / destroy
│   ├── networkService.ts     # fetchUserNetworks() → GET WORK_API_BASE_URL/api/networks
│   └── workApi.ts            # workApiRequest() — injects Bearer token + ?networkId on every call
│
└── tools/
    ├── authTools.ts          # auth_login, auth_status, auth_logout
    ├── networkTools.ts       # network_list, network_switch, network_refresh
    ├── _shared.ts            # paginationShape / includeShape / READONLY_ANNOTATIONS + getEntityWithIncludes — reuse these in new tools
    ├── resources.ts          # MCP Resources: lincx://networks + lincx://{entity}/{id} templates
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

### Claude never controls auth or network context
- `auth_token` — stored in session server-side only, never returned to Claude
- `networkId` — always injected from `session.active_network` inside `workApiRequest()`, never accepted as a tool parameter
- `session_id` — stored in Redis (keyed by MCP session id), never exposed via any tool. In multi-tenant deploys, session identity comes from `extra.sessionId` (the MCP transport session id) — never from a module-global.

### Business tools never accept networkId
Every business tool must get network context from the session, not from Claude.
```ts
// WRONG — never do this
inputSchema: z.object({ networkId: z.string(), ... })

// RIGHT — network comes from session automatically
const data = await workApiRequest(session, "GET", "/api/your-endpoint", { params: { ... } });
// → GET /api/your-endpoint?networkId=svce6t&...
```

### Always validate session before any API call
Every business tool must call `validateSession(sessionId)` before touching the Work API.
It checks: session exists → active_network is set → active_network is in session.networks.

### Never log OAuth tokens
Access tokens, refresh tokens, and auth codes are bearer credentials. Never log
them in full — at most log the first 8 chars or a SHA hash. Same applies to the
Lincx JWT (`auth_token`).

---

## Multi-tenancy model

All Work API requests are scoped by `?networkId=<id>` query param.
There is no separate Network Service — networks are fetched from `WORK_API_BASE_URL/api/networks`.

Example request shape:
```
GET /api/creative-asset-groups?networkId=svce6t
GET /api/projects?networkId=svce6t&limit=20&offset=0
POST /api/campaigns?networkId=svce6t
```

`workApiRequest()` in `services/workApi.ts` handles this automatically — always use it, never call axios directly in tools.

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

5. Server stores pending auth-request, redirects browser to /login?req=<request_id>
6. User submits email+password to POST /api/login?req=<request_id>
7. Server: loginWithCredentials() → createSession() → issueAuthCode()
   → JSON { success: true, redirect: "<redirect_uri>?code=...&state=..." }
   Browser navigates to redirect.

8. Client → POST /oauth/token { grant_type: "authorization_code", code, code_verifier, ... }
   ← { access_token, refresh_token, token_type: "Bearer", expires_in: 3600 }

9. Client → POST /mcp with Authorization: Bearer <access_token> → resolves to Lincx session
10. After expiry: POST /oauth/token { grant_type: "refresh_token", refresh_token, client_id }
    Refresh tokens rotate — old refresh becomes invalid.
```

Identity server: `https://ix-id.lincx.la` (authentic-server) — unchanged.
Login endpoint: `POST /auth/login` with body `{ email, password }`.
Response shape: `{ success: boolean, data: { authToken: string } }`.
Token type: JWT (Lincx), ~30 day expiry. The OAuth access token is opaque
(32-byte hex), 1 hour TTL. The Lincx JWT lives only in `Session.auth_token`
server-side; clients only ever see the OAuth tokens.

**Two-token architecture:** OAuth tokens identify the MCP session; the Lincx
JWT authorizes Work API calls. They meet in Redis: `oauth:access:<token>` →
`{ lincx_session_id }` → `lincx:session:<id>` → `{ auth_token, ... }`.

---

## Session model

```ts
interface Session {
  session_id: string;       // UUID, lives in process memory only
  user_id: string;          // decoded from JWT sub/user_id/email field
  email: string;
  auth_token: string;       // Lincx JWT — injected as Bearer on every API call
  networks: Network[];      // fetched from /api/networks at login
  active_network: string | null;  // short ID like "svce6t" — appended as ?networkId
}
```

Session store: Redis when `REDIS_URL` is set, in-memory Map otherwise.
In-memory sessions are lost on server restart — Redis is required in production.

TTLs:
- `lincx:session:<uuid>` — 7 days (Lincx session, holds the JWT)
- `mcp:session:<id>` — 7 days (transport-id → lincx-session-id, refreshed on each authenticated request)
- `oauth:client:<id>` — 90 days (DCR-registered MCP clients)
- `oauth:pending:<request_id>` — 10 min (in-flight authorize requests)
- `oauth:code:<code>` — 60 sec (single-use auth codes)
- `oauth:access:<token>` — 1 hour
- `oauth:refresh:<token>` — 30 days (rotated on every refresh)

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WORK_API_BASE_URL` | Yes | `http://localhost:3050` | Work API — all requests go here |
| `IDENTITY_SERVER` | No | `https://ix-id.lincx.la` | Lincx auth server |
| `PORT` | No | `5001` | Express HTTP port (login UI + MCP over HTTP) |
| `REDIS_URL` | No | `` (empty) | Redis for persistent sessions — required in production. `npm run dev` points this at a Dockerized Redis it starts automatically |
| `NODE_ENV` | No | `development` | Set to `production` to disable the `/dev/*` debug routes |
| `PUBLIC_BASE_URL` | No | `http://localhost:<PORT>` | Used when building browser login URLs returned to Claude |
| `RESPONSE_SIZE_LIMIT` | No | `30000` | Hard per-response character ceiling enforced by `toolGuard`. Raise if your client tolerates larger tool results; floored at 5k. The soft serializer budget (`CHARACTER_LIMIT`) derives from it (−5k) |

There is no `NETWORK_API_BASE_URL` — networks come from `WORK_API_BASE_URL/api/networks`.

---

## Build and run

```bash
npm install          # first time only
npm run build        # compile TS → dist/ — required after every source change
npm start            # run the compiled server (node dist/index.js) on PORT
npm run dev          # cloudflared tunnel + tsx watch (see below)
npm run dev:local    # tsx watch only — no tunnel, http://localhost:5001
```

**`npm run dev`** (`scripts/dev-tunnel.mjs`) starts a Cloudflare quick tunnel,
captures the generated `https://<random>.trycloudflare.com` URL, then boots the
watch server with `PUBLIC_BASE_URL` set to it and prints a banner with the
`<url>/mcp` to paste into a Claude Desktop / claude.ai connector (those require
https, so a tunnel is needed for local connector use). Requires `cloudflared`
(`brew install cloudflared`). Use **`npm run dev:local`** for plain local work
(e.g. connecting via `mcp-remote`, which accepts `http://localhost`).

Both run a `predev` hook (`docker compose up -d redis`) that brings up the bundled
Redis on `localhost:6379` so the dev server always has persistent sessions. This
requires Docker; if it isn't running the hook is a non-blocking no-op. To use the
in-memory store instead, blank `REDIS_URL` in `.env`. Stop the dev Redis with
`npm run redis:stop`.

---

## Connecting an MCP client

The server is HTTP-only, so clients connect by URL — there is no stdio command form.

- **Production (Coolify):** point the client at `https://<your-coolify-domain>/mcp`.
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

1. Create `src/tools/yourDomainTools.ts`
2. Follow this pattern:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded } from "../services/workApi.js";

export function registerYourDomainTools(server: McpServer): void {
  server.registerTool("your_tool_name", {
    title: "Human Readable Name",
    description: `Clear description of what this does and what it returns.`,
    inputSchema: z.object({
      // never include networkId here
      limit: z.number().int().min(1).max(100).default(20),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit }, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<YourResponseType>(v.session, "GET", "/api/your-endpoint", { params: { limit } });
      return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
```

3. Register it in `src/index.ts`:
```ts
import { registerYourDomainTools } from "./tools/yourDomainTools.js";
registerYourDomainTools(server);
```

4. Add the type to `src/types.ts` if needed
5. Run `npm run build`

---

## Implemented Tools

### Auth
- `auth_login` — returns browser login URL
- `auth_status` — check session state
- `auth_logout` — destroy session

### Networks
- `network_list` — list available networks (active only by default; `includeArchived`, `limit`/`offset` paging via `next_offset`)
- `network_switch` — change active network
- `network_refresh` — re-fetch networks from API

### Resources (MCP Resources, `src/tools/resources.ts`)
Pull-based reference data — read by URI, not via a tool call. Not part of the
per-request tool schema, so they cost nothing per turn.
- `lincx://networks` — networks the session can access + the active one (the `network_list` tool stays as the discovery surface)
- `lincx://{entity}/{id}` — resource templates mirroring `get_<entity>` for all 13 entity types (campaign, zone, ad, ad-group, creative, template, channel, site, publisher, advertiser, experience, creative-asset-group, dimension-set). Templates aren't listed in `resources/list` (no per-request cost); they let clients reference/cache entities.

Deliberately NOT resources: dimension sets / event-stats keys stay as tools — they're inputs to `report_query` and the model discovers them more reliably via a planned tool call.

### Templates (M1)
- `list_templates` — `GET /api/templates` (paginated, limit/offset); filter by `publisherId`
- `get_template` — `GET /api/templates/{id}` — includes HTML + CSS source; `include: ['parents']` adds parent hierarchy
- `get_template_versions` — `GET /api/templates/{id}/versions`
- `get_template_version` — `GET /api/templates/{id}/versions/{version}`

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
- `report_query` — `GET /api/reports/{dimensionSetId}` with required date range. The upstream API always returns hourly-granular rows; this tool **aggregates server-side** and returns compact rolled-up sums (grand total by default, or grouped by `groupBy` e.g. `['zone']` / `['zone','date']`). `raw: true` returns the unaggregated rows. `filter` (e.g. `{ advertiser: 'Acme' }`) scopes the report to one entity — the upstream endpoint has NO entity filter (scoped only by the dimension set's networkId), so filtering is applied server-side over the fetched rows (`filterReportRows`), which is what keeps a per-offer/hourly pull under the size guard. Filter keys are auto-added to `d`; a key absent from every row errors (not a dimension of the set) rather than silently returning zero. `timezone` (IANA, e.g. `America/Denver`) buckets date/hour in local time — upstream is UTC-only, so the tool fetches ±1 UTC day of padding, rebuckets each hourly row via `Intl` (DST-correct), then trims to the requested local range (`rebucketRowsToTimezone`/`shiftUtcDate`). Matters: one advertiser's daily revenue swung 19% UTC vs Mountain. When grouped output would still overflow, the `groups` array is capped to the top-ranked groups (by loads/revenue) with a `groupsTruncated` note (`capGroups`) — graceful degradation like the list tools' `next_offset`, never a hard guard error. The hard ceiling is `RESPONSE_SIZE_LIMIT` (env-tunable, default 30k). Server-side rollup keeps a week of data (hundreds of rows) under the response-size limit instead of truncating — the pattern to follow for any high-volume endpoint.

### Zone Inventory (composite)
- `get_zone_targeting_inventory` — composite: which ad groups are DIRECTLY targeted to a zone (via `params.zoneId`) and whether each is fully live (campaign + ad group + a live ad with a viable, non-archived creative), or where it's off. Scans the whole network's ad-groups/campaigns/ads/creatives **internally** (each list GET returns the full set — the MCP normally slices it client-side only to fit the LLM guard; internal calls bypass that) and returns only the compact matched rollup (`zone`, `summary`, `groups[]` with per-level flags + `off_reason`, `conflicting[]`, `scan`), size-capped like `report_query`. `exceptParams.zoneId` = exclusion (a group targeting AND excepting the zone is reported as `conflicting`). A level is "on" only if `enabled && !archived`; `has_live_viable_ad` is a per-ad conjunction. **Never drops ad groups** (the answer is exhaustive by contract): the full rollup rides in the `content` TEXT — a one-line header, a blank line, then compact JSON `{ zone, mode, summary, groups[], conflicting[], scan }`. It is NOT in `structuredContent`: MCP hosts (claude.ai included) feed only `content` to the model, so rows placed only in `structuredContent` are invisible — the model saw just the header. Text is the reliable channel (same as `report_query`); carrying the payload once (no `structuredContent` copy) also means the size guard counts it once, so more rows fit (83 rows ≈ 24k < 30k, full with names). If a mega-zone would still overflow, `fitZoneInventory` first sheds the optional `name` field (`namesOmitted:true`; ids+flags stay, ~105+ rows) and only as a last resort returns ids-only with `complete:false` and a "re-run with mode:'off'/'live'" instruction — never a silent partial. The **second sanctioned server-side composite** alongside `report_query` — the deliberate exception to the one-tool-≈-one-call rule, justified the same way (never dump a whole entity list into context). Each `groups[]` row also carries `scoped_via[]` — how the group is scoped to the zone: `ad-group-whitelist` (always — the selection criterion), `ad-level-whitelist` (an ad in the group also whitelists the zone), `ad-level-blacklist` (an ad excludes the zone via `ad.exceptParams.zoneId`), `zone-selection` (group shares the zone's `creativeAssetGroupId`). Annotate-only, group grain; the selected set is unchanged. Offer-grain (`ad group × ad`) scoping and free-radical counts live in `get_zone_eligible_ad_groups`.

### Zone eligibility join (composite)
The general eligibility primitive (`tools/eligibility.ts`, pure + network-agnostic): an ad group is **eligible** in a zone when it is **not archived** (archived = out of service), its `creativeAssetGroupId` matches the zone's, it is not blacklisted (`exceptParams.zoneId` = blacklist, the opposite of `params`, and always wins), and it is in scope — the group's `params.zoneId` names the zone OR it targets **zero** zones (open within its CAG → *free radical*, leaks in with no direct targeting). **Ad-level** `params`/`exceptParams` are a per-ad LAST check (`adServesInZone`): they decide WHICH ads serve within an eligible group — an ad blacklisting the zone is hidden while its siblings still serve — and gate `has_live_viable_ad` in the rollup; they are not a group-scoping mechanism (`filterAdgroups()` runs before `filterAds()` in the serving engine, so an ad-level whitelist can never rescue an ineligible group). One pure join, three thin reads (same whole-network scan, compact result in the content text):
- `get_zone_eligible_ad_groups` — zone → groups bucketed `directlyTargeted[]` (ad-group-whitelisted & not blacklisted — reconciles to the inventory tool's targeted set; config-broken-but-targeted groups stay here with `eligible:false` + `reasons`/`conflicts`, never dropped), `freeRadicals[]` (eligible via shared CAG only), `conflicting[]` (targets+excepts). Each row carries the live rollup (`fully_live`, `off_reason[]`, `scoped_via[]`) plus `eligible`, `via[]`, `reasons[]`, `conflicts[]`, `offers`.
- `get_ad_group_zone_reach` — group → every zone it can serve/leak into (the flip).
- `explain_serve` — (zone, adGroup|ad) pair → eligible? by what `via[]`? if not, `reasons[]` — the "why did X serve here" direction. With an `adId` it answers at the offer grain (`offer: { scoped_via[], freeRadical }`).

**Free radicals have two grains.** GROUP grain = the `freeRadicals[]` row set (`summary.freeRadicalGroups`): groups eligible only via the shared CAG. OFFER grain = `(ad group × ad)` pairs that serve *solely* via the CAG — untargeted ad **and** untargeted group, net of blacklists at both levels (`summary.freeRadicalOffers`, `offerEligibility`/`offerRollup` in `tools/eligibility.ts`). Group grain **over-counts the leak**: an untargeted group whose only ad is zone-whitelisted is 1 free-radical group but **0** free-radical offers — that ad renders because it is ad-level-TARGETED, not via the CAG. Every row carries `offers: { total, serving, freeRadical, adLevelTargeted, adLevelBlacklisted, confinedElsewhere, freeRadicalAdIds[] }` so a pure free-radical subset is derivable. The reconciliation invariant (`directlyTargeted + conflicting` = the inventory tool's targeted set) is untouched by this.

`conflicts[]` surfaces config contradictions (`targets-and-excepts`, `whitelisted-cag-mismatch`), reserved for more signals later.

**`scoped_via` is one shared enum** (`SCOPED_VIA` in `tools/eligibility.ts`) across every
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
`bucket` (`all` | `directlyTargeted` | `freeRadicals` | `conflicting`) narrows the rows,
`offset` walks them, and the response carries `page: { bucket, offset, returned, total,
next_offset? }` plus `complete`. Paging runs over one flat list (the selected buckets
concatenated in fixed order) so `offset` is unambiguous even for `bucket:'all'`. `complete` is
absolute, not offset-relative — true only when the one response holds the entire selected
slice (`offset === 0 && next_offset === undefined`); an offset-relative flag would say
`complete:true` on a tail page holding 37 of 207 rows, and a reconciliation check against
`summary` would then read as a regression. `summary` is
always exact over the whole set regardless of `bucket`/`offset` — with `bucket:'all'` and
`complete:true` the arrays match the summary counts one-for-one. Only a single row larger
than the whole budget falls back to ids-only + `complete:false`. `complete:false` (not
`truncated`) is the family-wide "not the whole answer" flag, matching `fitZoneInventory`.

### Zone Tier Analysis
- `create_analysis` — `POST /api/analysis`. Queues an async job (202 + QUEUED doc); `analysisType` is `offerTiering` (creative performance tiers) or `rankedOfferOptimization` (which creative belongs in which rank slot). **`noLLM` defaults to `true`** — the Work API's deterministic engine runs (aggregation → reliability-weighted CPM → waterfall rank collapse → percentile tier banding) and the narrative fields come back empty on purpose, for the *calling* agent to write. That is the split: the numbers are the platform's, the prose is the client's, and the analysis prompt lives in a skill (`lincx-analysis` in lincx-marketplace) where it can be iterated without redeploying this server. Pass `noLLM: false` to also get the server-side Gemini pass.
- `get_analysis` — `GET /api/analysis/{id}`. The poll target — no polling tool exists here by design (that would be orchestration). Returns `header\n\ncompact JSON`, same channel as `get_zone_targeting_inventory`. `queued`/`running` docs carry no `input`/`output` at all and get a `note` telling the caller to poll again — the most common shape, not an edge case.
- `list_analyses` — `GET /api/analysis`. Newest-first, **cursor-paged not offset-paged** (`cursor` = the `_id` of the last row; `next_cursor` returned on a full page). Summary fields only.

`fitAnalysis` (exported, unit-tested in `src/tests/analysisFit.test.ts`) always drops `output.rawResponse` and `input.prompt`, then sheds input sections in a fixed order — `rankDistribution` → `zoneMetrics` → the ranked-optimization context (duplicated into `output.json` by the API's finalize step) → the non-monetizing/default-tier lists → `localTiers` last, since that peer comparison is what carries the narrative. Whatever it drops lands in an `omitted[]` array, and `output.json` (the tier verdict) is never shed: a silently partial tier table is one the model completes with invented rows.

Two gotchas worth knowing before you touch these:
- **Access is allowlisted upstream** by email (`server/analysis-allowlist.js` in lincx-core), separate from network permissions. A 403 here is not a network-context problem.
- **`POST /api/analysis` derives `networkId` from the zone**, ignoring the injected query param, while `GET /api/analysis` *filters* by it. Creating an analysis for a zone outside the active network therefore succeeds and then never appears in `list_analyses` — `create_analysis` compares the two and returns a `note` when they diverge.

### Advertisers (M3)
- `list_advertisers` — `GET /api/advertisers` (paginated)
- `get_advertiser` — `GET /api/advertisers/{id}`

### Experiences (M3)
- `list_experiences` — `GET /api/experiences` (paginated); filter by `publisherId`/`channelId`/`siteId`
- `get_experience` — `GET /api/experiences/{id}`

---

## Usage analytics

Every tool call and resource read is recorded as one `UsageEvent` in a capped
log (`services/usageAnalytics.ts`) — Redis list `usage:events` (cap
`USAGE_EVENT_CAP`, default 50k) or an in-memory ring buffer when `REDIS_URL` is
unset. Recording happens in `toolGuard` (tools) and `resources.ts` (reads),
fire-and-forget and failure-isolated — analytics can never delay or break a call.

`GET /stats` (gated by the `STATS_TOKEN` env — accepted as `Authorization: Bearer
<token>` or a `?token=<token>` query param for browser access; 404 when unset)
returns tool health, per-user adoption, error friction, and usage sequences,
computed on read by `computeStats`. The `?token=` form leaks the secret into
history/logs/Referer — prefer the header and rotate the token if a URL leaks.

Privacy invariants: never store `auth_token`/OAuth tokens, never parameter VALUES
(keys only), never raw error messages (classified `error_kind` only). `user_id`/
`email` are stored for adoption analysis and only ever appear in the authenticated
`/stats` response — never in tool output.

---

## Deployment

Deployed via Coolify as a Docker Compose stack (`docker-compose.yml`) — the
`app` container plus a bundled `redis` service. Users get a single URL to paste
into their MCP client; the client handles the OAuth dance and stores tokens itself:

```
https://<your-coolify-domain>/mcp
```

OAuth 2.1 (Dynamic Client Registration + PKCE) is the sole identity layer. The
`/mcp` endpoint returns `401 WWW-Authenticate: Bearer resource_metadata=...`
on unauthenticated requests so any spec-conformant MCP client (Claude Desktop,
claude.ai, Claude Code) can discover and complete the OAuth dance.

A query-param "access key" gate is intentionally NOT used on `/mcp`: it
suppresses the RFC-9728 challenge response and is dropped by some clients
between the discovery probe and post-OAuth calls, which breaks browser-based
clients entirely. To kill access deploy-wide, stop the app in Coolify or rotate
Redis (invalidating every OAuth access/refresh token).

### How the compose file is wired

`docker-compose.yml` relies on Coolify's magic environment variables:
- `SERVICE_FQDN_APP_3000` — declaring this key makes Coolify generate a public
  domain for the `app` service and route the Traefik proxy to port 3000.
- `PUBLIC_BASE_URL=https://${SERVICE_FQDN_APP}` — the generated domain, forced to https.
- `SERVICE_PASSWORD_REDIS` — a random password Coolify generates once; shared
  between the Redis server and the app's `REDIS_URL` (`redis://default:…@redis:6379`).

Redis persists to a named volume (`redis-data`), so sessions survive restarts.

### One-time setup (Coolify UI)

1. New Resource → **Docker Compose** → point it at this Git repo (`docker-compose.yml`).
2. In **Environment Variables**, set `WORK_API_BASE_URL` (and optionally `IDENTITY_SERVER`).
   `NODE_ENV`, `PORT`, and `PUBLIC_BASE_URL` are already set in the compose file.
3. Enable **Auto Deploy** and add the generated webhook to the repo (GitHub →
   Settings → Webhooks). Pushes to `main` then redeploy automatically — no
   GitHub Actions workflow is needed or present.
4. Deploy. Coolify assigns the domain and provisions a TLS cert via its proxy.

### Subsequent deploys

Push to `main` — Coolify's webhook redeploys. Or click **Redeploy** in the UI.

### Inspect sessions

Use Coolify's container logs/terminal for the `redis` service, or with `REDIS_URL`
exported locally:

```bash
redis-cli -u "$REDIS_URL" keys "lincx:session:*" | wc -l
```

---

## Known issues and open work

### Login 401 — resolved
The earlier `ix-id.lincx.la/auth/login` 401 no longer reproduces; field testing
authenticated cleanly end-to-end (OAuth dance + Work API calls). Left here only as
a pointer: if it resurfaces, add temporary request/response logging in
`services/auth.ts` (log status + `err.response?.data`, never the password/token)
and diff against the web app's login request in DevTools.

### Response size — access persistence & the guard (field-test Qs)
- **Do sessions survive redeploys?** Yes. Redis persists to a named volume
  (`redis-data` in `docker-compose.yml`), so OAuth tokens + Lincx sessions outlive
  a Coolify redeploy — the connector stays authenticated across iterations. Only
  rotating Redis (or `auth_logout`) drops access.
- **Is the 30k guard hard or tunable?** Tunable via `RESPONSE_SIZE_LIMIT` (see the
  env table). The intended path for a legitimately large pull is server-side
  narrowing, not a bigger dump: `report_query` `filter` + `groupBy` aggregation
  (and `groupsTruncated`/`rawTruncated` when still large), and the list tools'
  `fields` selection + `limit`/`offset` paging with `next_offset`.

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
`networkService.ts` still accepts the other tolerant shapes; harmless, low priority.

### Token expiry handling
authentic-server JWTs expire after ~30 days. `validateSession()` decodes the JWT's
`exp` claim (`isJwtExpired` in `services/auth.ts` — an unverified read; the Work API
still verifies the signature) and short-circuits with a clear "session has expired,
use 'auth_login'" prompt before any Work API call, instead of letting every tool 401.
It fails open when `exp` is unreadable. Re-login is still manual (no auto-refresh of
the Lincx JWT — only the OAuth access token refreshes).

---

## TypeScript conventions

- All imports use `.js` extension (required for NodeNext ESM): `import { x } from "./module.js"`
- Strict mode is on — no implicit `any`, no unhandled nulls
- Tool handler return type is always `{ content: Array<{ type: "text", text: string }>, structuredContent?: ... }`
- `z.object({}).strict()` on all tool input schemas to reject unexpected params
- `as const` on all `type: "text"` literals in content arrays (MCP SDK requirement)