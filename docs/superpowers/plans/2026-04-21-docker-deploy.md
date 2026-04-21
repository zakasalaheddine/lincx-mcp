# Docker Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `lincx-mcp-server` deployable as a shared multi-tenant service on Fly.io with a single URL users paste into their MCP client.

**Architecture:** Refactor from single-user (module-global session) to multi-tenant (transport-per-MCP-session, Redis-backed). Add shared-access-key gate. Dockerize with Node 22 Alpine. Deploy to Fly.io with Upstash Redis.

**Tech Stack:** Node 22, TypeScript (ESM, NodeNext), `@modelcontextprotocol/sdk` ≥1.12, Express 4, ioredis, `express-rate-limit` (new), Docker, Fly.io, Upstash Redis.

**Spec reference:** `docs/superpowers/specs/2026-04-21-docker-deploy-design.md`

**Verification model:** This repo has no test framework. Each code task ends with `npm run build` (must succeed) and, where applicable, a manual smoke step (curl/docker). `npm run build` is the primary fast-feedback loop — treat a failing build as a failing test.

---

## File Map

| File | Status | Responsibility |
|------|--------|----------------|
| `src/constants.ts` | Modify | Add `PUBLIC_BASE_URL`, `MCP_ACCESS_KEY`, `NODE_ENV` exports. |
| `src/services/sessionStore.ts` | Modify | Drop file-backed fallback. Expose generic `redis`/`memory` KV helpers so tickets and mcp-bindings can share the store. |
| `src/services/sessionManager.ts` | Modify | Add `resolveLincxSession`, `bindMcpToLincxSession`, `unbindMcpSession`, `mintTicket`, `consumeTicket`. |
| `src/middleware/requireAccessKey.ts` | **Create** | Express middleware — checks `?key=` against `MCP_ACCESS_KEY`. |
| `src/middleware/rateLimit.ts` | **Create** | Two rate-limit configs: login + MCP. |
| `src/tools/authTools.ts` | Modify | Ticket-based login URL; use `extra.sessionId`; drop `setSessionId` param. |
| `src/tools/*Tools.ts` (14 files) | Modify | Drop `getSessionId` param. Handlers read `extra.sessionId` + call `resolveLincxSession`. |
| `src/index.ts` | Modify | Transport-per-session map. Mount middleware. Remove module-global `currentSessionId` and `.sessions/session_id` file. Gate `/dev/*` routes on `NODE_ENV`. Ticket-aware login routes. |
| `.gitignore` | Modify | Remove `.sessions/` if present (or leave — dir is gone). |
| `.sessions/` | Delete | On-disk session files (entire dir). |
| `package.json` | Modify | Add `express-rate-limit` dependency. |
| `Dockerfile` | **Create** | Multi-stage, Node 22 Alpine, non-root user, healthcheck. |
| `.dockerignore` | **Create** | Exclude node_modules, dist, .sessions, .env, .git, docs. |
| `fly.toml` | **Create** | Fly.io app config. |
| `CLAUDE.md` | Modify | New env vars, deployment section, removed `.sessions/`. |
| `README.md` | Modify | Deployed URL + `fly deploy` workflow. |

---

## Task 1: Install `express-rate-limit`

**Files:**
- Modify: `package.json` (+ `package-lock.json` auto-updated)

- [ ] **Step 1: Install the dependency**

Run from `/Users/salaheddinezaka/Documents/work/mcp`:

```bash
npm install express-rate-limit@^7
```

Expected: `package.json` now lists `"express-rate-limit": "^7.x.x"` under `dependencies`.

- [ ] **Step 2: Verify build still compiles**

```bash
npm run build
```

Expected: Exits 0, `dist/` is regenerated, no new TS errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add express-rate-limit for /api/login and /mcp throttling"
```

---

## Task 2: Simplify sessionStore — add generic KV, remove file-backed fallback

**Why this first:** later tasks need Redis primitives for ticket and mcp-session keys. The current file-backed fallback is only needed for single-user dev convenience and will confuse the refactor.

**Files:**
- Modify: `src/services/sessionStore.ts` (full rewrite of module body)

- [ ] **Step 1: Replace `src/services/sessionStore.ts` with the new version**

Overwrite the file entirely with this content:

```ts
/**
 * services/sessionStore.ts
 *
 * Key-value store backed by Redis (when REDIS_URL is set) or an in-memory
 * Map with TTL (dev only — lost on process restart).
 *
 * Stores three kinds of keys:
 *   lincx:session:<uuid>      → Session JSON (7d)
 *   mcp:session:<id>          → lincx session uuid (7d)
 *   ticket:<id>               → mcp session id (10min)
 *
 * The store is a generic string KV with TTL — the caller owns key naming.
 */

import type { Session } from "../types.js";
import { REDIS_URL, SESSION_TTL_SECONDS } from "../constants.js";

export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

let _kv: KvStore | null = null;

export async function getKvStore(): Promise<KvStore> {
  if (_kv) return _kv;

  if (REDIS_URL) {
    const { Redis } = await import("ioredis");
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
    _kv = {
      async get(key) { return await redis.get(key); },
      async set(key, value, ttl) { await redis.setex(key, ttl, value); },
      async delete(key) { await redis.del(key); },
    };
    console.error("[SessionStore] Using Redis");
  } else {
    const mem = new Map<string, { value: string; expiresAt: number }>();
    _kv = {
      async get(key) {
        const e = mem.get(key);
        if (!e) return null;
        if (Date.now() > e.expiresAt) { mem.delete(key); return null; }
        return e.value;
      },
      async set(key, value, ttl) {
        mem.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
      },
      async delete(key) { mem.delete(key); },
    };
    console.error("[SessionStore] No REDIS_URL — using in-memory store (dev only)");
  }

  return _kv;
}

// ── Typed Lincx-session accessors (backwards-compat façade) ───────────────

const LINCX_PREFIX = "lincx:session:";

export interface SessionStore {
  get(sessionId: string): Promise<Session | null>;
  set(sessionId: string, session: Session): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

export async function getSessionStore(): Promise<SessionStore> {
  const kv = await getKvStore();
  return {
    async get(id) {
      const raw = await kv.get(LINCX_PREFIX + id);
      if (!raw) return null;
      try { return JSON.parse(raw) as Session; } catch { return null; }
    },
    async set(id, session) {
      await kv.set(LINCX_PREFIX + id, JSON.stringify(session), SESSION_TTL_SECONDS);
    },
    async delete(id) {
      await kv.delete(LINCX_PREFIX + id);
    },
  };
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: Exits 0. (No consumers of the removed file APIs — `getSessionStore` signature is unchanged, `.sessions/store.json` logic is gone but nothing imports it directly.)

- [ ] **Step 3: Remove the now-obsolete `.sessions/` directory**

```bash
rm -rf /Users/salaheddinezaka/Documents/work/mcp/.sessions
```

- [ ] **Step 4: Commit**

```bash
git add src/services/sessionStore.ts
git add -A .sessions 2>/dev/null || true
git commit -m "refactor(sessionStore): generic KV + drop file-backed dev fallback"
```

---

## Task 3: Add session/ticket helpers to sessionManager

**Files:**
- Modify: `src/services/sessionManager.ts`

- [ ] **Step 1: Append new functions to `src/services/sessionManager.ts`**

Add these exports at the end of the file (after `destroySession`):

```ts
// ── MCP-session ↔ Lincx-session binding ──────────────────────────────────────

import { getKvStore } from "./sessionStore.js";
// (move this import to the top of the file — shown here for clarity)

const MCP_PREFIX = "mcp:session:";
const TICKET_PREFIX = "ticket:";
const TICKET_TTL_SECONDS = 600;   // 10 min

/** Resolve an MCP session id to its bound Lincx session id. */
export async function resolveLincxSession(
  mcpSessionId: string | undefined
): Promise<string | null> {
  // Stdio fallback: when no MCP session id, use a fixed local id.
  const id = mcpSessionId ?? "stdio";
  const kv = await getKvStore();
  return await kv.get(MCP_PREFIX + id);
}

/** Bind an MCP session id to a Lincx session id. */
export async function bindMcpToLincxSession(
  mcpSessionId: string | undefined,
  lincxSessionId: string
): Promise<void> {
  const id = mcpSessionId ?? "stdio";
  const kv = await getKvStore();
  await kv.set(MCP_PREFIX + id, lincxSessionId, SESSION_TTL_SECONDS);
}

/** Unbind (logout) an MCP session — leaves the Lincx session itself for destroy. */
export async function unbindMcpSession(
  mcpSessionId: string | undefined
): Promise<void> {
  const id = mcpSessionId ?? "stdio";
  const kv = await getKvStore();
  await kv.delete(MCP_PREFIX + id);
}

// ── Login tickets (single-use, short-lived) ──────────────────────────────────

/** Mint a ticket that correlates a browser login back to an MCP session. */
export async function mintTicket(
  mcpSessionId: string | undefined
): Promise<string> {
  const id = mcpSessionId ?? "stdio";
  const ticket = uuidv4();
  const kv = await getKvStore();
  await kv.set(TICKET_PREFIX + ticket, id, TICKET_TTL_SECONDS);
  return ticket;
}

/** Consume a ticket (single-use). Returns the MCP session id it was minted for, or null. */
export async function consumeTicket(ticket: string): Promise<string | null> {
  const kv = await getKvStore();
  const mcpSessionId = await kv.get(TICKET_PREFIX + ticket);
  if (!mcpSessionId) return null;
  await kv.delete(TICKET_PREFIX + ticket);
  return mcpSessionId;
}

/** Peek a ticket without consuming — used by GET /login to pre-validate. */
export async function peekTicket(ticket: string): Promise<boolean> {
  const kv = await getKvStore();
  const v = await kv.get(TICKET_PREFIX + ticket);
  return v !== null;
}
```

Also **add `SESSION_TTL_SECONDS` to the existing import** at the top of the file:

```ts
// before
import { getSessionStore } from "./sessionStore.js";

// after
import { getSessionStore, getKvStore } from "./sessionStore.js";
import { SESSION_TTL_SECONDS } from "../constants.js";
```

Remove the duplicate `import { getKvStore } from "./sessionStore.js";` line shown in the appended block above — it's there for clarity but the real import belongs at the top.

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: Exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/services/sessionManager.ts
git commit -m "feat(session): add mcp-session binding + ticket helpers"
```

---

## Task 4: Extend constants

**Files:**
- Modify: `src/constants.ts`

- [ ] **Step 1: Replace `src/constants.ts` entirely with:**

```ts
export const CHARACTER_LIMIT = 25_000;

// 7-day session TTL in Redis / in-memory store
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

// Lincx identity server (authentic-server)
export const IDENTITY_SERVER =
  process.env.IDENTITY_SERVER ?? "https://ix-id.lincx.la";

// Work API base URL — all requests go here, including network discovery
// Networks are multi-tenant via ?networkId=<id> query param on every request
export const WORK_API_BASE_URL =
  process.env.WORK_API_BASE_URL ?? "http://localhost:3050";

// Redis connection string — leave empty to use in-memory store (dev only)
export const REDIS_URL = process.env.REDIS_URL ?? "";

// Port for the Express HTTP server (login UI + MCP HTTP transport)
export const SERVER_PORT = parseInt(process.env.PORT ?? "5001", 10);

// Transport: "stdio" (default, Claude Code) or "http" (remote)
export const TRANSPORT = process.env.TRANSPORT ?? "stdio";

// NODE_ENV — "production" disables the /dev/* debug routes and enforces MCP_ACCESS_KEY
export const NODE_ENV = process.env.NODE_ENV ?? "development";
export const IS_PRODUCTION = NODE_ENV === "production";

// Public base URL used when building login links returned to Claude
// In dev, defaults to http://localhost:<PORT>; in prod, set to the Fly hostname.
export const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ?? `http://localhost:${SERVER_PORT}`;

// Shared access key guarding /mcp and /login in multi-tenant deploys.
// REQUIRED in production. In dev, optional — absence means no gate.
export const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY ?? "";

if (IS_PRODUCTION && !MCP_ACCESS_KEY) {
  console.error("[FATAL] MCP_ACCESS_KEY is required when NODE_ENV=production");
  process.exit(1);
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: Exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/constants.ts
git commit -m "feat(constants): add PUBLIC_BASE_URL, MCP_ACCESS_KEY, NODE_ENV"
```

---

## Task 5: Create `requireAccessKey` middleware

**Files:**
- Create: `src/middleware/requireAccessKey.ts`

- [ ] **Step 1: Create the file with this content:**

```ts
/**
 * middleware/requireAccessKey.ts
 *
 * Checks `?key=<token>` against the MCP_ACCESS_KEY env var.
 * Applied to /mcp and /login endpoints in production.
 *
 * In dev (MCP_ACCESS_KEY empty), the middleware is a no-op — useful for local
 * Docker runs without having to set a key.
 */

import type { Request, Response, NextFunction } from "express";
import { MCP_ACCESS_KEY } from "../constants.js";

export function requireAccessKey(req: Request, res: Response, next: NextFunction): void {
  if (!MCP_ACCESS_KEY) {
    // No key configured — gate disabled (dev mode only; prod refuses to boot without it)
    next();
    return;
  }
  const provided = typeof req.query.key === "string" ? req.query.key : undefined;
  if (!provided || provided !== MCP_ACCESS_KEY) {
    res.status(401).json({ error: "Invalid or missing access key." });
    return;
  }
  next();
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: Exits 0.

- [ ] **Step 3: Commit**

```bash
git add src/middleware/requireAccessKey.ts
git commit -m "feat(middleware): access-key gate for /mcp and /login"
```

---

## Task 6: Create `rateLimit` middleware

**Files:**
- Create: `src/middleware/rateLimit.ts`

- [ ] **Step 1: Create the file with this content:**

```ts
/**
 * middleware/rateLimit.ts
 *
 * Two configs:
 *   loginLimiter — /api/login — 10 req/min per IP
 *   mcpLimiter   — /mcp       — 120 req/min per mcp-session-id (IP fallback)
 */

import rateLimit, { ipKeyGenerator } from "express-rate-limit";

export const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many login attempts — try again in a minute." },
});

export const mcpLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => {
    const id = req.header("mcp-session-id");
    return id ?? ipKeyGenerator(req.ip ?? "unknown");
  },
  message: { error: "Rate limit exceeded for this MCP session." },
});
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: Exits 0. If `ipKeyGenerator` isn't exported in this version, swap the `keyGenerator` body to `return req.header("mcp-session-id") ?? req.ip ?? "unknown";` (the v7 helper is the safer default for IPv6 — but either works).

- [ ] **Step 3: Commit**

```bash
git add src/middleware/rateLimit.ts
git commit -m "feat(middleware): rate limits for /api/login and /mcp"
```

---

## Task 7: Refactor business tool files (14 files, one shared pattern)

**Why batch this:** every business tool file has the same single-user pattern; they must all change together because the registration signature is changing.

**Files modified (14 total):**
- `src/tools/networkTools.ts`
- `src/tools/templateTools.ts`
- `src/tools/creativeAssetGroupTools.ts`
- `src/tools/zoneTools.ts`
- `src/tools/adTools.ts`
- `src/tools/adGroupTools.ts`
- `src/tools/creativeTools.ts`
- `src/tools/campaignTools.ts`
- `src/tools/channelTools.ts`
- `src/tools/siteTools.ts`
- `src/tools/publisherTools.ts`
- `src/tools/advertiserTools.ts`
- `src/tools/experienceTools.ts`
- `src/tools/reportingTools.ts`

**The uniform transformation (apply to every file above):**

1. Signature change on the `register*Tools` function:
   - **Before:** `export function registerXxxTools(server: McpServer, getSessionId: () => string | null): void {`
   - **After:** `export function registerXxxTools(server: McpServer): void {`

2. Add the import (alongside existing ones):
   ```ts
   import { validateSession, resolveLincxSession } from "../services/sessionManager.js";
   ```
   (some files already import `validateSession`; just add `resolveLincxSession` to the same line)

3. In **every** `server.registerTool(..., async (args) => { … })` handler, change:
   - The handler signature: add a second parameter `extra: { sessionId?: string }`.
   - The session-resolution block.

   **Before:**
   ```ts
   }, async ({ limit, offset }) => {
     const sessionId = getSessionId();
     if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

     const v = await validateSession(sessionId);
     if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };
   ```

   **After:**
   ```ts
   }, async ({ limit, offset }, extra) => {
     const sessionId = await resolveLincxSession(extra?.sessionId);
     if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

     const v = await validateSession(sessionId);
     if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };
   ```

   (The arg destructuring before `}` and the rest of the handler body are untouched.)

**Worked example — `src/tools/networkTools.ts` full diff-equivalent rewrite:**

- [ ] **Step 1: Open `src/tools/networkTools.ts` and read it once** to understand its shape; then apply the transformation above.

The result should look like:

```ts
// … existing imports …
import { validateSession, resolveLincxSession, switchNetwork, refreshNetworks } from "../services/sessionManager.js";
// (keep all other existing imports unchanged)

export function registerNetworkTools(server: McpServer): void {

  server.registerTool("network_list", {
    // … existing schema unchanged …
  }, async (_args, extra) => {
    const sessionId = await resolveLincxSession(extra?.sessionId);
    if (!sessionId) return { content: [{ type: "text" as const, text: "Error: Not authenticated. Use 'auth_login' first." }] };

    const v = await validateSession(sessionId);
    if (!v.valid || !v.session) return { content: [{ type: "text" as const, text: `Error: ${v.error}` }] };

    // … rest of existing handler body unchanged …
  });

  // … apply the same two-line change to every other registerTool handler in this file …
}
```

- [ ] **Step 2: Apply the same transformation to every other business tool file** in the list above. Each file: change signature, update import, edit every handler.

**Note on tools with no args:** handlers declared as `async () => {` become `async (_args, extra) => {` — the first positional arg is the schema output; you can ignore it with `_args` if unused.

**Note on `reportingTools.ts` and `zoneTools.ts`:** these have composite/multi-step tools with several `workApiRequest` calls per handler. The session-resolution pattern applies once at the top of each handler, same as the simple tools.

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: **This will fail** — index.ts still calls each `registerXxxTools(server, getSessionId)` with two args, but we just changed them to accept one. That's fine; Task 8 rewires index.ts, and we commit Task 7 + Task 8 sequentially without an intermediate green build. Skip ahead to Task 8 before committing this one.

- [ ] **Step 4: DO NOT COMMIT YET** — proceed to Task 8. The build becomes green again at the end of Task 8; the two tasks form a single atomic change from Git's perspective.

---

## Task 8: Refactor `authTools.ts` for ticket-based flow

**Files:**
- Modify: `src/tools/authTools.ts`

- [ ] **Step 1: Replace `src/tools/authTools.ts` entirely with:**

```ts
/**
 * tools/authTools.ts
 *
 * auth_login  — returns a per-MCP-session browser login URL (with ticket).
 * auth_status — reports current session state.
 * auth_logout — unbinds this MCP session and destroys its Lincx session.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  destroySession,
  resolveLincxSession,
  mintTicket,
  unbindMcpSession,
} from "../services/sessionManager.js";
import { getSessionStore } from "../services/sessionStore.js";
import { PUBLIC_BASE_URL, MCP_ACCESS_KEY } from "../constants.js";

function buildLoginUrl(ticket: string): string {
  const base = `${PUBLIC_BASE_URL}/login?t=${encodeURIComponent(ticket)}`;
  return MCP_ACCESS_KEY ? `${base}&key=${encodeURIComponent(MCP_ACCESS_KEY)}` : base;
}

export function registerAuthTools(server: McpServer): void {

  // ── auth_login ────────────────────────────────────────────────────────────
  server.registerTool(
    "auth_login",
    {
      title: "Login",
      description: `Open the browser login page to authenticate with Interlincx.

Returns a URL the user must open in their browser.
Credentials are entered there and sent directly to the identity server — Claude never sees them.

The URL is single-use and tied to this MCP session; it expires in 10 minutes.
After the user completes login, call 'auth_status' to confirm the session is active.

Returns: { login_url: string, message: string }`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (_args, extra) => {
      const ticket = await mintTicket(extra?.sessionId);
      const url = buildLoginUrl(ticket);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            login_url: url,
            message: `Open ${url} in your browser, log in, then come back here and call 'auth_status'.`,
          }, null, 2),
        }],
      };
    }
  );

  // ── auth_status ───────────────────────────────────────────────────────────
  server.registerTool(
    "auth_status",
    {
      title: "Auth Status",
      description: `Check current authentication status and session details.

Returns:
  - authenticated (boolean)
  - email (string)
  - active_network: currently selected network ID
  - available_networks: all networks accessible to the user

Use after 'auth_login' to confirm the session is ready.`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_args, extra) => {
      const sessionId = await resolveLincxSession(extra?.sessionId);

      if (!sessionId) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              authenticated: false,
              message: "Not logged in. Use 'auth_login' to get the browser login URL.",
            }),
          }],
        };
      }

      const store = await getSessionStore();
      const session = await store.get(sessionId);

      if (!session) {
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              authenticated: false,
              message: "Session expired. Use 'auth_login' to re-authenticate.",
            }),
          }],
        };
      }

      const status = {
        authenticated: true,
        email: session.email,
        active_network: session.active_network,
        available_networks: session.networks,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(status, null, 2) }],
        structuredContent: status,
      };
    }
  );

  // ── auth_logout ───────────────────────────────────────────────────────────
  server.registerTool(
    "auth_logout",
    {
      title: "Logout",
      description: `Destroy the current session and clear all auth context.

The user will need to log in again via the browser to continue.`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (_args, extra) => {
      const sessionId = await resolveLincxSession(extra?.sessionId);
      if (!sessionId) {
        return { content: [{ type: "text" as const, text: "No active session to log out from." }] };
      }
      await destroySession(sessionId);
      await unbindMcpSession(extra?.sessionId);
      return { content: [{ type: "text" as const, text: "Logged out. Session cleared." }] };
    }
  );
}
```

- [ ] **Step 2: DO NOT BUILD YET** — proceed to Task 9. Build becomes green after index.ts is rewired.

---

## Task 9: Rewire `index.ts` (transport-per-session, middleware, ticket-aware login)

**Files:**
- Modify: `src/index.ts` (substantial rewrite)

- [ ] **Step 1: Replace `src/index.ts` entirely with the content below.**

```ts
/**
 * index.ts — Lincx MCP Server entry point
 *
 * Two surfaces on the same Express app:
 *  1. HTTP login UI (GET /login, POST /api/login, GET /login/success)
 *  2. MCP Streamable HTTP transport (POST|GET|DELETE /mcp)
 *
 * In stdio mode, the MCP server is connected over stdin/stdout instead of /mcp;
 * the Express app still serves the login UI on SERVER_PORT for local dev.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { randomUUID } from "node:crypto";
import { loginWithCredentials } from "./services/auth.js";
import { createSession, consumeTicket, peekTicket, bindMcpToLincxSession } from "./services/sessionManager.js";
import { registerAuthTools } from "./tools/authTools.js";
import { registerNetworkTools } from "./tools/networkTools.js";
import { registerTemplateTools } from "./tools/templateTools.js";
import { registerCreativeAssetGroupTools } from "./tools/creativeAssetGroupTools.js";
import { registerZoneTools } from "./tools/zoneTools.js";
import { registerAdTools } from "./tools/adTools.js";
import { registerAdGroupTools } from "./tools/adGroupTools.js";
import { registerCreativeTools } from "./tools/creativeTools.js";
import { registerCampaignTools } from "./tools/campaignTools.js";
import { registerChannelTools } from "./tools/channelTools.js";
import { registerSiteTools } from "./tools/siteTools.js";
import { registerPublisherTools } from "./tools/publisherTools.js";
import { registerAdvertiserTools } from "./tools/advertiserTools.js";
import { registerExperienceTools } from "./tools/experienceTools.js";
import { registerReportingTools } from "./tools/reportingTools.js";
import { requireAccessKey } from "./middleware/requireAccessKey.js";
import { loginLimiter, mcpLimiter } from "./middleware/rateLimit.js";
import { SERVER_PORT, TRANSPORT, IDENTITY_SERVER, IS_PRODUCTION } from "./constants.js";

// ─────────────────────────────────────────────────────────────────────────────
// MCP SERVER
// ─────────────────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "lincx-mcp-server", version: "1.0.0" });

registerAuthTools(server);
registerNetworkTools(server);
registerTemplateTools(server);
registerCreativeAssetGroupTools(server);
registerZoneTools(server);
registerAdTools(server);
registerAdGroupTools(server);
registerCreativeTools(server);
registerCampaignTools(server);
registerChannelTools(server);
registerSiteTools(server);
registerPublisherTools(server);
registerAdvertiserTools(server);
registerExperienceTools(server);
registerReportingTools(server);

// ─────────────────────────────────────────────────────────────────────────────
// EXPRESS
// ─────────────────────────────────────────────────────────────────────────────

const app = express();
app.set("trust proxy", 1);   // behind Fly proxy; needed for correct rate-limit IPs
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── /health (no auth) ────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// ── Login UI (access-key gated) ──────────────────────────────────────────────
app.get("/login", requireAccessKey, async (req, res) => {
  const ticket = typeof req.query.t === "string" ? req.query.t : "";
  const valid = ticket ? await peekTicket(ticket) : false;
  res.setHeader("Content-Type", "text/html");
  if (!valid) {
    res.status(400).send(buildTicketErrorPage());
    return;
  }
  res.send(buildLoginPage(ticket));
});

app.post("/api/login", requireAccessKey, loginLimiter, async (req, res) => {
  const ticket = typeof req.query.t === "string" ? req.query.t : "";
  const { email, password } = req.body as { email?: string; password?: string };

  if (!ticket) {
    res.status(400).json({ success: false, error: "Missing ticket." });
    return;
  }
  if (!email || !password) {
    res.status(400).json({ success: false, error: "Email and password are required." });
    return;
  }

  const mcpSessionId = await consumeTicket(ticket);
  if (!mcpSessionId) {
    res.status(400).json({ success: false, error: "This login link has expired. Return to Claude and run auth_login again." });
    return;
  }

  try {
    const { authToken } = await loginWithCredentials(email, password);
    const session = await createSession({ user_id: email, email, auth_token: authToken });
    await bindMcpToLincxSession(mcpSessionId, session.session_id);
    console.error(`[Auth] Login OK: ${email} → mcp:${mcpSessionId}`);
    res.json({ success: true, email: session.email, networks: session.networks, active_network: session.active_network });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Login failed";
    console.warn(`[Auth] Login failed for ${email}: ${message}`);
    res.status(401).json({ success: false, error: message });
  }
});

app.get("/login/success", requireAccessKey, (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(buildSuccessPage());
});

// ── Dev debug routes (non-production only) ───────────────────────────────────
if (!IS_PRODUCTION) {
  const registeredTools = (server as unknown as { _registeredTools: Record<string, { description?: string; handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }> })._registeredTools;

  app.get("/dev/tools", (_req, res) => {
    const tools = Object.entries(registeredTools).map(([name, t]) => ({ name, description: t.description }));
    res.json({ tools });
  });

  app.post("/dev/tools/:name", async (req, res) => {
    const tool = registeredTools[req.params.name];
    if (!tool) { res.status(404).json({ error: `Tool '${req.params.name}' not found` }); return; }
    try {
      const result = await tool.handler(req.body ?? {}, { sessionId: "stdio" });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

// ── MCP HTTP transport — per-session ────────────────────────────────────────
const transports = new Map<string, StreamableHTTPServerTransport>();

async function getOrCreateTransport(sessionId: string | undefined): Promise<StreamableHTTPServerTransport> {
  if (sessionId && transports.has(sessionId)) return transports.get(sessionId)!;

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      transports.set(id, transport);
      console.error(`[MCP]    session initialized: ${id}`);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId);
      console.error(`[MCP]    session closed: ${transport.sessionId}`);
    }
  };
  await server.connect(transport);
  return transport;
}

app.post("/mcp", requireAccessKey, mcpLimiter, async (req, res) => {
  const existingId = req.header("mcp-session-id");
  const transport = await getOrCreateTransport(existingId);
  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", requireAccessKey, async (req, res) => {
  const existingId = req.header("mcp-session-id");
  if (!existingId || !transports.has(existingId)) {
    res.status(404).json({ error: "Unknown MCP session." });
    return;
  }
  await transports.get(existingId)!.handleRequest(req, res);
});

app.delete("/mcp", requireAccessKey, async (req, res) => {
  const existingId = req.header("mcp-session-id");
  if (!existingId || !transports.has(existingId)) {
    res.status(404).end();
    return;
  }
  await transports.get(existingId)!.handleRequest(req, res);
});

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const httpServer = app.listen(SERVER_PORT);
  httpServer.on("listening", () => {
    console.error(`[HTTP]   Listening on :${SERVER_PORT}`);
    console.error(`[HTTP]   /health, /login, /mcp`);
  });
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[HTTP]   Port ${SERVER_PORT} in use — aborting.`);
      process.exit(1);
    } else {
      console.error("[HTTP]   Server error:", err.message);
      process.exit(1);
    }
  });

  if (TRANSPORT === "http") {
    console.error(`[MCP]    HTTP transport ready`);
  } else {
    const stdio = new StdioServerTransport();
    await server.connect(stdio);
    console.error("[MCP]    stdio transport active");
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// HTML templates
// ─────────────────────────────────────────────────────────────────────────────

function buildLoginPage(ticket: string): string {
  const safeTicket = encodeURIComponent(ticket);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Interlincx — Sign In</title>
  <link rel="preconnect" href="https://fonts.googleapis.com"/>
  <link href="https://fonts.googleapis.com/css2?family=Syne:wght@400;500;700;800&family=DM+Mono:wght@300;400;500&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0a0a0f;--surface:#111118;--border:#1e1e2e;--text:#e8e8f0;--muted:#6b6b8a;--accent:#6c63ff;--accent-dim:#3d3980;--accent-glow:rgba(108,99,255,.15);--error:#ff6b6b;--success:#63ffb4;--ff:'Syne',sans-serif;--fm:'DM Mono',monospace}
    html,body{height:100%;background:var(--bg);color:var(--text);font-family:var(--ff);-webkit-font-smoothing:antialiased}
    body{display:flex;align-items:center;justify-content:center;min-height:100vh;overflow:hidden;position:relative}
    .card{position:relative;z-index:1;width:420px;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:48px 44px 44px;box-shadow:0 32px 64px rgba(0,0,0,.5)}
    h1{font-size:26px;font-weight:800;letter-spacing:-.02em;line-height:1.2;margin-bottom:6px}
    .sub{font-family:var(--fm);font-size:12px;font-weight:300;color:var(--muted);letter-spacing:.04em;margin-bottom:36px}
    .field{margin-bottom:18px}
    label{display:block;font-family:var(--fm);font-size:11px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px}
    input{width:100%;background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:var(--fm);font-size:14px;padding:13px 16px;outline:none;transition:border-color .15s,box-shadow .15s}
    input:focus{border-color:var(--accent-dim);box-shadow:0 0 0 3px var(--accent-glow)}
    .btn{width:100%;margin-top:8px;padding:14px;background:var(--accent);color:#fff;font-family:var(--ff);font-size:14px;font-weight:700;letter-spacing:.04em;border:none;border-radius:8px;cursor:pointer}
    .btn:hover{background:#7c74ff}
    .btn:disabled{opacity:.5;cursor:not-allowed}
    .errmsg{display:none;background:rgba(255,107,107,.08);border:1px solid rgba(255,107,107,.25);border-radius:8px;color:var(--error);font-family:var(--fm);font-size:12px;padding:12px 14px;margin-top:16px}
    .errmsg.show{display:block}
    hr{border:none;border-top:1px solid var(--border);margin:28px 0 20px}
    .foot{font-family:var(--fm);font-size:11px;color:var(--muted);text-align:center;line-height:1.6}
  </style>
</head>
<body>
  <div class="card">
    <h1>Sign in</h1>
    <p class="sub">// credentials stay server-side — never sent to Claude</p>
    <div class="field">
      <label for="email">Email address</label>
      <input type="email" id="email" autocomplete="email" autofocus/>
    </div>
    <div class="field">
      <label for="password">Password</label>
      <input type="password" id="password" autocomplete="current-password"/>
    </div>
    <button class="btn" id="btn" onclick="go()">Sign in</button>
    <div class="errmsg" id="err"></div>
    <hr/>
    <p class="foot">POST → ${IDENTITY_SERVER}/auth/login</p>
  </div>
  <script>
    const TICKET = "${safeTicket}";
    const KEY = new URLSearchParams(window.location.search).get('key') || '';
    const POST_URL = '/api/login?t=' + encodeURIComponent(TICKET) + (KEY ? '&key=' + encodeURIComponent(KEY) : '');
    document.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
    async function go() {
      const email = document.getElementById('email').value.trim();
      const pw = document.getElementById('password').value;
      const btn = document.getElementById('btn');
      const err = document.getElementById('err');
      err.classList.remove('show');
      if (!email || !pw) { showErr('Please enter email and password.'); return; }
      btn.disabled = true;
      try {
        const r = await fetch(POST_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) });
        const d = await r.json();
        if (d.success) { window.location.href = '/login/success' + (KEY ? '?key=' + encodeURIComponent(KEY) : ''); }
        else { showErr(d.error || 'Login failed.'); document.getElementById('password').value = ''; }
      } catch (e) { showErr('Cannot reach server.'); }
      finally { btn.disabled = false; }
    }
    function showErr(msg) { const el = document.getElementById('err'); el.textContent = msg; el.classList.add('show'); }
  </script>
</body>
</html>`;
}

function buildTicketErrorPage(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>Link expired</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#e8e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:440px;padding:40px;background:#111118;border:1px solid #1e1e2e;border-radius:12px;text-align:center}
h1{color:#ff6b6b;margin:0 0 12px;font-size:22px}p{color:#6b6b8a;line-height:1.6;margin:0}</style></head>
<body><div class="card"><h1>This login link has expired</h1>
<p>Return to Claude and run <code>auth_login</code> again to get a fresh URL.</p></div></body></html>`;
}

function buildSuccessPage(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"/><title>Signed in</title>
<style>body{font-family:system-ui,sans-serif;background:#0a0a0f;color:#e8e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:440px;padding:40px;background:#111118;border:1px solid #1e1e2e;border-radius:12px;text-align:center}
h1{color:#63ffb4;margin:0 0 12px;font-size:22px}p{color:#6b6b8a;line-height:1.6;margin:0}</style></head>
<body><div class="card"><h1>You're signed in</h1>
<p>Close this tab and return to Claude. Run <code>auth_status</code> to confirm, then <code>network_list</code>.</p></div></body></html>`;
}
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: Exits 0. (Fixes the Task 7 + 8 tooling signature mismatch.)

- [ ] **Step 3: Commit (bundles Task 7 + Task 8 + Task 9 as one atomic refactor)**

```bash
git add src/tools/ src/index.ts
git commit -m "refactor: multi-tenant MCP sessions (transport-per-session, ticket-based login, per-request session resolution)"
```

- [ ] **Step 4: Local smoke test — build green, server boots**

```bash
PORT=3000 TRANSPORT=http npm start &
sleep 2
curl -sf http://localhost:3000/health
```

Expected: `{"status":"ok"}` and exit 0. Then:

```bash
# MCP init with no key (dev mode: MCP_ACCESS_KEY unset → gate disabled)
curl -sS -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  -i | head -50
```

Expected: 200 OK, response contains `mcp-session-id: <uuid>` header and a JSON-RPC `result` with server capabilities.

Kill the background server:

```bash
kill %1 2>/dev/null || true
```

---

## Task 10: Dockerfile

**Files:**
- Create: `Dockerfile`

- [ ] **Step 1: Create `Dockerfile` with this content:**

```dockerfile
# syntax=docker/dockerfile:1.7

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
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Commit**

```bash
git add Dockerfile
git commit -m "build: add multi-stage Dockerfile (Node 22 Alpine)"
```

---

## Task 11: `.dockerignore`

**Files:**
- Create: `.dockerignore`

- [ ] **Step 1: Create `.dockerignore` with this content:**

```
node_modules
dist
.sessions
.env
.env.*
.git
.gitignore
.github
docs
*.md
.DS_Store
coverage
```

- [ ] **Step 2: Commit**

```bash
git add .dockerignore
git commit -m "build: add .dockerignore"
```

---

## Task 12: `fly.toml`

**Files:**
- Create: `fly.toml`

- [ ] **Step 1: Create `fly.toml` with this content:**

Replace `WORK_API_BASE_URL` with the confirmed public Work API URL before first deploy. If `lincx-mcp` is taken on Fly, rename the app and update `PUBLIC_BASE_URL` accordingly.

```toml
app = "lincx-mcp"
primary_region = "cdg"

[build]

[env]
  PORT = "3000"
  TRANSPORT = "http"
  NODE_ENV = "production"
  WORK_API_BASE_URL = "https://work-api.lincx.la"
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

- [ ] **Step 2: Commit**

```bash
git add fly.toml
git commit -m "deploy: add fly.toml for Fly.io deployment"
```

---

## Task 13: Local Docker smoke test

**Files:** none (verification only)

- [ ] **Step 1: Build the image**

```bash
cd /Users/salaheddinezaka/Documents/work/mcp
docker build -t lincx-mcp:dev .
```

Expected: Build succeeds, final image `lincx-mcp:dev` is created.

- [ ] **Step 2: Run container (dev mode, no key)**

```bash
docker run --rm -d --name lincx-mcp-smoke -p 3000:3000 \
  -e NODE_ENV=development \
  -e WORK_API_BASE_URL=https://work-api.lincx.la \
  -e PUBLIC_BASE_URL=http://localhost:3000 \
  -e TRANSPORT=http \
  lincx-mcp:dev
sleep 3
```

- [ ] **Step 3: Hit /health**

```bash
curl -sf http://localhost:3000/health
```

Expected: `{"status":"ok"}`.

- [ ] **Step 4: Confirm MCP initialize works**

```bash
curl -sS -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  -i | grep -i 'mcp-session-id'
```

Expected: One `mcp-session-id: <uuid>` header line.

- [ ] **Step 5: Test access-key gate (prod mode)**

```bash
docker stop lincx-mcp-smoke 2>/dev/null || true
docker run --rm -d --name lincx-mcp-smoke -p 3000:3000 \
  -e NODE_ENV=production \
  -e MCP_ACCESS_KEY=testkey \
  -e WORK_API_BASE_URL=https://work-api.lincx.la \
  -e PUBLIC_BASE_URL=http://localhost:3000 \
  -e TRANSPORT=http \
  lincx-mcp:dev
sleep 3

# Without key → 401
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/mcp -H 'Content-Type: application/json' -d '{}'

# With key → 200 (or at least not 401)
curl -s -o /dev/null -w '%{http_code}\n' -X POST 'http://localhost:3000/mcp?key=testkey' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Expected: First call prints `401`. Second prints `200`.

- [ ] **Step 6: Stop container**

```bash
docker stop lincx-mcp-smoke
```

- [ ] **Step 7: No commit needed — verification only.**

---

## Task 14: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the "Environment variables" table**

Find the env var table and replace the matching block with:

```md
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
```

- [ ] **Step 2: Update the "Critical rules" section**

Find the "Claude never controls auth or network context" block and add one bullet:

```md
- In multi-tenant deploys, session identity comes from `extra.sessionId` (the MCP transport session id) — never from a module-global.
```

- [ ] **Step 3: Replace the "Session model" section's storage paragraph with:**

```md
Session store: Redis when `REDIS_URL` is set, in-memory Map otherwise.
In-memory sessions are lost on server restart — Redis is required in production.
TTL: 7 days for Lincx sessions, 7 days for MCP-to-Lincx bindings, 10 minutes for login tickets.
The previous `.sessions/session_id` on-disk persistence has been removed.
```

- [ ] **Step 4: Add a new "Deployment" section before "Known issues"**

```md
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
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(CLAUDE.md): multi-tenant env vars + deployment section"
```

---

## Task 15: Update `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read the current README**

```bash
cat /Users/salaheddinezaka/Documents/work/mcp/README.md
```

- [ ] **Step 2: Add a "Deployed usage" section near the top (after the intro, before local dev instructions).**

```md
## Deployed usage

The hosted server lives at:

```
https://lincx-mcp.fly.dev/mcp?key=<ACCESS_KEY>
```

Ask the admin for the access key, then add to your MCP client config:

```json
{
  "mcpServers": {
    "lincx": {
      "url": "https://lincx-mcp.fly.dev/mcp?key=<ACCESS_KEY>"
    }
  }
}
```

Then run `auth_login` from Claude — it returns a browser URL. Open it, sign in with your Lincx credentials, return to Claude, run `auth_status` → `network_list` → `network_switch` to pick a network.
```

- [ ] **Step 3: Add a "Deployment" section near the bottom**

```md
## Deployment

See the "Deployment" section in `CLAUDE.md` for the full Fly.io workflow. Short version:

```bash
fly deploy
```

The Dockerfile and `fly.toml` in this repo are the source of truth.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(README): document deployed URL + link to Fly workflow"
```

---

## Task 16: Fly.io deploy + live verification

**Files:** none (infrastructure)

**Preconditions:**
- `flyctl` installed locally (`brew install flyctl`).
- `fly auth login` done once.
- Confirmed `WORK_API_BASE_URL` value (edit `fly.toml` if not `https://work-api.lincx.la`).

- [ ] **Step 1: Launch the app (one-time)**

```bash
fly launch --no-deploy
```

When prompted:
- Use existing `fly.toml`: **yes**.
- Copy config: **yes**.
- Create app now: **yes**.
- Region: accept `cdg`.
- Postgres / Redis: **no** (we'll add Redis next).

- [ ] **Step 2: Provision Upstash Redis**

```bash
fly redis create
```

Accept defaults (region same as app, Pay-as-you-go / free tier). Verify:

```bash
fly secrets list
```

Expected: `REDIS_URL` appears in the list.

- [ ] **Step 3: Set the access key**

```bash
KEY=$(openssl rand -hex 32)
fly secrets set MCP_ACCESS_KEY="$KEY"
echo "Access key: $KEY"   # save this for later
```

- [ ] **Step 4: Deploy**

```bash
fly deploy
```

Expected: Build runs, image pushed, at least one machine becomes healthy (`fly status`).

- [ ] **Step 5: Live health check**

```bash
curl -sf https://lincx-mcp.fly.dev/health
```

Expected: `{"status":"ok"}`.

- [ ] **Step 6: Live MCP initialize**

```bash
curl -sS -X POST "https://lincx-mcp.fly.dev/mcp?key=$KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  -i | grep -i 'mcp-session-id'
```

Expected: One `mcp-session-id` header.

- [ ] **Step 7: Hand the URL to a test user and walk them through login**

Give them: `https://lincx-mcp.fly.dev/mcp?key=<KEY>`.

Ask them to:
1. Add it to Claude's MCP config.
2. Run `auth_login` — copy the returned URL.
3. Open the URL, log in with their Lincx credentials.
4. Run `auth_status` — expect `authenticated: true` and their networks listed.
5. Run `network_switch` then `list_templates` — expect data from the Work API.

- [ ] **Step 8: Two-user isolation check**

Have two users do steps 1–4 concurrently (or one person + yourself in two different Claude profiles). Each should see only their own email/networks in `auth_status`. If they see each other's data, the multi-tenant refactor has a bug — investigate `resolveLincxSession` and `extra.sessionId` plumbing.

- [ ] **Step 9: No commit — deploy verification only.**

---

## Self-review checklist (already run)

- [x] **Spec coverage:** All spec sections (1–9) covered — multi-tenancy refactor (Tasks 7–9), auth flow (Tasks 3, 8, 9), access-key gate (Tasks 4, 5, 9), Dockerfile (Task 10), fly.toml (Task 12), docs (Tasks 14, 15), smoke tests (Tasks 13, 16). Open-questions from spec §9 flagged as preconditions on Task 16.
- [x] **No placeholders:** All steps contain exact code/commands. No TBD/TODO.
- [x] **Type consistency:** `resolveLincxSession(mcpSessionId?: string): Promise<string | null>`, `bindMcpToLincxSession(mcpSessionId, lincxSessionId)`, `mintTicket(mcpSessionId)`, `consumeTicket(ticket)`, `peekTicket(ticket)`, `unbindMcpSession(mcpSessionId)` — names stable across Tasks 3, 8, 9.
- [x] **Atomic-refactor ordering:** Tasks 7 + 8 + 9 form one atomic commit (build is red between them; don't commit mid-way).
