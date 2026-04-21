# CLAUDE.md — lincx-mcp-server

This is the working context for Claude Code on this project.
Read this fully before making any changes.

---

## What this project is

An MCP (Model Context Protocol) server that gives Claude access to the Lincx / Interlincx platform.
It handles authentication, multi-network context, and exposes business tools as MCP tools.

The server runs locally alongside Claude Code. It has two responsibilities:
1. **MCP stdio transport** — Claude talks to it over stdin/stdout (JSON-RPC)
2. **Express HTTP server on port 3000** — serves a browser login UI so credentials never pass through Claude

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
    └── (add new domain tool files here)
```

---

## Critical rules — never violate these

### stdout is sacred
In stdio MCP mode, **stdout is the wire protocol**. Every byte written to stdout must be valid JSON-RPC.
- **Never use `console.log`** anywhere in this codebase
- Always use `console.error` for all logging — it goes to stderr, which the transport ignores
- This includes inside Express route handlers, services, and tools

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

## Authentication flow

```
1. Claude calls auth_login tool
2. Tool returns { login_url: "http://localhost:3000/login" }
3. User opens URL in browser → polished login form served by Express
4. User submits email + password
5. POST /api/login → loginWithCredentials() → POST ix-id.lincx.la/auth/login
6. Identity server returns { success: true, data: { authToken: "..." } }
7. Server calls createSession() → fetchUserNetworks() → stores session
8. Browser redirects to /login/success → user closes tab
9. Claude calls auth_status → confirms session, lists networks
```

Identity server: `https://ix-id.lincx.la` (authentic-server)
Login endpoint: `POST /auth/login` with body `{ email, password }`
Response shape: `{ success: boolean, data: { authToken: string } }`
Token type: JWT, ~30 day expiry, no refresh endpoint, no revocation endpoint

**Known open issue:** 401 on login despite correct credentials — suspected cause is either wrong request body field names (`email` vs `username`) or missing headers the identity server requires. Debug by logging the raw fetch request/response in `auth.ts` before the status checks.

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
TTL: 7 days for Lincx sessions, 7 days for MCP-to-Lincx bindings, 10 minutes for login tickets.
The previous `.sessions/session_id` on-disk persistence has been removed.

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WORK_API_BASE_URL` | Yes | `http://localhost:3050` | Work API — all requests go here |
| `IDENTITY_SERVER` | No | `https://ix-id.lincx.la` | Lincx auth server |
| `PORT` | No | `5001` | Express HTTP port (login UI + MCP over HTTP) |
| `TRANSPORT` | No | `stdio` | `stdio` (local) or `http` (remote) |
| `REDIS_URL` | No | `` (empty) | Redis for persistent sessions — required in production |
| `NODE_ENV` | No | `development` | Set to `production` to disable `/dev/*` routes and require `MCP_ACCESS_KEY` |
| `PUBLIC_BASE_URL` | No | `http://localhost:<PORT>` | Used when building browser login URLs returned to Claude |
| `MCP_ACCESS_KEY` | Yes in prod | `` (empty) | Shared access key required on `?key=` for `/mcp` and `/login` |

There is no `NETWORK_API_BASE_URL` — networks come from `WORK_API_BASE_URL/api/networks`.

---

## Build and run

```bash
npm install          # first time only
npm run build        # compile TS → dist/ — required after every source change
npm start            # run in stdio mode (for Claude Code)
npm run dev          # tsx watch — auto-reloads, no build step (dev only)
```

The `dist/` directory must be committed or rebuilt before the MCP server can start.
Claude Code runs `dist/index.js` — source changes have no effect until rebuilt.

---

## Claude Code MCP config

```json
{
  "mcpServers": {
    "lincx": {
      "command": "/Users/salaheddinezaka/.nvm/versions/node/v22.13.1/bin/node",
      "args": ["/absolute/path/to/lincx-mcp-server/dist/index.js"],
      "env": {
        "WORK_API_BASE_URL": "http://localhost:3050",
        "PORT": "5001"
      }
    }
  }
}
```

**Always use a full absolute path to a Node 18+ binary.** Node 16 is on the PATH first and will be picked by default — it causes subtle ESM and runtime issues. Node v22 is confirmed installed and working.

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
- `network_list` — list available networks
- `network_switch` — change active network
- `network_refresh` — re-fetch networks from API

### Templates (M1)
- `list_templates` — `GET /api/templates` (paginated, limit/offset)
- `get_template` — `GET /api/templates/{id}` — includes HTML + CSS source
- `get_template_versions` — `GET /api/templates/{id}/versions`
- `get_template_version` — `GET /api/templates/{id}/versions/{version}`
- `get_template_parents` — `GET /api/templates/{id}/parents`
- `render_template` — composite: fetch template + CAG schema → generate mock ads → return HTML + CSS

### Creative Asset Groups (M1)
- `list_creative_asset_groups` — `GET /api/creative-asset-groups` (paginated)
- `get_creative_asset_group` — `GET /api/creative-asset-groups/{id}` — includes field schema defining what data ads must provide

### Zones (M2)
- `list_zones` — `GET /api/zones` (paginated)
- `get_zone` — `GET /api/zones/{id}`
- `get_zone_parents` — `GET /api/zones/{id}/parents`
- `get_zone_report` — `GET /api/zones/{id}/report` (params: resolution, startDate, endDate)
- `zone_load_trace` — composite: fan-out across zone + parents + ads/ad + debug + ads details + template → structured diagnostic blob

### Ads (M2)
- `list_ads` — `GET /api/ads` (paginated)
- `get_ad` — `GET /api/ads/{id}`
- `get_ad_parents` — `GET /api/ads/{id}/parents`
- `get_zone_ads` — `GET /api/ads/ad?zoneId=` — ad-serving endpoint, returns { ads, template }

### Ad Groups (M2)
- `list_ad_groups` — `GET /api/ad-groups` (paginated)
- `get_ad_group` — `GET /api/ad-groups/{id}`
- `get_ad_group_parents` — `GET /api/ad-groups/{id}/parents`

### Creatives (M2)
- `list_creatives` — `GET /api/creatives` (paginated)
- `get_creative` — `GET /api/creatives/{id}`
- `get_creative_parents` — `GET /api/creatives/{id}/parents`

### Campaigns (M2)
- `list_campaigns` — `GET /api/campaigns` (paginated)
- `get_campaign` — `GET /api/campaigns/{id}`
- `get_campaign_parents` — `GET /api/campaigns/{id}/parents`

### Channels (M2)
- `list_channels` — `GET /api/channels` (paginated)
- `get_channel` — `GET /api/channels/{id}`
- `get_channel_parents` — `GET /api/channels/{id}/parents`

### Sites (M2)
- `list_sites` — `GET /api/sites` (paginated)
- `get_site` — `GET /api/sites/{id}`
- `get_site_parents` — `GET /api/sites/{id}/parents`

### Publishers (M2)
- `list_publishers` — `GET /api/publishers` (paginated)
- `get_publisher` — `GET /api/publishers/{id}`

### Dimension Sets (M3)
- `list_dimension_sets` — `GET /api/dimension-sets` (paginated)
- `get_dimension_set` — `GET /api/dimension-sets/{id}` — dimensions available for report_query

### Reporting (M3)
- `get_event_stats_keys` — `GET /api/event-stats` — unique event key-values for last 31 days (use to discover filter dimensions)
- `report_query` — composite: `GET /api/reports/{dimensionSetId}` with date range, resolution (`day`/`hour`), dimension filters (`d`), optional test-mode

### Advertisers (M3)
- `list_advertisers` — `GET /api/advertisers` (paginated)
- `get_advertiser` — `GET /api/advertisers/{id}`

### Experiences (M3)
- `list_experiences` — `GET /api/experiences` (paginated)
- `get_experience` — `GET /api/experiences/{id}`

---

## Deployment

Deployed via Docker to Fly.io with Upstash Redis. Users get a single URL to paste into their MCP client:

```
https://<app>.fly.dev/mcp?key=<MCP_ACCESS_KEY>
```

### One-time setup

```bash
fly launch --no-deploy
fly redis create                                           # sets REDIS_URL as a secret
fly secrets set MCP_ACCESS_KEY=$(openssl rand -hex 32)
fly deploy
```

### Subsequent deploys

```bash
fly deploy
```

### Rotate the access key

```bash
fly secrets set MCP_ACCESS_KEY=$(openssl rand -hex 32)
fly deploy
# hand the new URL to users
```

### Inspect sessions

```bash
fly logs
# Or, with REDIS_URL exported locally:
redis-cli --tls -u "$REDIS_URL" keys "lincx:session:*" | wc -l
```

---

## Known issues and open work

### 401 on login (priority)
Login against `ix-id.lincx.la/auth/login` returns 401 even with correct credentials.
Credentials confirmed correct. Likely causes in order of probability:
- Identity server expects a different field name (`username` instead of `email`)
- Missing required headers (`Origin`, `X-Client-ID`, `Referer`, or similar)
- The endpoint path is wrong (`/auth/login` vs `/api/auth/login` vs `/login`)
- CORS or same-origin restriction blocking non-browser requests

**To debug:** Add temporary logging in `src/services/auth.ts` before the catch:
```ts
console.error("[Auth] Request:", { url: `${IDENTITY_SERVER}/auth/login`, body: { email, password: "***" } });
console.error("[Auth] Response:", err.response?.status, JSON.stringify(err.response?.data));
```
Cross-reference with the actual login request from the Lincx web app (DevTools → Network tab).

### Network response shape unconfirmed
`networkService.ts` handles four possible shapes from `GET /api/networks`:
`{ networks: [] }` | `{ data: [] }` | `{ items: [] }` | bare `[]`
The actual shape from the real endpoint is unknown — confirm and simplify the parsing once known.

### No token expiry handling
authentic-server JWTs expire after ~30 days. When they expire, all tool calls will fail with 401.
Currently the user must `auth_logout` then `auth_login` manually. Consider adding expiry detection
to `validateSession()` and returning a clear re-login prompt.

---

## TypeScript conventions

- All imports use `.js` extension (required for NodeNext ESM): `import { x } from "./module.js"`
- Strict mode is on — no implicit `any`, no unhandled nulls
- Tool handler return type is always `{ content: Array<{ type: "text", text: string }>, structuredContent?: ... }`
- `z.object({}).strict()` on all tool input schemas to reject unexpected params
- `as const` on all `type: "text"` literals in content arrays (MCP SDK requirement)