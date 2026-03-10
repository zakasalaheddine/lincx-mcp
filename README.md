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
│   ├── networkService.ts      # fetchUserNetworks() from your Network Service
│   └── workApi.ts             # Authenticated HTTP client (injects token + network)
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
# Required — your internal API base URLs
WORK_API_BASE_URL=https://your-work-api.lincx.la
NETWORK_API_BASE_URL=https://your-network-api.lincx.la

# Optional — defaults shown
IDENTITY_SERVER=https://ix-id.lincx.la
PORT=3000
TRANSPORT=stdio

# Optional — leave empty to use in-memory store (sessions lost on restart)
REDIS_URL=redis://localhost:6379
```

> **Note:** You do NOT need OAuth credentials. Authentication uses the Lincx authentic-server directly.

### 3. Build

```bash
npm run build
```

This compiles TypeScript to `dist/`. You must rebuild after any source changes.

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

Add to your Claude Code MCP config (usually `~/.claude/mcp_settings.json` or via Claude Code settings):

```json
{
  "mcpServers": {
    "lincx": {
      "command": "node",
      "args": ["/absolute/path/to/lincx-mcp-server/dist/index.js"],
      "env": {
        "WORK_API_BASE_URL": "https://your-work-api.lincx.la",
        "NETWORK_API_BASE_URL": "https://your-network-api.lincx.la",
        "PORT": "3000"
      }
    }
  }
}
```

> Replace `/absolute/path/to/` with the actual path on your machine.

After saving, restart Claude Code to pick up the new server.

---

## First login

1. In Claude, type: **"login"** or **"auth_login"**
2. Claude returns a URL: `http://localhost:3000/login`
3. Open that URL in your browser
4. Enter your Interlincx email and password
5. On success, browser shows a confirmation screen — **close the tab**
6. Back in Claude, run `auth_status` to confirm and see your networks

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
| `network_list` | Lists all accessible networks with IDs |
| `network_switch(network_id)` | Changes active network for all subsequent calls |
| `network_refresh` | Re-fetches network list from Network Service |

### Business tools (extend these)

| Tool | Description |
|------|-------------|
| `projects_list` | Lists projects on the active network |
| `projects_get(project_id)` | Gets a specific project by ID |

---

## Natural language network switching

Claude handles this automatically. Example:

> **User:** "Show me the campaigns on Network B"

Claude will:
1. Call `network_list()` → finds Network B's ID
2. Call `network_switch({ network_id: "..." })` → switches context
3. Call the relevant business tool → runs against Network B
4. Announce which network is now active

The session stays on Network B until switched again.

---

## Adding new business tools

1. Create `src/tools/yourDomainTools.ts`
2. Follow the pattern in `projectTools.ts`:
   - Always call `validateSession(sessionId)` first
   - **Never** accept `network_id` as a tool parameter
   - Use `workApiRequest(session, method, path, opts)` — auth and network are injected automatically
3. Register in `src/index.ts`:
   ```ts
   import { registerYourDomainTools } from "./tools/yourDomainTools.js";
   registerYourDomainTools(server, getSessionId);
   ```
4. Rebuild: `npm run build`

---

## Security model

**Claude never sees or controls:**
- `auth_token` (stored server-side only)
- `X-Network-ID` header (injected from `session.active_network`)
- `session_id` (lives in MCP server process memory)

**Claude only calls:**
- `network_list` → read available networks
- `network_switch(network_id)` → update active network in session
- Business tools → operate against active network, no auth params accepted

---

## Troubleshooting

**"Cannot find module" errors after changes**
→ Run `npm run build` again. The server runs compiled JS from `dist/`.

**Session lost after restart**
→ Set `REDIS_URL` in your `.env`. Without Redis, sessions are in-memory only.

**Login page unreachable**
→ Check the MCP server is running. Verify `PORT` matches the URL you're opening.

**"Invalid email or password"**
→ Use the same credentials you use on the Interlincx web app.

**Network list empty after login**
→ Check `NETWORK_API_BASE_URL` is correct. Run `network_refresh` to retry.
