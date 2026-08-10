# lincx-mcp-server

MCP server for the Lincx / Interlincx platform — OAuth 2.1 + PKCE authentication, Redis-backed sessions, and multi-network support. Credentials never pass through Claude.

---

## Connecting from an MCP client

Add the server URL to your MCP client config:

```json
{
  "mcpServers": {
    "lincx": {
      "url": "https://<your-domain>/mcp"
    }
  }
}
```

The client handles authentication automatically:

1. Calls `/mcp` and receives `401 + WWW-Authenticate: Bearer resource_metadata=…`
2. Discovers OAuth endpoints from `/.well-known/oauth-authorization-server`
3. Registers itself via `POST /oauth/register` (Dynamic Client Registration)
4. Opens a browser to `/oauth/authorize` — you sign in with Lincx credentials
5. Exchanges the auth code at `/oauth/token` for access + refresh tokens
6. Sends `Authorization: Bearer <access_token>` on every `/mcp` call

Tokens are stored by your MCP client and survive desktop-app reloads — no re-auth on reconnect. Once signed in, run `network_list` → `network_switch` to pick a network.

---

## How it works

```
Client → POST /mcp (no auth)            ← 401 + WWW-Authenticate
Client → /.well-known/oauth-authorization-server   (discovery)
Client → POST /oauth/register                      (DCR)
Client → opens browser → GET /oauth/authorize?...&code_challenge=…
Server stores pending auth-request → redirects browser to /login
User submits credentials → server signs into Lincx → issues auth code
Browser navigates to redirect_uri?code=…&state=…
Client → POST /oauth/token (with code_verifier)    ← access_token, refresh_token
Client → POST /mcp + Authorization: Bearer …       (all subsequent calls)
```

Two unrelated tokens identify a user: the OAuth access token (sent by the
client on every `/mcp` request) and the Lincx JWT (server-side only, used by
`workApiRequest`). They meet in Redis: `oauth:access:<token>` →
`lincx_session_id` → Lincx session.

Multi-tenancy is handled by appending `?networkId=<id>` to every Work API request. The `networkId` is always injected server-side from the active session — Claude never controls it directly.

---

## Project structure

```
src/
├── index.ts                     # Entry point: MCP server + Express login UI
├── types.ts                     # Shared TypeScript types
├── constants.ts                 # Env vars with defaults
│
├── services/
│   ├── auth.ts                  # loginWithCredentials() → identity server
│   ├── sessionStore.ts          # Redis (or in-memory) session persistence
│   ├── sessionManager.ts        # create / validate / switch / destroy sessions
│   ├── networkService.ts        # fetchUserNetworks() from /api/networks
│   └── workApi.ts               # Authenticated HTTP client (?networkId injected on every call)
│
└── tools/
    ├── authTools.ts             # auth_login, auth_status, auth_logout
    ├── networkTools.ts          # network_list, network_switch, network_refresh
    ├── templateTools.ts         # list_templates, get_template, get_template_versions, get_template_version, get_template_parents, render_template
    ├── creativeAssetGroupTools.ts # list_creative_asset_groups, get_creative_asset_group
    ├── zoneTools.ts             # list_zones, get_zone, get_zone_parents, get_zone_report, zone_load_trace
    ├── adTools.ts               # list_ads, get_ad, get_ad_parents, get_zone_ads
    ├── adGroupTools.ts          # list_ad_groups, get_ad_group, get_ad_group_parents
    ├── creativeTools.ts         # list_creatives, get_creative, get_creative_parents
    ├── campaignTools.ts         # list_campaigns, get_campaign, get_campaign_parents
    ├── channelTools.ts          # list_channels, get_channel, get_channel_parents
    ├── siteTools.ts             # list_sites, get_site, get_site_parents
    ├── publisherTools.ts        # list_publishers, get_publisher
    ├── reportingTools.ts        # list_dimension_sets, get_dimension_set, get_event_stats_keys, report_query
    ├── advertiserTools.ts       # list_advertisers, get_advertiser
    └── experienceTools.ts       # list_experiences, get_experience
```

---

## Prerequisites

- **Node.js 18+** — check with `node --version`
- **npm 9+** — check with `npm --version`
- **Redis** (optional) — for persistent sessions across server restarts. Without it, sessions live in memory and are lost on restart.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file in the project root:

```env
# Required — base URL for all Work API calls (networks, templates, zones, etc.)
WORK_API_BASE_URL=https://your-work-api.example.com

# Optional — Lincx identity server (defaults shown)
IDENTITY_SERVER=https://your-identity-server.example.com

# Optional — port for the login UI + MCP /mcp endpoint (default: 5001)
PORT=5001

# Optional — Redis connection URL. `npm run dev` starts a Dockerized Redis and
# points here automatically. Omit to use in-memory sessions (lost on restart).
REDIS_URL=redis://default:localdev@localhost:6379
```

> **Note:** There is no `NETWORK_API_BASE_URL`. Networks are fetched from `WORK_API_BASE_URL/api/networks`.

### 3. Build

```bash
npm run build
```

Compiles TypeScript to `dist/`. You must rebuild after any source changes.

### 4. Run

The server is HTTP-only — it serves the login UI and the MCP `/mcp` endpoint on `PORT`.

**Production / compiled:**

```bash
npm start
```

**Dev mode** — `npm run dev` starts a Cloudflare tunnel and prints a public
`https://…/mcp` URL you can paste into a Claude Desktop / claude.ai connector
(both require https). It also starts a Dockerized Redis via the `predev` hook.
Requires [`cloudflared`](https://github.com/cloudflare/cloudflared) (`brew install cloudflared`):

```bash
npm run dev
# ════════════════════════════════════════════════
#   Public URL:   https://<random>.trycloudflare.com
#   MCP endpoint: https://<random>.trycloudflare.com/mcp
#   Local:        http://localhost:5001
# ════════════════════════════════════════════════
```

For plain local work without a tunnel (e.g. connecting via `mcp-remote`, which
accepts `http://localhost`):

```bash
npm run dev:local
# → http://localhost:5001/mcp  and  http://localhost:5001/health
```

---

## Register an MCP client

The server is HTTP-only, so every client connects by URL — there is no stdio
command form. Use the deployed URL (`https://<your-domain>/mcp`) or the
local dev URL (`http://localhost:5001/mcp`).

**Claude Code** — native HTTP transport:

```json
{
  "mcpServers": {
    "lincx": {
      "type": "http",
      "url": "http://localhost:5001/mcp"
    }
  }
}
```

**Claude Desktop / claude.ai** — add the URL via Settings → Connectors → Add
custom connector. Or, for clients that only accept a stdio command, bridge the
URL with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

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

In all cases the client completes the OAuth dance in the browser on first connect
and stores the tokens itself. For OAuth redirects to resolve, `PUBLIC_BASE_URL`
must equal the URL the client hits — left unset locally it defaults to
`http://localhost:<PORT>`.

> The browser login UI runs on the same port. In remote mode, engineers must be able to reach `http://your-server-host:<PORT>/login` in a browser to complete authentication. Consider using a secure tunnel (e.g. ngrok, Cloudflare Tunnel) if the server is not publicly reachable.

---

## First login

1. In Claude, say **"login"** or ask it to call `auth_login`
2. Claude returns: `http://localhost:5001/login`
3. Open that URL in your browser
4. Enter your Lincx email and password
5. Browser shows a confirmation screen — **close the tab**
6. Back in Claude, call `auth_status` to confirm the session and see your available networks
7. If you have multiple networks, call `network_switch` with the network you want to work on

---

## Tool reference

### Auth

| Tool | Description |
|------|-------------|
| `auth_login` | Returns the browser login URL. Open it to authenticate. |
| `auth_status` | Shows current session: email, active network, available networks. |
| `auth_logout` | Destroys the session. Re-login required for further API calls. |

### Networks

| Tool | Parameters | Description |
|------|-----------|-------------|
| `network_list` | — | Lists all networks accessible to your account. |
| `network_switch` | `network_id` | Sets the active network. All subsequent API calls use this network. |
| `network_refresh` | — | Re-fetches the network list from the API (use after network changes). |

### Templates

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_templates` | `limit`, `offset` | Paginated list of all templates on the active network. |
| `get_template` | `id` | Full template details including HTML and CSS source. |
| `get_template_versions` | `id` | All versions of a template. |
| `get_template_version` | `id`, `version` | A specific version of a template by version number. |
| `get_template_parents` | `id` | Parent entities of a template (network, etc.). |
| `render_template` | `templateId`, `version?`, `mockAds?` | Composite tool: fetches the template and its creative asset group schema, generates mock ad data, returns the raw HTML + CSS + mock data used. No server-side rendering — the engineer previews the HTML string locally. |

### Creative Asset Groups

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_creative_asset_groups` | `limit`, `offset` | Paginated list of creative asset groups on the active network. |
| `get_creative_asset_group` | `id` | Full creative asset group details, including the field schema that defines what data ads must provide. |

### Zones

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_zones` | `limit`, `offset` | Paginated list of zones on the active network. |
| `get_zone` | `id` | Full zone configuration. |
| `get_zone_parents` | `id` | Parent hierarchy of a zone (site → publisher → network). |
| `get_zone_report` | `id`, `startDate?`, `endDate?`, `resolution?` | Time-series performance report for a zone. Resolution: `day` (default) or `hour`. |
| `zone_load_trace` | `zoneId` | Composite diagnostic tool: in parallel, fetches the zone, its parents, the ads that would serve, debug matching data, per-ad details, creatives, and the template. Returns a structured blob + a summary string. Use this to debug why a zone is or isn't serving ads. |

### Ads

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_ads` | `limit`, `offset` | Paginated list of ads on the active network. |
| `get_ad` | `id` | Full ad configuration. |
| `get_ad_parents` | `id` | Parent hierarchy of an ad (ad group → campaign → network). |
| `get_zone_ads` | `zoneId`, `adFeedCount?`, `geoState?`, `geoCity?`, `geoIP?`, `geoPostal?`, `geoCountry?`, `scoreKey?` | Calls the live ad-serving endpoint for a zone. Returns the ads that would be shown and the template they render into (`{ ads, template }`). Supports geo and scoring parameters. |

### Ad Groups

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_ad_groups` | `limit`, `offset` | Paginated list of ad groups on the active network. |
| `get_ad_group` | `id` | Full ad group configuration. |
| `get_ad_group_parents` | `id` | Parent hierarchy of an ad group (campaign → network). |

### Creatives

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_creatives` | `limit`, `offset` | Paginated list of creatives on the active network. |
| `get_creative` | `id` | Full creative details. |
| `get_creative_parents` | `id` | Parent hierarchy of a creative (ad → ad group → campaign). |

### Campaigns

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_campaigns` | `limit`, `offset` | Paginated list of campaigns on the active network. |
| `get_campaign` | `id` | Full campaign configuration. |
| `get_campaign_parents` | `id` | Parent hierarchy of a campaign (network). |

### Channels

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_channels` | `limit`, `offset` | Paginated list of channels on the active network. |
| `get_channel` | `id` | Full channel configuration. |
| `get_channel_parents` | `id` | Parent hierarchy of a channel. |

### Sites

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_sites` | `limit`, `offset` | Paginated list of sites on the active network. |
| `get_site` | `id` | Full site configuration. |
| `get_site_parents` | `id` | Parent hierarchy of a site (publisher → network). |

### Publishers

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_publishers` | `limit`, `offset` | Paginated list of publishers on the active network. |
| `get_publisher` | `id` | Full publisher details. |

### Advertisers

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_advertisers` | `limit`, `offset` | Paginated list of advertisers on the active network. |
| `get_advertiser` | `id` | Full advertiser details. |

### Experiences

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_experiences` | `limit`, `offset` | Paginated list of experiences on the active network. |
| `get_experience` | `id` | Full experience details. |

### Dimension Sets

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_dimension_sets` | `limit`, `offset` | Paginated list of dimension sets configured for the active network. Dimension sets define the available reporting dimensions (zone, campaign, day, etc.). |
| `get_dimension_set` | `id` | Full dimension set details. Use this to inspect which metrics and dimensions are available for a `report_query` call. |

### Reporting

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_event_stats_keys` | — | Returns unique event key-value pairs collected by the active network over the last 31 days. Use this to discover what filter dimensions are available before calling `report_query`. |
| `report_query` | `dimensionSetId`, `startDate`, `endDate`, `groupBy?`, `raw?`, `testMode?` | Runs `GET /api/reports/{dimensionSetId}` and **aggregates server-side**, returning compact rolled-up metric sums. `startDate`/`endDate` (YYYY-MM-DD) are required. Omit `groupBy` for a grand total, or pass it for breakdowns (`["zone"]`, `["zone","date"]`, `["advertiser"]`, …). `raw: true` returns the unaggregated hourly rows (large). |

---

## Multi-tenancy

Every Work API call automatically gets `?networkId=<active_network>` appended:

```
GET /api/zones?networkId=<networkId>
GET /api/reports/<dimensionSetId>?networkId=<networkId>&startDate=...
POST /api/campaigns?networkId=<networkId>
```

The `networkId` comes from `session.active_network`, set by `network_switch`. Claude never passes `networkId` directly — it calls `network_switch` and the server handles the rest.

---

## Security model

**Claude never sees or controls:**
- `auth_token` (stored server-side only, never returned to Claude)
- `networkId` query param (injected from `session.active_network`)
- `session_id` (lives in MCP server process memory only)

**Claude only controls:**
- `network_switch(network_id)` → sets the active network in the session
- Business tool parameters (entity IDs, pagination, date ranges, filters) — never auth or network context

---

## Adding new tools

1. Create `src/tools/yourDomainTools.ts`
2. Follow the pattern:
   - Call `validateSession(sessionId)` first — fail fast if not authenticated
   - **Never** accept `networkId` as a tool parameter
   - Use `workApiRequest(session, method, path, opts)` — `?networkId` is injected automatically
   - Wrap all JSON responses with `truncateIfNeeded()` before returning
   - Use `handleWorkApiError(err)` in catch blocks
   - Use `z.object({...}).strict()` on all input schemas
   - Use `type: "text" as const` on all content array entries

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { validateSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded } from "../services/workApi.js";

export function registerYourDomainTools(server: McpServer, getSessionId: () => string | null): void {
  server.registerTool("your_tool_name", {
    title: "Human Readable Name",
    description: "What this tool does and what it returns.",
    inputSchema: z.object({
      id: z.string().describe("Entity ID"),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const sessionId = getSessionId();
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    try {
      const data = await workApiRequest<unknown>(v.session, "GET", `/api/your-endpoint/${id}`);
      const text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text" as const, text: truncateIfNeeded(text) }] };
    } catch (err) {
      return { content: [{ type: "text" as const, text: handleWorkApiError(err) }] };
    }
  });
}
```

3. Register in `src/index.ts`:

```ts
import { registerYourDomainTools } from "./tools/yourDomainTools.js";
registerYourDomainTools(server, getSessionId);
```

4. Rebuild: `npm run build`

---

## Troubleshooting

**"Cannot find module" errors after changes**
→ Run `npm run build`. The server runs compiled JS from `dist/` — source changes have no effect until rebuilt.

**Session lost after restart**
→ Set `REDIS_URL` in your `.env`. Without Redis, sessions are in-memory only and are lost on restart.

**Login page unreachable**
→ Confirm the MCP server is running and that `PORT` in your config matches where you're navigating.

**Invalid credentials on login**
→ Use the same email and password as the Lincx web app.

**Network list empty after login**
→ Check `WORK_API_BASE_URL` is correct and reachable. Run `network_refresh` to retry fetching networks.

**Wrong network on API calls**
→ Run `auth_status` to see which network is active, then `network_switch` to correct it.

**Large responses truncated**
→ Expected — `truncateIfNeeded` caps response size to keep MCP messages manageable. Use more specific tools (e.g. `get_zone` instead of `list_zones`) to retrieve targeted data without truncation.

---

## Deployment

Full step-by-step guide: **[DEPLOYMENT.md](DEPLOYMENT.md)**.

The service is one Node container plus Redis behind a TLS-terminating proxy, and runs
on any Docker host. Start with the deployment contract in
[DEPLOYMENT.md §1](DEPLOYMENT.md#1-the-deployment-contract) — the one requirement that
bites is **exactly one running instance** (MCP transport state is in process memory;
Redis holds auth, not connections).

| File | Use |
|------|-----|
| `docker-compose.yml` | Portable — any Docker host (VM, on-prem, laptop). Reads `.env`. |
| `docker-compose.dev.yml` | Local-dev overlay; pass it explicitly (`-f docker-compose.yml -f docker-compose.dev.yml`). The npm scripts do. |
| `docker-compose.coolify.yml` | Coolify resources (uses Coolify's `SERVICE_*` magic vars). |
| `Dockerfile` | The image itself — for Cloud Run, GKE, ECS, or any registry-based platform. |
