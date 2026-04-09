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
- `session_id` — lives in the `currentSessionId` variable in `index.ts` only, never exposed via any tool

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
In-memory sessions are lost on server restart — use Redis for anything beyond local dev.
TTL: 7 days (configurable in `constants.ts` via `SESSION_TTL_SECONDS`).

---

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WORK_API_BASE_URL` | Yes | `http://localhost:3050` | Work API — all requests go here |
| `IDENTITY_SERVER` | No | `https://ix-id.lincx.la` | Lincx auth server |
| `PORT` | No | `5001` | Express login UI port |
| `TRANSPORT` | No | `stdio` | `stdio` or `http` |
| `REDIS_URL` | No | `` (empty) | Redis for persistent sessions |

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
import { validateSession } from "../services/sessionManager.js";
import { workApiRequest, handleWorkApiError, truncateIfNeeded } from "../services/workApi.js";

export function registerYourDomainTools(server: McpServer, getSessionId: () => string | null): void {
  server.registerTool("your_tool_name", {
    title: "Human Readable Name",
    description: `Clear description of what this does and what it returns.`,
    inputSchema: z.object({
      // never include networkId here
      limit: z.number().int().min(1).max(100).default(20),
    }).strict(),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ limit }) => {
    const sessionId = getSessionId();
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
registerYourDomainTools(server, getSessionId);
```

4. Add the type to `src/types.ts` if needed
5. Run `npm run build`

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