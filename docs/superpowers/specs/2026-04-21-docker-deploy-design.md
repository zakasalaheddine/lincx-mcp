# Docker Deployment for lincx-mcp-server — Design Spec

**Date:** 2026-04-21
**Status:** Approved for implementation-plan phase
**Goal:** Deploy `lincx-mcp-server` to a public URL so authorized users can add a single link to their MCP client and reach the server over HTTPS.

---

## 1. Scope and constraints

### In scope
- Refactor the server from single-user (module-global session) to multi-tenant (per-MCP-session).
- Add a shared access-key gate on public endpoints.
- Dockerize the server.
- Deploy to Fly.io with Upstash Redis.
- Provide users a single `?key=` URL they paste into their MCP client.

### Out of scope
- Per-user access keys / revocation (future enhancement).
- Persistent login across MCP reconnects (Approach 2 — future enhancement).
- Automated tests (repo has none today; not introducing a test framework here).
- CI/CD pipeline. Deploys are manual `fly deploy`.
- Custom domain. `lincx-mcp.fly.dev` is the v1 URL.
- Observability stack (Sentry, metrics). `fly logs` + Redis inspection only.

### Chosen decisions (from brainstorming)
- **Deployment model:** shared multi-tenant (one URL, many users).
- **Work API reachability:** publicly reachable over HTTPS.
- **Host:** Fly.io with Upstash Redis.
- **Auth gate:** shared access key, URL-embedded (`?key=<SHARED>`).
- **Domain:** default `*.fly.dev` subdomain for v1.
- **Session stickiness:** Approach 1 — login lifetime tied to MCP session. Re-login on each Claude restart. Acceptable UX cost for v1.

---

## 2. High-level architecture

```
┌──────────────┐   https://lincx-mcp.fly.dev/mcp?key=SHARED     ┌────────────────────┐
│  MCP Client  │ ─────────────────────────────────────────────> │   Fly.io VM        │
│   (Claude)   │ <─── mcp-session-id: <uuid> on first response  │                    │
└──────┬───────┘                                                │  Node process      │
       │                                                        │  ├ Express         │
       │ user clicks login URL                                  │  │  /login (HTML)  │
       v                                                        │  │  /api/login     │
┌──────────────┐   https://lincx-mcp.fly.dev/login?t=<ticket>   │  │  /mcp           │
│   Browser    │ ─────────────────────────────────────────────> │  │  /health        │
└──────────────┘                                                │  └ MCP server      │
                                                                └──────┬─────────────┘
                                                                       │
                                     ┌─────────────────────────────────┼──────────────┐
                                     │                                 │              │
                                     v                                 v              v
                             ┌───────────────┐            ┌────────────────┐  ┌──────────────┐
                             │ Upstash Redis │            │ ix-id.lincx.la │  │ Work API     │
                             │ (sessions,    │            │ /auth/login    │  │ (public URL) │
                             │  tickets,     │            └────────────────┘  └──────────────┘
                             │  mcp↔lincx)   │
                             └───────────────┘
```

### Redis key layout (all with TTLs)

| Key | Value | TTL | Purpose |
|-----|-------|-----|---------|
| `lincx:sess:<uuid>` | `Session` JSON | 7d | The Lincx session (email, JWT, networks, active network). Unchanged from today. |
| `mcp:sess:<mcp-session-id>` | `<lincx-sess-uuid>` | 7d sliding | Maps MCP connection identity → Lincx session. New. |
| `ticket:<ticket-id>` | `<mcp-session-id>` | 10min | Single-use login correlation. New. |

One Fly machine, one Upstash Redis. Node process is stateless — any instance serves any request as long as Redis is shared.

---

## 3. Multi-tenancy refactor (inside `src/`)

### 3.1 Transport-per-session

Today `index.ts` keeps a singleton `httpTransport` with `sessionIdGenerator: undefined`. Replace with the SDK's documented multi-tenant shape:

```ts
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", async (req, res) => {
  const existingId = req.header("mcp-session-id");
  let transport = existingId ? transports.get(existingId) : undefined;

  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => transports.set(id, transport!),
    });
    transport.onclose = () => {
      if (transport!.sessionId) transports.delete(transport!.sessionId);
    };
    await server.connect(transport);
  }
  await transport.handleRequest(req, res, req.body);
});
```

`GET /mcp` and `DELETE /mcp` follow the same lookup — no lazy creation, return 404 if the session id is unknown.

### 3.2 Per-request session resolution in tool handlers

Every tool handler today calls `getSessionId()` which reads a module-global. Replace with a resolver that reads the MCP session id from the per-request `extra` arg:

```ts
// before (14 tool files)
async ({ limit }) => {
  const sessionId = getSessionId();
  // ...
}

// after
async ({ limit }, extra) => {
  const lincxSessionId = await resolveLincxSession(extra.sessionId);
  const v = await validateSession(lincxSessionId);
  // ...
}
```

`resolveLincxSession(mcpSessionId)` — reads `mcp:sess:<mcpSessionId>` from Redis → returns the Lincx session UUID (or null if no login).

**Signature change:** `registerXxxTools(server, getSessionId)` becomes `registerXxxTools(server)`. All 15 tool files get the same mechanical rewrite.

### 3.3 Deletions

The following become obsolete and are removed:

- `currentSessionId` module variable in `index.ts`
- `.sessions/session_id` file persistence
- `loadSessionId`, `persistSessionId`, `setSessionId`, `getSessionId` helpers
- The `setSessionId` callback parameter to `registerAuthTools`

### 3.4 `auth_login` tool changes

The handler now:

1. Reads `extra.sessionId` (the MCP session id).
2. Generates a ticket (`randomUUID()`).
3. `redis.SET ticket:<ticket> <mcp-session-id> EX 600`.
4. Returns login URL: `${PUBLIC_BASE_URL}/login?t=<ticket>&key=<SHARED>`.

(The URL embeds the shared access key so the browser tab is gate-authorized without the user having to paste it manually.)

### 3.5 `auth_logout` tool changes

- Reads `extra.sessionId`.
- Looks up the Lincx session UUID via `resolveLincxSession`.
- Deletes `lincx:sess:<uuid>` and `mcp:sess:<mcp-session-id>`.

### 3.6 Stdio fallback (backward compatibility)

When `TRANSPORT=stdio`, `extra.sessionId` is undefined. The resolver falls back to a single process-local session id (e.g. `"stdio"`), preserving the current local-Claude-Code dev workflow without config changes.

**Local-dev regression to accept:** the `.sessions/session_id` on-disk persistence is gone. Stdio mode now relies on the in-memory/Redis session store like HTTP mode. If you run stdio locally without `REDIS_URL`, you re-login after every process restart. Today you only get persistence across restarts if Redis is already configured (the file alone didn't save the session data), so in practice this only affects dev boxes that *had* Redis — in that case, the session itself is already persisted; you just lose the "auto-pick up the last session_id on boot" convenience. Acceptable cost; the alternative is a stdio-specific code path that adds complexity for a single-user dev convenience.

---

## 4. Auth flow with ticket correlation

```
1. User adds URL to Claude:  https://lincx-mcp.fly.dev/mcp?key=<SHARED>

2. Claude opens MCP session.
   → POST /mcp  (no mcp-session-id yet)
   → server creates transport with fresh mcp-session-id = "abc-123"
   → response header:  mcp-session-id: abc-123

3. Claude calls the auth_login tool.
   → handler reads extra.sessionId = "abc-123"
   → mints ticket "tk_xyz", Redis SET ticket:tk_xyz = "abc-123"  TTL=600s
   → returns text:  "Open this URL in your browser:
                     https://lincx-mcp.fly.dev/login?t=tk_xyz&key=<SHARED>"

4. User clicks → GET /login?t=tk_xyz&key=<SHARED>
   → server validates ticket exists in Redis (render error page if missing/expired)
   → renders login HTML, embeds t=tk_xyz in the form POST URL

5. User submits → POST /api/login?t=tk_xyz&key=<SHARED>  { email, password }
   → server loads ticket, gets mcp-session-id "abc-123"
   → loginWithCredentials(email, password)  →  JWT
   → createSession(...)                      →  lincx-session-uuid
   → Redis SET  mcp:sess:abc-123 = lincx-session-uuid  TTL=7d
   → Redis DEL  ticket:tk_xyz   (single-use)
   → respond 200, browser redirects to /login/success

6. Claude calls any business tool.
   → handler reads extra.sessionId = "abc-123"
   → resolveLincxSession("abc-123") → lincx-session-uuid
   → validateSession → workApiRequest(session, ...)
```

### Edge cases

| Case | Behavior |
|------|----------|
| Ticket missing/expired on `GET /login` | Render an error page: "This login link is expired — go back to Claude and run `auth_login` again." |
| Claude reconnects with same `mcp-session-id` | Transport re-hydrated from map; Lincx session still bound; no re-login. |
| Server restart — client sends known `mcp-session-id` | In-memory `transports` map is empty. Lazily re-create the transport for that id and reconnect. Lincx session still in Redis. |
| Two browser tabs, same ticket | Second POST fails cleanly — ticket was deleted on first POST. |

---

## 5. Access-key gate

One shared secret, held in env var `MCP_ACCESS_KEY`. A single `requireAccessKey` Express middleware checks `req.query.key` against the env var and rejects with 401 on mismatch.

### Applied on

- `POST /mcp`, `GET /mcp`, `DELETE /mcp`
- `GET /login`, `POST /api/login`

### NOT applied on

- `GET /health` — load balancer / uptime checks
- `GET /dev/tools`, `POST /dev/tools/:name` — removed from the production build (mounted only when `NODE_ENV !== "production"`)

### Config

- `MCP_ACCESS_KEY` is a required env var in production. If missing at startup, the server refuses to boot with a clear error. No default.
- Generated via `openssl rand -hex 32`.
- Stored as a Fly.io secret: `fly secrets set MCP_ACCESS_KEY=...`.
- Rotatable: set a new secret, `fly deploy`, hand users the new URL. No DB migration.

### Rate limiting (separate from the key)

`express-rate-limit` middleware:

- `POST /api/login` — 10 req/min per IP
- `POST /mcp` — 120 req/min per `mcp-session-id` (falls back to IP if header missing)

### Security note

`?key=` appears in server access logs. Fly.io logs are private to the account. README will remind the operator not to share log exports externally.

---

## 6. Docker & Fly.io deployment

### 6.1 Dockerfile (multi-stage, Node 22 Alpine)

```dockerfile
# ── build stage ──────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ── runtime stage ────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
```

### 6.2 `.dockerignore`

```
node_modules
dist
.sessions
.env*
.git
docs
*.md
```

### 6.3 `fly.toml`

```toml
app = "lincx-mcp"
primary_region = "cdg"   # Paris — close to lincx.la infrastructure

[build]

[env]
  PORT = "3000"
  TRANSPORT = "http"
  NODE_ENV = "production"
  WORK_API_BASE_URL = "https://work-api.lincx.la"   # confirm exact URL before first deploy
  IDENTITY_SERVER = "https://ix-id.lincx.la"
  PUBLIC_BASE_URL = "https://lincx-mcp.fly.dev"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"
    method = "get"
    path = "/health"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

### 6.4 Secrets

- `MCP_ACCESS_KEY` — generated once via `openssl rand -hex 32`.
- `REDIS_URL` — set automatically by `fly redis create`.

### 6.5 `PUBLIC_BASE_URL` (new env var)

Today `auth_login` builds `http://localhost:${SERVER_PORT}/login`. That doesn't work from a deployed container. Adding `PUBLIC_BASE_URL` to `constants.ts`; `authTools.ts` reads it when constructing the login URL. Falls back to `http://localhost:${SERVER_PORT}` in dev so local workflow is unaffected.

### 6.6 Deploy commands

```bash
fly launch --no-deploy                                    # one-time
fly redis create                                          # one-time, provisions Upstash + sets REDIS_URL
fly secrets set MCP_ACCESS_KEY=$(openssl rand -hex 32)    # one-time (or on rotation)
fly deploy                                                # every subsequent deploy
fly secrets list                                          # retrieve key when needed
```

### 6.7 User-facing config (what you hand out)

```json
{
  "mcpServers": {
    "lincx": {
      "url": "https://lincx-mcp.fly.dev/mcp?key=<SHARED_KEY>"
    }
  }
}
```

### 6.8 Cost expectations

- `shared-cpu-1x` / 512MB / `min_machines_running=1` → ~$2–4/month
- Upstash free tier (10k commands/day) sufficient for <20 concurrent users
- TLS certs free

---

## 7. Testing & rollout

No automated test framework exists in this repo and we're not introducing one here. Smoke testing is manual.

### 7.1 Local Docker smoke test

```bash
docker build -t lincx-mcp .
docker run --rm -p 3000:3000 \
  -e MCP_ACCESS_KEY=test \
  -e WORK_API_BASE_URL=https://work-api.lincx.la \
  -e PUBLIC_BASE_URL=http://localhost:3000 \
  -e TRANSPORT=http \
  lincx-mcp
```

Expect:
- `GET /health` → 200
- `POST /mcp?key=wrong` → 401
- `POST /mcp?key=test` with an `initialize` payload → 200 + `mcp-session-id` header

### 7.2 Two-user isolation test

- Tab A: run through login flow as user Alice (fresh MCP session id).
- Tab B: run through login flow as user Bob (second MCP session id).
- Call `auth_status` / `network_list` on each — neither sees the other's data.

### 7.3 Fly.io deploy verification

- `fly deploy`, wait for healthcheck green.
- Configure Claude with the deployed URL.
- Run `auth_login` → open URL → log in → `network_list`.

### 7.4 Rollback

- `fly releases list`
- `fly releases rollback <n>`
- No DB migration in any of this — rollback is clean.

### 7.5 Observability

- `fly logs` — stderr from the Node process.
- Redis inspection from laptop:
  ```bash
  redis-cli --tls -u $REDIS_URL keys "lincx:sess:*" | wc -l
  ```

---

## 8. File-level change summary

| File | Change |
|------|--------|
| `src/index.ts` | Remove `currentSessionId` global + file persistence. Replace singleton transport with `Map<sessionId, transport>`. Mount `requireAccessKey` on `/mcp` and `/login*`. Gate `/dev/*` behind `NODE_ENV !== "production"`. |
| `src/constants.ts` | Add `PUBLIC_BASE_URL` (defaults to `http://localhost:${SERVER_PORT}`). Add `MCP_ACCESS_KEY` (required when `NODE_ENV=production`). |
| `src/services/sessionManager.ts` | Add `resolveLincxSession(mcpSessionId)` — reads `mcp:sess:<id>` → Lincx session. Add `bindMcpToLincxSession(mcpSessionId, lincxSessionId)`. Add ticket helpers: `mintTicket(mcpSessionId)` and `consumeTicket(ticket)`. |
| `src/services/sessionStore.ts` | Extend to store ticket and `mcp:sess` keys with their own TTLs. |
| `src/tools/authTools.ts` | `auth_login`: use `extra.sessionId`, mint ticket, return `PUBLIC_BASE_URL/login?t=...&key=...`. `auth_logout`: look up and delete both `mcp:sess` and `lincx:sess` entries. Drop `setSessionId` param. |
| `src/tools/*Tools.ts` (14 files) | Mechanical rewrite: signature drops `getSessionId`, handlers read `extra.sessionId` and call `resolveLincxSession`. |
| `src/middleware/requireAccessKey.ts` | **New.** Express middleware for key check. |
| `src/middleware/rateLimit.ts` | **New.** Wraps `express-rate-limit` with our two configs. |
| `package.json` | Add `express-rate-limit` dependency. |
| `Dockerfile` | **New.** Multi-stage Node 22 Alpine. |
| `.dockerignore` | **New.** |
| `fly.toml` | **New.** |
| `CLAUDE.md` | Update: new env vars (`PUBLIC_BASE_URL`, `MCP_ACCESS_KEY`), deployment section, removal of `.sessions/` file. |
| `README.md` | Update: deployed URL, `fly deploy` workflow, key rotation. |

---

## 9. Open questions / confirmations needed before implementation

1. **Work API public URL** — `fly.toml` uses `https://work-api.lincx.la` as a placeholder. Confirm the exact URL.
2. **Fly.io app name** — `lincx-mcp` is suggested; confirm it's available or pick a different name.
3. **Fly.io region** — `cdg` (Paris) chosen as a guess based on `.la` TLD heuristic. Confirm or override.

These don't block implementation — they're knobs to fill in at deploy time, not design decisions.
