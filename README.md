# lincx-mcp-server

MCP server for Interlincx — browser-based login UI, Redis-backed sessions, and multi-network support.
Credentials never pass through Claude. Authentication happens entirely in a local browser window.

---

## How it works

```
Claude calls auth_login
  → MCP server returns http://localhost:3000/login
  → User opens URL in browser, enters email + password
  → Browser POSTs to local MCP server (/api/login)
  → MCP server forwards to ix-id.lincx.la/auth/login
  → On success: session created server-side, browser shows success screen
  → User closes tab, returns to Claude
  → Claude calls auth_status → session confirmed, networks listed
```

Multi-tenancy is handled by appending `?networkId=<id>` to every Work API request.
The `networkId` is always injected server-side from `session.active_network` — Claude never controls it.

---

## Project structure

```
src/
├── index.ts                   # Entry point: MCP server + Express login UI
├── types.ts                   # Shared TypeScript types
├── constants.ts               # Env vars with defaults
│
├── services/
│   ├── auth.ts                # loginWithCredentials() → ix-id.lincx.la/auth/login
│   ├── sessionStore.ts        # Redis (or in-memory) session persistence
│   ├── sessionManager.ts      # create / validate / switch / destroy sessions
│   ├── networkService.ts      # fetchUserNetworks() from /api/networks on Work API
│   └── workApi.ts             # Authenticated HTTP client (?networkId injected on every call)
│
└── tools/
    ├── authTools.ts            # auth_login, auth_status, auth_logout
    ├── networkTools.ts         # network_list, network_switch, network_refresh
    └── projectTools.ts         # projects_list, projects_get  ← extend here
```

---

## Prerequisites

- **Node.js 18+** — check with `node --version`
- **npm 9+** — check with `npm --version`
- **Redis** (optional) — for persistent sessions across restarts. Without it, sessions live in memory and are lost on restart.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

Open `.env` and fill in your values:

```env
# Your Work API — all requests go here including /api/networks
# networkId is appended automatically: ?networkId=svce6t
WORK_API_BASE_URL=http://localhost:3050

# Optional — defaults shown
IDENTITY_SERVER=https://ix-id.lincx.la
PORT=3000
TRANSPORT=stdio

# Optional — leave empty to use in-memory store (sessions lost on restart)
REDIS_URL=redis://localhost:6379
```

> **Note:** There is no `NETWORK_API_BASE_URL`. Networks are fetched from `WORK_API_BASE_URL/api/networks`.

### 3. Build

```bash
npm run build
```

Compiles TypeScript to `dist/`. You must rebuild after any source changes.

### 4. Run

**stdio mode** (default — for Claude Code and local IDE use):

```bash
npm start
```

**HTTP mode** (for remote or multi-client use):

```bash
TRANSPORT=http npm start
```

**Dev mode** (auto-reloads on file changes, no build step needed):

```bash
npm run dev
```

---

## Register with Claude Code

Add to your Claude Code MCP config (`~/.claude/mcp_settings.json` or via Claude Code settings):

```json
{
  "mcpServers": {
    "lincx": {
      "command": "node",
      "args": ["/absolute/path/to/lincx-mcp-server/dist/index.js"],
      "env": {
        "WORK_API_BASE_URL": "http://localhost:3050",
        "PORT": "3000"
      }
    }
  }
}
```

> Replace `/absolute/path/to/` with the actual path on your machine.
> After saving, restart Claude Code to pick up the new server.

---

## First login

1. In Claude, say **"login"** or ask it to call `auth_login`
2. Claude returns: `http://localhost:3000/login`
3. Open that URL in your browser
4. Enter your Interlincx email and password
5. Browser shows a confirmation screen — **close the tab**
6. Back in Claude, run `auth_status` to confirm session and see your networks

---

## Tool reference

### Auth

| Tool | Description |
|------|-------------|
| `auth_login` | Returns the browser login URL |
| `auth_status` | Shows current session, email, active network |
| `auth_logout` | Destroys session (re-login required) |

### Networks

| Tool | Description |
|------|-------------|
| `network_list` | Lists all networks with their IDs |
| `network_switch(network_id)` | Sets active network for all subsequent calls |
| `network_refresh` | Re-fetches network list from `/api/networks` |

### Business tools (extend these)

| Tool | Description |
|------|-------------|
| `projects_list` | Lists projects on the active network |
| `projects_get(project_id)` | Gets a specific project by ID |

---

## How multi-tenancy works

Every Work API call automatically gets `?networkId=<active_network>` appended:

```
GET /api/creative-asset-groups?networkId=svce6t
GET /api/projects?networkId=svce6t&limit=20
POST /api/campaigns?networkId=svce6t
```

The `networkId` comes from `session.active_network` set by `network_switch`.
Claude never passes `networkId` directly — it only calls `network_switch(network_id)` and the server handles the rest.

---

## Natural language network switching

Claude handles this automatically. Example:

> **User:** "Show me the creative asset groups on network svce6t"

Claude will:
1. Call `network_list()` → find or confirm the network ID
2. Call `network_switch({ network_id: "svce6t" })` → session updated
3. Call the business tool → `?networkId=svce6t` injected automatically
4. Report back which network is now active

---

## Adding new business tools

1. Create `src/tools/yourDomainTools.ts`
2. Follow the pattern in `projectTools.ts`:
   - Call `validateSession(sessionId)` first
   - **Never** accept `networkId` as a tool parameter
   - Use `workApiRequest(session, method, path, opts)` — `?networkId` is injected automatically
3. Register in `src/index.ts`:
   ```ts
   import { registerYourDomainTools } from "./tools/yourDomainTools.js";
   registerYourDomainTools(server, getSessionId);
   ```
4. Rebuild: `npm run build`

**Example — creative asset groups tool:**
```ts
const data = await workApiRequest<PaginatedResponse<CreativeAssetGroup>>(
  session,
  "GET",
  "/api/creative-asset-groups",
  { params: { limit, offset } }
  // → GET /api/creative-asset-groups?networkId=svce6t&limit=20&offset=0
);
```

---

## Security model

**Claude never sees or controls:**
- `auth_token` (stored server-side only)
- `networkId` query param (injected from `session.active_network`)
- `session_id` (lives in MCP server process memory)

**Claude only calls:**
- `network_list` → read available networks
- `network_switch(network_id)` → update active network in session
- Business tools → `?networkId` appended automatically, no auth params accepted

---

## Troubleshooting

**"Cannot find module" errors after changes**
→ Run `npm run build` again. The server runs compiled JS from `dist/`.

**Session lost after restart**
→ Set `REDIS_URL` in `.env`. Without Redis, sessions are in-memory only.

**Login page unreachable**
→ Confirm the MCP server is running and `PORT` matches.

**"Invalid email or password"**
→ Use the same credentials as the Interlincx web app.

**Network list empty after login**
→ Check `WORK_API_BASE_URL` is correct and `/api/networks` exists. Run `network_refresh` to retry.

**Wrong networkId on API calls**
→ Run `auth_status` to see which network is active, then `network_switch` to correct it.
