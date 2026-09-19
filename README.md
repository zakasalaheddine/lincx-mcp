# lincx-mcp-server

MCP server for the Lincx / Interlincx platform — OAuth 2.1 + PKCE authentication with encrypted wrapped access tokens (no Redis), and multi-network support. Credentials never pass through Claude.

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
5. Exchanges the auth code at `/oauth/token` for an access token (no refresh tokens)
6. Sends `Authorization: Bearer <access_token>` on every `/mcp` call

Tokens are stored by your MCP client and survive desktop-app reloads — no re-auth on reconnect until the underlying Lincx JWT expires. Once signed in, run `network_list` to see your networks, then pass the chosen `network_id` to any business tool.

---

## How it works

```
Client → POST /mcp (no auth)            ← 401 + WWW-Authenticate
Client → /.well-known/oauth-authorization-server   (discovery)
Client → POST /oauth/register                      (DCR → signed client_id)
Client → opens browser → GET /oauth/authorize?...&code_challenge=…
Server redirects to /login?ctx=<signed auth request>
User submits credentials → server signs into Lincx → issues sealed auth code
Browser navigates to redirect_uri?code=…&state=…
Client → POST /oauth/token (with code_verifier)    ← access_token (wrapped Lincx JWT)
Client → POST /mcp + Authorization: Bearer …       (all subsequent calls)
```

The OAuth access token is an AES-GCM wrapping of the Lincx JWT. The server
decrypts it on each request; there is no Redis session store. Access tokens
expire with the Lincx JWT's `exp` — no refresh tokens are issued.

Multi-tenancy is scoped per tool call: every business tool takes a required `network_id` argument, which `workApiRequest` attaches to the Work API request (`?networkId=<id>` on list endpoints). There is no server-side active network.

---

## Project structure

```
src/
├── index.js                     # Bootstrap — loads secrets/env, then calls server.js start()
├── server.js                    # MCP tool registration + start({ port })
├── constants.js                 # Env vars with defaults
│
├── http/                        # respond / request / router / health — the whole URL surface
├── middleware/                  # toolGuard (response-size guard), rateLimit
├── routes/                      # Login UI + OAuth endpoints
├── views/                       # Login page template
│
├── services/
│   ├── auth.js                  # loginWithCredentials() → identity server
│   ├── tokenService.js          # AES-GCM wrap + HMAC-signed OAuth tokens
│   ├── sessionManager.js        # unwrap bearer → auth context / validateSession
│   ├── networkService.js        # fetchUserNetworks() from /api/networks
│   ├── oauth/                   # clients, codes, tokens, pkce, metadata
│   └── workApi.js               # Authenticated Work API client (?networkId on list GETs)
│
└── tools/
    ├── authTools.js             # auth_login, auth_status, auth_logout
    ├── networkTools.js          # network_list, network_refresh
    ├── templateTools.js         # list_templates, get_template, get_template_versions, get_template_version
    ├── creativeAssetGroupTools.js # list_creative_asset_groups, get_creative_asset_group
    ├── zoneTools.js             # list_zones, get_zone, get_zone_report
    ├── zoneInventoryTools.js    # get_zone_targeting_inventory
    ├── zoneEligibilityTools.js  # get_zone_eligible_ad_groups, get_ad_group_zone_reach, explain_serve
    ├── adTools.js               # list_ads, get_ad, get_zone_ads
    ├── adGroupTools.js          # list_ad_groups, get_ad_group
    ├── creativeTools.js         # list_creatives, get_creative
    ├── campaignTools.js         # list_campaigns, get_campaign
    ├── channelTools.js          # list_channels, get_channel
    ├── siteTools.js             # list_sites, get_site
    ├── publisherTools.js        # list_publishers, get_publisher
    ├── advertiserTools.js       # list_advertisers, get_advertiser
    ├── experienceTools.js       # list_experiences, get_experience
    ├── analysisTools.js         # list_analyses, get_analysis
    ├── auditTools.js            # get_user_actions
    ├── reportingTools.js        # list_dimension_sets, get_dimension_set, get_event_stats_keys, report_query
    └── resources.js             # MCP Resources: lincx://networks + lincx://{entity}/{id}
```

---

## Prerequisites

- **Node.js 22+** — check with `node --version`
- **npm 9+** — check with `npm --version`

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

# Required — ≥32-char secret for access-token wrapping / OAuth signing
WRAPPING_KEY=change-me-to-a-long-random-secret!!

# Optional — Lincx identity server (defaults shown)
IDENTITY_SERVER=https://your-identity-server.example.com

# Optional — port for the login UI + MCP /mcp endpoint (default: 5001)
PORT=5001
```

> **Note:** There is no `NETWORK_API_BASE_URL`. Networks are fetched from `WORK_API_BASE_URL/api/networks`.

### 3. Run

The server is HTTP-only — it serves the login UI and the MCP `/mcp` endpoint on `PORT`.

**Production / compiled:**

```bash
npm start
```

**Dev mode** — `npm run dev` starts a tunnel and prints a public `https://…/mcp`
URL to paste into a Claude Desktop / claude.ai connector (both require https).
It uses **ngrok** if installed, otherwise **cloudflared**; `npm run dev:ngrok`
and `npm run dev:cloudflared` force one (`brew install ngrok` /
`brew install cloudflared`). For plain local work without a tunnel, use
`npm run dev:local`.

```bash
npm run dev
# ══════════════════════════════════════════════════════════════
#   ngrok tunnel is live
#   Public URL:   https://<random>.ngrok-free.app
#   MCP endpoint: https://<random>.ngrok-free.app/mcp
#   Local:        http://localhost:5001
#   PUBLIC_BASE_URL is set to the public URL, so OAuth discovery matches it.
# ══════════════════════════════════════════════════════════════
```

**Do not start a tunnel by hand against `npm run dev:local`.** The server would
still advertise `http://localhost:5001` in its OAuth discovery document, the
client would fetch discovery over https and then refuse a `registration_endpoint`
on plain localhost, and the only symptom is *"Couldn't register with … sign-in
service"*. `npm run dev` exists to set `PUBLIC_BASE_URL` to the tunnel URL; the
server also logs a warning if discovery is ever served for a mismatched host.

On the ngrok free plan the login page shows an interstitial once — click "Visit
Site". `npm run dev:cloudflared` has none.

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
7. Pass the `network_id` you want to work on to any business tool — it is a required argument on every call

---

## Tool reference

Every business tool below takes a **required `network_id`** argument — a 6-character id from `network_list`, passed on each call (there is no server-side active network). Common parameters, omitted from the per-row lists:

- `list_*` tools: `limit` (default 25, max 100), `offset`, `fields` (extra item fields to project beyond `{ id, name }` plus status fields)
- `get_*` tools: `id`, plus `include: ['parents']` to fetch the parent hierarchy in the same call

### Auth

| Tool | Parameters | Description |
|------|-----------|-------------|
| `auth_login` | — | Returns the browser login URL. Open it to authenticate. |
| `auth_status` | `includeArchived`, `limit`, `offset`, `verbose` | Shows current session: email and available networks. |
| `auth_logout` | — | Destroys the session. Re-login required for further API calls. |

### Networks

| Tool | Parameters | Description |
|------|-----------|-------------|
| `network_list` | `includeArchived`, `limit`, `offset`, `verbose` | Lists all networks accessible to your account (active only by default). |
| `network_refresh` | `includeArchived`, `limit`, `offset`, `verbose` | Re-fetches the network list from the API (use after network changes, or when login returned no networks). |

### Templates

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_templates` | `publisherId` | Templates on the network. |
| `get_template` | `id` | Full template details including HTML and CSS source. |
| `get_template_versions` | `id` | All saved versions of a template. |
| `get_template_version` | `id`, `version` | HTML + CSS source of a specific version by version number. |

### Creative Asset Groups

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_creative_asset_groups` | — | Creative asset groups on the network. |
| `get_creative_asset_group` | `id` | Full creative asset group details, including the field schema that defines what data ads must provide. |

### Zones

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_zones` | `publisherId`, `channelId`, `siteId` | Zones on the network. |
| `get_zone` | `id` | Full zone configuration. |
| `get_zone_report` | `id`, `startDate`, `endDate`, `resolution` | Time-series performance report for a zone. `resolution`: `day` (default) or `hour`. |

### Zone audits (server-side composites)

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_zone_targeting_inventory` | `zoneId`, `mode` | Which ad groups are directly targeted to a zone, and whether each is fully live (campaign + ad group + live ad with viable creative). `mode`: `all` (default), `live`, `off`. |
| `get_zone_eligible_ad_groups` | `zoneId`, `bucket`, `offset` | Every ad group eligible to serve in a zone, bucketed: `directlyTargeted`, `freeRadicals`, `conflicting`, `inertWhitelists`. |
| `get_ad_group_zone_reach` | `adGroupId` | Every zone an ad group can serve or leak into — the flip of `get_zone_eligible_ad_groups`. |
| `explain_serve` | `zoneId`, `adGroupId` or `adId` | Why a (zone, ad group/ad) pair is or isn't eligible to serve, and by what path. |

### Ads

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_ads` | `adGroupId`, `campaignId`, `advertiserId` | Ads on the network. |
| `get_ad` | `id` | Full ad configuration. |
| `get_zone_ads` | `zoneId`, `debug`, `adFeedCount`, `geoState`, `geoCity`, `geoIP`, `geoPostal`, `geoCountry`, `scoreKey` | Calls the live ad-serving endpoint for a zone — the ads that would be shown and the template they render into (`{ ads, template }`). `debug: true` returns ad-group match/reject diagnostics. |

### Ad Groups

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_ad_groups` | `advertiserId`, `campaignId` | Ad groups on the network. |
| `get_ad_group` | `id` | Full ad group configuration. |

### Creatives

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_creatives` | `advertiserId` | Creatives on the network. |
| `get_creative` | `id` | Full creative details. |

### Campaigns

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_campaigns` | `advertiserId` | Campaigns on the network. |
| `get_campaign` | `id` | Full campaign configuration. |

### Channels

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_channels` | `publisherId` | Channels on the network. |
| `get_channel` | `id` | Full channel configuration. |

### Sites

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_sites` | `publisherId`, `channelId` | Sites on the network. |
| `get_site` | `id` | Full site configuration. |

### Publishers

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_publishers` | — | Publishers on the network. |
| `get_publisher` | `id` | Full publisher details. |

### Advertisers

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_advertisers` | — | Advertisers on the network. |
| `get_advertiser` | `id` | Full advertiser details. |

### Experiences

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_experiences` | `publisherId`, `channelId`, `siteId` | Experiences on the network. |
| `get_experience` | `id` | Full experience details. |

### Analyses

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_analyses` | `status`, `limit`, `cursor` | Zone-tier analysis jobs on the network, newest first. |
| `get_analysis` | `id` | One analysis job by ID — poll until `succeeded` or `failed`. |

### Audit log

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_user_actions` | `entityId`, `model`, `type`, `user`, `dateStart`, `dateEnd` | Who created, cloned, updated, archived, unarchived, moved or reassigned an entity on the network, and when. Newest first. **Entity grain, not field grain** — an `update` row does not say which field changed or its previous value. **Defaults to the last 14 days**; pass `dateStart` to look further back, and read the echoed `window` to see what the answer covers. `model` takes the stored camelCase name (`adGroup`, not `AdGroup`). `entityId` is applied server-side (the endpoint has no entity filter); the rest are the endpoint's own filters. |

### Dimension Sets & Reporting

| Tool | Parameters | Description |
|------|-----------|-------------|
| `list_dimension_sets` | — | Dimension sets configured for the network — they define the available reporting dimensions (zone, campaign, day, etc.). |
| `get_dimension_set` | `id` | Full dimension set details. Use this to inspect which metrics and dimensions are available for a `report_query` call. |
| `get_event_stats_keys` | — | Unique event key-value pairs collected on the network over the last 31 days. Use this to discover filter keys before calling `report_query`. |
| `report_query` | `dimensionSetId`, `startDate`, `endDate`, `groupBy`, `filter`, `timezone`, `raw`, `testMode` | Runs `GET /api/reports/{dimensionSetId}` and **aggregates server-side**, returning compact rolled-up metric sums. `startDate`/`endDate` (YYYY-MM-DD) are required. Omit `groupBy` for a grand total, or pass it for breakdowns (`["zone"]`, `["zone","date"]`, `["advertiser"]`, …). `filter` scopes the report to one entity server-side; `raw: true` returns the unaggregated hourly rows (large). |

---

## Multi-tenancy

`network_id` is a required argument on every business tool. `workApiRequest` attaches it as `?networkId=<id>` on Work API **list** endpoints:

```
GET /api/zones?networkId=<id>
GET /api/campaigns?networkId=<id>&limit=20
```

Get-by-id, parents, reports, and network endpoints resolve tenancy from the entity ID and receive no `networkId` at all — those tools still take `network_id` for a uniform call shape, but do not forward it.

---

## Security model

**Claude never sees or controls:**
- `auth_token` (the Lincx JWT — stored server-side only, never returned to Claude)
- `session_id` (resolved from the OAuth bearer on each request, never exposed via any tool)

**Claude controls:**
- `network_id` — a required argument on every business tool (call `network_list` for valid ids)
- Business tool parameters (entity IDs, pagination, date ranges, filters)

---

## Adding new tools

1. Create `src/tools/yourDomainTools.js`
2. Follow the pattern:
   - Resolve the session from the request's OAuth bearer via `resolveLincxSession(extra)`, then call `validateSession(sessionId, network_id)` — fail fast if not authenticated
   - Spread `requiredNetworkIdShape` into the input schema and pass `network_id` to `workApiRequest` via `options.networkId`
   - Use `workApiRequest(session, method, path, opts)` — never call `fetch`/`axios` directly in tools
   - Use `handleWorkApiError(err)` in catch blocks
   - Use `z.object({...}).strict()` on all input schemas
   - Never log OAuth tokens or the Lincx JWT

```js
import { z } from 'zod'
import { validateSession, resolveLincxSession } from '../services/sessionManager.js'
import { workApiRequest, handleWorkApiError } from '../services/workApi.js'
import { requiredNetworkIdShape } from './_shared.js'

export function registerYourDomainTools (server) {
  server.registerTool('your_tool_name', {
    title: 'Human Readable Name',
    description: 'What this tool does and what it returns.',
    inputSchema: z.object({
      ...requiredNetworkIdShape,
      limit: z.number().int().min(1).max(100).default(20)
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ limit, network_id }, extra) => {
    const sessionId = await resolveLincxSession(extra)
    if (!sessionId) return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }

    const v = await validateSession(sessionId, network_id)
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

3. Register in `createMcpServer()` in `src/server.js`:

```js
import { registerYourDomainTools } from './tools/yourDomainTools.js'
registerYourDomainTools(server)
```

4. Lint it: `npm run lint`

---

## Troubleshooting

**"Cannot find module" errors after changes**
→ Check the import has a `.js` extension. The project is ESM with no build step; extensionless imports do not resolve.

**Server refuses to start / wrapping key error**
→ Set `WRAPPING_KEY` in your `.env` to a secret at least 32 characters long.

**Login page unreachable**
→ Confirm the MCP server is running and that `PORT` in your config matches where you're navigating.

**Invalid credentials on login**
→ Use the same email and password as the Lincx web app.

**Network list empty after login**
→ Check `WORK_API_BASE_URL` is correct and reachable. Run `network_refresh` to retry fetching networks.

**Wrong network on API calls**
→ Check the `network_id` passed on the call — run `network_list` for the valid ids.

**Large responses truncated**
→ Expected — `truncateIfNeeded` caps response size to keep MCP messages manageable. Use more specific tools (e.g. `get_zone` instead of `list_zones`) to retrieve targeted data without truncation.

---

## Deployment

The server deploys to any Node ≥22 host — no build step, no container required:

- Build `npm ci --omit=dev`, start `node src/index.js`
- The platform sets `PORT`; the app listens on it
- `/health` answers 200 — point the platform's health check at it
- Terminate TLS in front of the app (it only speaks HTTP) and have the proxy
  overwrite `X-Forwarded-For` — set `TRUSTED_PROXY_HOPS` to the measured hop
  count, or every rate limit keys on a client-supplied header
- Required env vars: `WORK_API_BASE_URL`, `WRAPPING_KEY` (secret, never
  committed), `PUBLIC_BASE_URL` — must equal the URL clients actually hit, no
  trailing slash. A mismatch breaks OAuth discovery with no useful
  client-side error.

The MCP transport is **stateless** — identity is the wrapped OAuth bearer on
each request — so the service restarts and redeploys without dropping clients. One
caveat before scaling past one instance: the rate limiter counts in-process, so
N instances silently means N × the per-caller limits.

Post-deploy check: `npm run smoke https://<your-domain>` — read-only,
unauthenticated; it is what catches a `PUBLIC_BASE_URL` mismatch.
