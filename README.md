# work-mcp-server

MCP server with OAuth authentication, Redis-backed sessions, and multi-network support.

---

## Architecture

```
src/
├── index.ts                  # Entry point — MCP server + OAuth callback HTTP server
├── types.ts                  # Shared TypeScript types
├── constants.ts              # Env vars and tunable constants
│
├── services/
│   ├── auth.ts               # OAuth: login URL, code exchange, token refresh, revoke
│   ├── sessionStore.ts       # Redis (or in-memory) session persistence
│   ├── sessionManager.ts     # Session lifecycle: create, validate, switch network, destroy
│   ├── networkService.ts     # Fetch user's networks from Network Service API
│   └── workApi.ts            # Authenticated HTTP client for Work API (injects token + network)
│
└── tools/
    ├── authTools.ts           # auth_login, auth_status, auth_logout
    ├── networkTools.ts        # network_list, network_switch, network_refresh
    └── projectTools.ts        # projects_list, projects_get  ← add your business tools here
```

---

## Security Model

**The client (Claude) never controls:**
- `access_token`
- `network_id` / `X-Network-ID` header
- Session ID

**The client only calls:**
- `network_list` → read available networks
- `network_switch(network_id)` → change active network
- Business tools (projects_list, etc.) → work against active network automatically

The MCP server injects auth headers and network context on every request.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:
```
OAUTH_CLIENT_ID=your_client_id
OAUTH_CLIENT_SECRET=your_client_secret
OAUTH_REDIRECT_URI=http://localhost:3000/callback
OAUTH_AUTH_URL=https://your-auth-server.com/authorize
OAUTH_TOKEN_URL=https://your-auth-server.com/token
WORK_API_BASE_URL=https://your-work-api.com
NETWORK_API_BASE_URL=https://your-network-api.com
REDIS_URL=redis://localhost:6379
PORT=3000
TRANSPORT=stdio
```

### 3. Build

```bash
npm run build
```

### 4. Run

**stdio mode (Claude Code / local IDE):**
```bash
npm start
```

**HTTP mode (remote / multi-client):**
```bash
TRANSPORT=http npm start
```

---

## Claude Code Configuration

Add to `~/.claude/mcp_settings.json`:

```json
{
  "mcpServers": {
    "work": {
      "command": "node",
      "args": ["/path/to/work-mcp-server/dist/index.js"],
      "env": {
        "OAUTH_CLIENT_ID": "...",
        "OAUTH_CLIENT_SECRET": "...",
        "WORK_API_BASE_URL": "https://your-api.com",
        "NETWORK_API_BASE_URL": "https://your-network-api.com"
      }
    }
  }
}
```

---

## Tool Reference

### Auth Tools
| Tool | Description |
|------|-------------|
| `auth_login` | Generate OAuth URL for browser login |
| `auth_status` | Check current session and active network |
| `auth_logout` | Destroy session and revoke tokens |

### Network Tools
| Tool | Description |
|------|-------------|
| `network_list` | List all accessible networks |
| `network_switch(network_id)` | Change active network |
| `network_refresh` | Re-fetch networks from Network Service |

### Business Tools (extend these)
| Tool | Description |
|------|-------------|
| `projects_list` | List projects on active network |
| `projects_get(project_id)` | Get a specific project |

---

## Adding New Business Tools

1. Create `src/tools/yourDomainTools.ts`
2. Follow the pattern in `projectTools.ts`:
   - Always call `validateSession()` first
   - Never accept `network_id` as a parameter
   - Use `workApiRequest(session, ...)` — it injects auth and network automatically
3. Register in `index.ts`: `registerYourDomainTools(server, getSessionId)`

---

## Natural Language Network Switching

Claude handles this automatically. When a user says:

> "What are the campaigns on Network B?"

Claude will:
1. Call `network_list()` to find Network B's ID
2. Call `network_switch({ network_id: "..." })`
3. Call the relevant business tool
4. Inform the user which network is now active

The session remains on Network B until switched again.
