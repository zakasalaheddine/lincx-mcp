# OAuth 2.1 Authorization Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an OAuth 2.1 + PKCE authorization server to the MCP server so that MCP clients (Claude desktop, claude.ai, Claude Code) authenticate once via a browser flow, store the access/refresh tokens themselves, and survive reconnects without re-prompting the user.

**Architecture:** Two unrelated tokens identify a user: the OAuth access token (issued by this server, sent by the MCP client as `Authorization: Bearer …` on every `/mcp` request) and the Lincx JWT (`auth_token`, unchanged, lives in `Session`, used by `workApiRequest`). They meet in Redis: `oauth:token:<accessToken>` → `lincx_session_id`. The existing `/login` UI is reused as the OAuth consent screen. Implements RFC 6749 (OAuth 2.0), RFC 7636 (PKCE), RFC 7591 (Dynamic Client Registration), RFC 8414 (Authorization Server Metadata), and RFC 9728 (Protected Resource Metadata) per the MCP authorization spec.

**Tech Stack:** TypeScript / Node 22, Express 4, ioredis (existing `KvStore` abstraction), MCP SDK Streamable HTTP transport, Vitest + Supertest for tests, hand-rolled OAuth (no library — opaque random tokens, no JWT). PKCE via `node:crypto`.

---

## Critical security rules

- **Tokens are opaque.** Random 32-byte hex strings. No JWT. Easy to revoke (delete from Redis).
- **Auth codes are single-use.** Delete on first redeem. Re-use must fail with `invalid_grant`.
- **PKCE is mandatory.** S256 only. No `plain` method. Reject any `/oauth/authorize` call without `code_challenge`.
- **Refresh tokens rotate.** Each refresh issues a new refresh token and invalidates the old one.
- **Constant-time comparisons** for any user-supplied secret comparison (`timingSafeEqual`).
- **Redirect URIs are exact-match.** No prefix matching, no wildcards, including the path.
- **Never log tokens.** Log token hashes or first 8 chars at most.
- **`/oauth/*` and `/.well-known/*` are public.** `MCP_ACCESS_KEY` does not gate them — it would make discovery impossible.

## File structure

```
src/
├── index.ts                       # MODIFIED — wire up new routes, update /mcp handler
├── constants.ts                   # MODIFIED — add OAuth TTLs and config
├── types.ts                       # MODIFIED — add OauthClient, AuthCode, AccessToken, RefreshToken
│
├── services/
│   ├── oauth/
│   │   ├── pkce.ts                # NEW — verifyPkce(verifier, challenge, method)
│   │   ├── clients.ts             # NEW — registerClient, getClient (DCR storage)
│   │   ├── codes.ts               # NEW — issueAuthCode, consumeAuthCode
│   │   ├── tokens.ts              # NEW — issueTokens, refreshTokens, lookupAccessToken, revokeRefreshToken
│   │   └── metadata.ts            # NEW — buildAuthServerMetadata, buildResourceMetadata
│   └── sessionManager.ts          # MODIFIED — add resolveLincxSessionFromBearer; keep transport-id fallback
│
├── routes/                        # NEW DIRECTORY — split routes off index.ts for clarity
│   ├── wellKnown.ts               # NEW — GET /.well-known/oauth-authorization-server, oauth-protected-resource
│   ├── oauthRegister.ts           # NEW — POST /oauth/register
│   ├── oauthAuthorize.ts          # NEW — GET /oauth/authorize (renders existing login UI w/ OAuth context)
│   ├── oauthToken.ts              # NEW — POST /oauth/token (auth_code + refresh_token grants)
│   └── login.ts                   # NEW — GET /login + POST /api/login moved here (now OAuth-aware)
│
└── tests/                         # NEW DIRECTORY
    ├── oauth/
    │   ├── pkce.test.ts
    │   ├── codes.test.ts
    │   ├── tokens.test.ts
    │   └── flow.test.ts           # End-to-end OAuth flow via supertest
    └── helpers/
        └── testApp.ts             # Builds an Express app with in-memory KV for tests
```

**Why split routes off `index.ts`:** the file is already 330 lines with HTML templates inline. Adding 6 OAuth routes inline would make it unmaintainable. Each new route file is < 80 lines.

## Redis keys (additive — does not touch existing)

| Key | Value | TTL |
|-----|-------|-----|
| `oauth:client:<id>` | JSON `OauthClient` | 90d |
| `oauth:code:<code>` | JSON `AuthCode` (incl. PKCE challenge, redirect_uri, lincx_session_id) | 60s |
| `oauth:access:<token>` | JSON `AccessToken` (incl. lincx_session_id, client_id) | 1h |
| `oauth:refresh:<token>` | JSON `RefreshToken` (incl. lincx_session_id, client_id) | 30d |
| `lincx:session:*` | unchanged | unchanged |
| `mcp:session:*` | unchanged for legacy stdio tickets | unchanged |
| `ticket:*` | DELETED — replaced by OAuth state/code | — |

## End-to-end flow (sanity check)

```
1. MCP client calls POST /mcp with no Authorization
   → 401, WWW-Authenticate: Bearer resource_metadata="https://app/.well-known/oauth-protected-resource"

2. Client fetches /.well-known/oauth-protected-resource
   → { authorization_servers: ["https://app"] }

3. Client fetches /.well-known/oauth-authorization-server
   → { issuer, authorization_endpoint, token_endpoint, registration_endpoint, ... }

4. Client POSTs /oauth/register { redirect_uris: [...] }
   → { client_id }

5. Client opens browser to /oauth/authorize?response_type=code&client_id=...&redirect_uri=...
   &state=...&code_challenge=...&code_challenge_method=S256

6. Server stores pending auth-request, renders login UI carrying auth-request context
7. User submits email+password → POST /api/login (with auth-request context)
8. Server calls loginWithCredentials → createSession → issueAuthCode
   → 302 redirect_uri?code=...&state=...

9. Client POSTs /oauth/token { grant_type: "authorization_code", code, code_verifier, redirect_uri, client_id }
   → { access_token, refresh_token, token_type: "Bearer", expires_in: 3600 }

10. Client calls POST /mcp with Authorization: Bearer <access_token>
    → resolveLincxSessionFromBearer → workApiRequest works

11. After 1h, access expires → POST /oauth/token { grant_type: "refresh_token", refresh_token, client_id }
    → new access + rotated refresh
```

---

## Task 1: Add Vitest + Supertest test harness

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`
- Create: `src/tests/helpers/testApp.ts`
- Create: `src/tests/smoke.test.ts`

- [ ] **Step 1: Install dev deps**

```bash
npm install --save-dev vitest @vitest/coverage-v8 supertest @types/supertest
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/tests/**/*.test.ts"],
    environment: "node",
    pool: "forks",  // each test file in its own process — keeps Redis singletons isolated
  },
});
```

- [ ] **Step 3: Add scripts to `package.json`**

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Create `src/tests/helpers/testApp.ts`** — a stub for now, will grow per task

```ts
import express from "express";

export function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  return app;
}
```

- [ ] **Step 5: Create `src/tests/smoke.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildTestApp } from "./helpers/testApp.js";

describe("smoke", () => {
  it("test harness boots", async () => {
    const app = buildTestApp();
    app.get("/ok", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/ok");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
```

- [ ] **Step 6: Run test, verify pass**

```bash
npm test
```
Expected: `1 passed`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json vitest.config.ts src/tests/
git commit -m "test: add vitest + supertest harness"
```

---

## Task 2: Add OAuth types

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Append OAuth types to `src/types.ts`**

```ts
// ── OAuth ────────────────────────────────────────────────────────────────────

export interface OauthClient {
  client_id: string;
  client_name?: string;
  redirect_uris: string[];          // exact-match; at least one required
  created_at: number;               // epoch ms
}

export interface AuthCode {
  code: string;                     // the code itself, used as the key
  client_id: string;
  redirect_uri: string;             // must match on token exchange
  code_challenge: string;           // PKCE S256 challenge
  lincx_session_id: string;         // already-created Lincx session
  expires_at: number;               // epoch ms
}

export interface AccessToken {
  token: string;
  client_id: string;
  lincx_session_id: string;
  expires_at: number;
}

export interface RefreshToken {
  token: string;
  client_id: string;
  lincx_session_id: string;
  expires_at: number;
}
```

- [ ] **Step 2: Verify build still passes**

```bash
npm run build
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "feat(oauth): add OAuth domain types"
```

---

## Task 3: Add OAuth constants

**Files:**
- Modify: `src/constants.ts`

- [ ] **Step 1: Append to `src/constants.ts`**

```ts
// ── OAuth TTLs ───────────────────────────────────────────────────────────────
export const OAUTH_AUTH_CODE_TTL_SECONDS = 60;          // 1 min
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;  // 1 hour
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;  // 30 days
export const OAUTH_CLIENT_TTL_SECONDS = 60 * 60 * 24 * 90;         // 90 days
```

- [ ] **Step 2: Build**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/constants.ts
git commit -m "feat(oauth): add OAuth TTL constants"
```

---

## Task 4: PKCE verification

**Files:**
- Create: `src/services/oauth/pkce.ts`
- Create: `src/tests/oauth/pkce.test.ts`

- [ ] **Step 1: Write the failing test** — `src/tests/oauth/pkce.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { verifyPkce } from "../../services/oauth/pkce.js";

function challengeFromVerifier(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("verifyPkce", () => {
  it("accepts a correct S256 verifier", () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = challengeFromVerifier(verifier);
    expect(verifyPkce(verifier, challenge, "S256")).toBe(true);
  });

  it("rejects a wrong verifier", () => {
    const verifier = "abc";
    const challenge = challengeFromVerifier("xyz");
    expect(verifyPkce(verifier, challenge, "S256")).toBe(false);
  });

  it("rejects an unsupported method (plain)", () => {
    expect(verifyPkce("abc", "abc", "plain" as "S256")).toBe(false);
  });

  it("rejects too-short verifier (< 43 chars per RFC)", () => {
    expect(verifyPkce("short", "anything", "S256")).toBe(false);
  });

  it("rejects too-long verifier (> 128 chars per RFC)", () => {
    expect(verifyPkce("a".repeat(129), "anything", "S256")).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- pkce
```
Expected: tests fail because module does not exist.

- [ ] **Step 3: Implement** — `src/services/oauth/pkce.ts`

```ts
import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Verify a PKCE code_verifier against a stored S256 code_challenge.
 * Per RFC 7636: verifier is 43–128 chars, base64url-safe; method must be S256.
 */
export function verifyPkce(
  verifier: string,
  challenge: string,
  method: "S256"
): boolean {
  if (method !== "S256") return false;
  if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128) return false;
  if (!/^[A-Za-z0-9\-._~]+$/.test(verifier)) return false;

  const computed = createHash("sha256").update(verifier).digest("base64url");
  if (computed.length !== challenge.length) return false;
  return timingSafeEqual(Buffer.from(computed), Buffer.from(challenge));
}
```

- [ ] **Step 4: Run, verify PASS**

```bash
npm test -- pkce
```
Expected: all 5 pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/oauth/pkce.ts src/tests/oauth/pkce.test.ts
git commit -m "feat(oauth): PKCE S256 verification with RFC 7636 length/charset checks"
```

---

## Task 5: OAuth client registration store

**Files:**
- Create: `src/services/oauth/clients.ts`
- Create: `src/tests/oauth/clients.test.ts`

- [ ] **Step 1: Test** — `src/tests/oauth/clients.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { registerClient, getClient } from "../../services/oauth/clients.js";

describe("OAuth clients", () => {
  it("registers and retrieves a client", async () => {
    const c = await registerClient({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      client_name: "Claude",
    });
    expect(c.client_id).toMatch(/^[a-f0-9]{32}$/);
    const fetched = await getClient(c.client_id);
    expect(fetched?.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
  });

  it("requires at least one redirect_uri", async () => {
    await expect(registerClient({ redirect_uris: [] })).rejects.toThrow(/redirect_uris/);
  });

  it("rejects non-https redirect_uris (except localhost)", async () => {
    await expect(
      registerClient({ redirect_uris: ["http://example.com/cb"] })
    ).rejects.toThrow(/https/);
    // localhost is OK for local dev clients
    await expect(
      registerClient({ redirect_uris: ["http://localhost:6274/cb"] })
    ).resolves.toBeTruthy();
  });

  it("returns null for unknown client_id", async () => {
    expect(await getClient("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- clients
```

- [ ] **Step 3: Implement** — `src/services/oauth/clients.ts`

```ts
import { randomBytes } from "node:crypto";
import { getKvStore } from "../sessionStore.js";
import { OAUTH_CLIENT_TTL_SECONDS } from "../../constants.js";
import type { OauthClient } from "../../types.js";

const PREFIX = "oauth:client:";

function isValidRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1")) return true;
    return false;
  } catch {
    return false;
  }
}

export async function registerClient(input: {
  redirect_uris: string[];
  client_name?: string;
}): Promise<OauthClient> {
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
    throw new Error("redirect_uris must be a non-empty array");
  }
  for (const uri of input.redirect_uris) {
    if (!isValidRedirectUri(uri)) {
      throw new Error(`redirect_uri must be https (or http://localhost): ${uri}`);
    }
  }

  const client: OauthClient = {
    client_id: randomBytes(16).toString("hex"),
    client_name: input.client_name,
    redirect_uris: input.redirect_uris,
    created_at: Date.now(),
  };

  const kv = await getKvStore();
  await kv.set(PREFIX + client.client_id, JSON.stringify(client), OAUTH_CLIENT_TTL_SECONDS);
  return client;
}

export async function getClient(clientId: string): Promise<OauthClient | null> {
  const kv = await getKvStore();
  const raw = await kv.get(PREFIX + clientId);
  if (!raw) return null;
  try { return JSON.parse(raw) as OauthClient; } catch { return null; }
}
```

- [ ] **Step 4: Verify PASS**

```bash
npm test -- clients
```

- [ ] **Step 5: Commit**

```bash
git add src/services/oauth/clients.ts src/tests/oauth/clients.test.ts
git commit -m "feat(oauth): client registration store with redirect_uri validation"
```

---

## Task 6: Auth code issuance and consumption

**Files:**
- Create: `src/services/oauth/codes.ts`
- Create: `src/tests/oauth/codes.test.ts`

- [ ] **Step 1: Test** — `src/tests/oauth/codes.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { issueAuthCode, consumeAuthCode } from "../../services/oauth/codes.js";

describe("OAuth auth codes", () => {
  it("issues, consumes once, then fails on reuse", async () => {
    const code = await issueAuthCode({
      client_id: "c1",
      redirect_uri: "https://x/cb",
      code_challenge: "ch",
      lincx_session_id: "lsid",
    });
    expect(code).toMatch(/^[a-f0-9]{64}$/);

    const first = await consumeAuthCode(code);
    expect(first?.lincx_session_id).toBe("lsid");

    const second = await consumeAuthCode(code);
    expect(second).toBeNull();  // single-use
  });

  it("returns null for unknown code", async () => {
    expect(await consumeAuthCode("nope")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement** — `src/services/oauth/codes.ts`

```ts
import { randomBytes } from "node:crypto";
import { getKvStore } from "../sessionStore.js";
import { OAUTH_AUTH_CODE_TTL_SECONDS } from "../../constants.js";
import type { AuthCode } from "../../types.js";

const PREFIX = "oauth:code:";

export async function issueAuthCode(input: {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  lincx_session_id: string;
}): Promise<string> {
  const code = randomBytes(32).toString("hex");
  const record: AuthCode = {
    code,
    ...input,
    expires_at: Date.now() + OAUTH_AUTH_CODE_TTL_SECONDS * 1000,
  };
  const kv = await getKvStore();
  await kv.set(PREFIX + code, JSON.stringify(record), OAUTH_AUTH_CODE_TTL_SECONDS);
  return code;
}

/** Single-use: deletes the code on retrieval. Returns null if missing/expired. */
export async function consumeAuthCode(code: string): Promise<AuthCode | null> {
  const kv = await getKvStore();
  const raw = await kv.get(PREFIX + code);
  if (!raw) return null;
  await kv.delete(PREFIX + code);
  try { return JSON.parse(raw) as AuthCode; } catch { return null; }
}
```

- [ ] **Step 4: Verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/services/oauth/codes.ts src/tests/oauth/codes.test.ts
git commit -m "feat(oauth): single-use auth code issuance"
```

---

## Task 7: Access + refresh token issuance and rotation

**Files:**
- Create: `src/services/oauth/tokens.ts`
- Create: `src/tests/oauth/tokens.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from "vitest";
import {
  issueTokens,
  refreshTokens,
  lookupAccessToken,
  revokeRefreshToken,
} from "../../services/oauth/tokens.js";

describe("OAuth tokens", () => {
  it("issues access + refresh, then refreshes (rotating refresh)", async () => {
    const a = await issueTokens({ client_id: "c", lincx_session_id: "s" });
    expect(a.access_token).toMatch(/^[a-f0-9]{64}$/);
    expect(a.refresh_token).toMatch(/^[a-f0-9]{64}$/);
    expect(a.expires_in).toBe(3600);

    const lookup = await lookupAccessToken(a.access_token);
    expect(lookup?.lincx_session_id).toBe("s");

    const b = await refreshTokens(a.refresh_token, "c");
    expect(b).not.toBeNull();
    expect(b!.access_token).not.toBe(a.access_token);
    expect(b!.refresh_token).not.toBe(a.refresh_token);

    // Old refresh is dead
    expect(await refreshTokens(a.refresh_token, "c")).toBeNull();
  });

  it("rejects refresh from wrong client", async () => {
    const a = await issueTokens({ client_id: "c1", lincx_session_id: "s" });
    expect(await refreshTokens(a.refresh_token, "c2")).toBeNull();
  });

  it("revokes a refresh token", async () => {
    const a = await issueTokens({ client_id: "c", lincx_session_id: "s" });
    await revokeRefreshToken(a.refresh_token);
    expect(await refreshTokens(a.refresh_token, "c")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement** — `src/services/oauth/tokens.ts`

```ts
import { randomBytes } from "node:crypto";
import { getKvStore } from "../sessionStore.js";
import {
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS,
} from "../../constants.js";
import type { AccessToken, RefreshToken } from "../../types.js";

const ACCESS_PREFIX = "oauth:access:";
const REFRESH_PREFIX = "oauth:refresh:";

export interface TokenBundle {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
}

export async function issueTokens(input: {
  client_id: string;
  lincx_session_id: string;
}): Promise<TokenBundle> {
  const access_token = randomBytes(32).toString("hex");
  const refresh_token = randomBytes(32).toString("hex");

  const accessRecord: AccessToken = {
    token: access_token,
    client_id: input.client_id,
    lincx_session_id: input.lincx_session_id,
    expires_at: Date.now() + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000,
  };
  const refreshRecord: RefreshToken = {
    token: refresh_token,
    client_id: input.client_id,
    lincx_session_id: input.lincx_session_id,
    expires_at: Date.now() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000,
  };

  const kv = await getKvStore();
  await kv.set(ACCESS_PREFIX + access_token, JSON.stringify(accessRecord), OAUTH_ACCESS_TOKEN_TTL_SECONDS);
  await kv.set(REFRESH_PREFIX + refresh_token, JSON.stringify(refreshRecord), OAUTH_REFRESH_TOKEN_TTL_SECONDS);

  return { access_token, refresh_token, token_type: "Bearer", expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS };
}

export async function lookupAccessToken(token: string): Promise<AccessToken | null> {
  const kv = await getKvStore();
  const raw = await kv.get(ACCESS_PREFIX + token);
  if (!raw) return null;
  try { return JSON.parse(raw) as AccessToken; } catch { return null; }
}

export async function refreshTokens(
  refreshTokenValue: string,
  clientId: string
): Promise<TokenBundle | null> {
  const kv = await getKvStore();
  const raw = await kv.get(REFRESH_PREFIX + refreshTokenValue);
  if (!raw) return null;

  let record: RefreshToken;
  try { record = JSON.parse(raw) as RefreshToken; } catch { return null; }

  if (record.client_id !== clientId) return null;

  // Rotate: invalidate old refresh, issue new pair tied to same Lincx session
  await kv.delete(REFRESH_PREFIX + refreshTokenValue);
  return issueTokens({ client_id: record.client_id, lincx_session_id: record.lincx_session_id });
}

export async function revokeRefreshToken(refreshTokenValue: string): Promise<void> {
  const kv = await getKvStore();
  await kv.delete(REFRESH_PREFIX + refreshTokenValue);
}
```

- [ ] **Step 4: Verify PASS**

- [ ] **Step 5: Commit**

```bash
git add src/services/oauth/tokens.ts src/tests/oauth/tokens.test.ts
git commit -m "feat(oauth): access/refresh token issuance with rotation"
```

---

## Task 8: Bearer-token → Lincx session resolution helper

**Files:**
- Modify: `src/services/sessionManager.ts`

- [ ] **Step 1: Append to `src/services/sessionManager.ts`** (after `unbindMcpSession`)

```ts
// ── OAuth bearer → Lincx session ─────────────────────────────────────────────

import { lookupAccessToken } from "./oauth/tokens.js";

/**
 * Resolve a bearer token from `Authorization: Bearer <token>` to a Lincx session id.
 * Returns null if the token is missing, expired, or the underlying Lincx session is gone.
 */
export async function resolveLincxSessionFromBearer(
  authorizationHeader: string | undefined
): Promise<string | null> {
  if (!authorizationHeader) return null;
  const m = authorizationHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) return null;
  const access = await lookupAccessToken(m[1]);
  if (!access) return null;
  return access.lincx_session_id;
}
```

Note: `lookupAccessToken` is imported at the top — move the existing imports up rather than mid-file. The shown placement is for readability of the diff.

- [ ] **Step 2: Move the import to the top of the file** alongside other imports.

- [ ] **Step 3: Build**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/services/sessionManager.ts
git commit -m "feat(oauth): resolveLincxSessionFromBearer helper"
```

---

## Task 9: Authorization Server + Protected Resource metadata

**Files:**
- Create: `src/services/oauth/metadata.ts`
- Create: `src/routes/wellKnown.ts`

- [ ] **Step 1: Create `src/services/oauth/metadata.ts`**

```ts
export function buildAuthServerMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],   // public clients, PKCE-only
    scopes_supported: ["mcp"],
  };
}

export function buildResourceMetadata(baseUrl: string) {
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
  };
}
```

- [ ] **Step 2: Create `src/routes/wellKnown.ts`**

```ts
import { Router } from "express";
import { buildAuthServerMetadata, buildResourceMetadata } from "../services/oauth/metadata.js";
import { PUBLIC_BASE_URL } from "../constants.js";

export const wellKnownRouter: Router = Router();

wellKnownRouter.get("/oauth-authorization-server", (_req, res) => {
  res.json(buildAuthServerMetadata(PUBLIC_BASE_URL));
});

wellKnownRouter.get("/oauth-protected-resource", (_req, res) => {
  res.json(buildResourceMetadata(PUBLIC_BASE_URL));
});
```

- [ ] **Step 3: Wire it in `src/index.ts`** — add **before** the `/mcp` routes, **without `requireAccessKey`**:

```ts
import { wellKnownRouter } from "./routes/wellKnown.js";
// ...
app.use("/.well-known", wellKnownRouter);
```

- [ ] **Step 4: Smoke test** — add to `src/tests/smoke.test.ts`

```ts
import { wellKnownRouter } from "../routes/wellKnown.js";

it("serves authorization-server metadata", async () => {
  const app = buildTestApp();
  app.use("/.well-known", wellKnownRouter);
  const res = await request(app).get("/.well-known/oauth-authorization-server");
  expect(res.status).toBe(200);
  expect(res.body.token_endpoint).toMatch(/\/oauth\/token$/);
  expect(res.body.code_challenge_methods_supported).toContain("S256");
});
```

- [ ] **Step 5: Run tests**

```bash
npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/services/oauth/metadata.ts src/routes/wellKnown.ts src/index.ts src/tests/smoke.test.ts
git commit -m "feat(oauth): authorization-server + protected-resource metadata"
```

---

## Task 10: Dynamic Client Registration endpoint

**Files:**
- Create: `src/routes/oauthRegister.ts`
- Create: `src/tests/oauth/register.test.ts`

- [ ] **Step 1: Test**

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { oauthRegisterRouter } from "../../routes/oauthRegister.js";

describe("POST /oauth/register", () => {
  const app = express();
  app.use(express.json());
  app.use("/oauth", oauthRegisterRouter);

  it("registers a client", async () => {
    const res = await request(app).post("/oauth/register").send({
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      client_name: "Claude",
    });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toMatch(/^[a-f0-9]{32}$/);
    expect(res.body.redirect_uris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
  });

  it("rejects missing redirect_uris", async () => {
    const res = await request(app).post("/oauth/register").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_redirect_uri");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Create `src/routes/oauthRegister.ts`**

```ts
import { Router } from "express";
import { registerClient } from "../services/oauth/clients.js";

export const oauthRegisterRouter: Router = Router();

oauthRegisterRouter.post("/register", async (req, res) => {
  const { redirect_uris, client_name } = req.body ?? {};
  try {
    const client = await registerClient({ redirect_uris, client_name });
    res.status(201).json({
      client_id: client.client_id,
      client_id_issued_at: Math.floor(client.created_at / 1000),
      redirect_uris: client.redirect_uris,
      client_name: client.client_name,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "registration_failed";
    console.error(`[OAuth] register failed: ${msg}`);
    res.status(400).json({ error: "invalid_redirect_uri", error_description: msg });
  }
});
```

- [ ] **Step 4: Wire in `src/index.ts`** — also without `requireAccessKey`:

```ts
import { oauthRegisterRouter } from "./routes/oauthRegister.js";
// ...
app.use("/oauth", oauthRegisterRouter);
```

- [ ] **Step 5: Run tests, verify PASS**

- [ ] **Step 6: Commit**

```bash
git add src/routes/oauthRegister.ts src/tests/oauth/register.test.ts src/index.ts
git commit -m "feat(oauth): dynamic client registration endpoint"
```

---

## Task 11: Authorize endpoint + login UI integration

This is the largest task. The `/oauth/authorize` endpoint stores the auth-request context in Redis (keyed by a freshly-generated `request_id`), then redirects the browser to `/login?req=<request_id>`. The login page submits to `/api/login?req=<request_id>`. On successful Lincx login, the handler issues an auth code and 302s to the redirect_uri.

**Files:**
- Create: `src/routes/login.ts` (replaces inline routes in index.ts)
- Modify: `src/index.ts` (delete old `/login` and `/api/login`, mount new router)
- Add to: `src/services/oauth/codes.ts` — a "pending auth request" store

- [ ] **Step 1: Add a pending-request store to `src/services/oauth/codes.ts`**

```ts
import type { AuthCode } from "../../types.js";  // existing import
// ... keep existing code ...

export interface PendingAuthRequest {
  request_id: string;
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  scope: string;
  expires_at: number;
}

const PENDING_PREFIX = "oauth:pending:";
const PENDING_TTL_SECONDS = 600;  // 10 minutes for the user to log in

export async function storePendingAuthRequest(req: Omit<PendingAuthRequest, "expires_at">): Promise<void> {
  const kv = await getKvStore();
  const record: PendingAuthRequest = { ...req, expires_at: Date.now() + PENDING_TTL_SECONDS * 1000 };
  await kv.set(PENDING_PREFIX + req.request_id, JSON.stringify(record), PENDING_TTL_SECONDS);
}

export async function consumePendingAuthRequest(requestId: string): Promise<PendingAuthRequest | null> {
  const kv = await getKvStore();
  const raw = await kv.get(PENDING_PREFIX + requestId);
  if (!raw) return null;
  await kv.delete(PENDING_PREFIX + requestId);
  try { return JSON.parse(raw) as PendingAuthRequest; } catch { return null; }
}

export async function peekPendingAuthRequest(requestId: string): Promise<PendingAuthRequest | null> {
  const kv = await getKvStore();
  const raw = await kv.get(PENDING_PREFIX + requestId);
  if (!raw) return null;
  try { return JSON.parse(raw) as PendingAuthRequest; } catch { return null; }
}
```

- [ ] **Step 2: Create `src/routes/login.ts`** — moves the existing HTML+POST logic and adapts it for OAuth

```ts
import { Router } from "express";
import { randomBytes } from "node:crypto";
import { loginWithCredentials } from "../services/auth.js";
import { createSession } from "../services/sessionManager.js";
import {
  storePendingAuthRequest,
  consumePendingAuthRequest,
  peekPendingAuthRequest,
  issueAuthCode,
} from "../services/oauth/codes.js";
import { getClient } from "../services/oauth/clients.js";
import { loginLimiter } from "../middleware/rateLimit.js";
import { buildLoginPage, buildSuccessPage, buildErrorPage } from "../views/login.js";

export const loginRouter: Router = Router();

// ── GET /oauth/authorize ─────────────────────────────────────────────────────
loginRouter.get("/oauth/authorize", async (req, res) => {
  const {
    response_type, client_id, redirect_uri, state,
    code_challenge, code_challenge_method, scope,
  } = req.query as Record<string, string | undefined>;

  if (response_type !== "code") return res.status(400).send(buildErrorPage("Unsupported response_type."));
  if (!client_id || !redirect_uri || !state || !code_challenge) {
    return res.status(400).send(buildErrorPage("Missing required OAuth parameters."));
  }
  if (code_challenge_method !== "S256") {
    return res.status(400).send(buildErrorPage("Only S256 code_challenge_method is supported."));
  }

  const client = await getClient(client_id);
  if (!client) return res.status(400).send(buildErrorPage("Unknown client_id."));
  if (!client.redirect_uris.includes(redirect_uri)) {
    return res.status(400).send(buildErrorPage("redirect_uri does not match registered URIs."));
  }

  const request_id = randomBytes(16).toString("hex");
  await storePendingAuthRequest({
    request_id, client_id, redirect_uri, state,
    code_challenge, scope: scope ?? "mcp",
  });

  res.redirect(`/login?req=${request_id}`);
});

// ── GET /login ───────────────────────────────────────────────────────────────
loginRouter.get("/login", async (req, res) => {
  const requestId = typeof req.query.req === "string" ? req.query.req : "";
  if (!requestId) return res.status(400).send(buildErrorPage("Missing auth request id."));
  const pending = await peekPendingAuthRequest(requestId);
  if (!pending) return res.status(400).send(buildErrorPage("This login link has expired."));
  res.setHeader("Content-Type", "text/html");
  res.send(buildLoginPage(requestId));
});

// ── POST /api/login ──────────────────────────────────────────────────────────
loginRouter.post("/api/login", loginLimiter, async (req, res) => {
  const requestId = typeof req.query.req === "string" ? req.query.req : "";
  const { email, password } = req.body as { email?: string; password?: string };

  if (!requestId) return res.status(400).json({ success: false, error: "Missing request id." });
  if (!email || !password) return res.status(400).json({ success: false, error: "Email and password required." });

  const pending = await consumePendingAuthRequest(requestId);
  if (!pending) return res.status(400).json({ success: false, error: "Login link expired. Restart from Claude." });

  try {
    const { authToken } = await loginWithCredentials(email, password);
    const session = await createSession({ user_id: email, email, auth_token: authToken });

    const code = await issueAuthCode({
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      lincx_session_id: session.session_id,
    });

    const url = new URL(pending.redirect_uri);
    url.searchParams.set("code", code);
    url.searchParams.set("state", pending.state);
    console.error(`[OAuth] auth_code issued for ${email} → client=${pending.client_id}`);
    res.json({ success: true, redirect: url.toString() });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Login failed";
    console.error(`[OAuth] login failed for ${email}: ${msg}`);
    res.status(401).json({ success: false, error: msg });
  }
});

loginRouter.get("/login/success", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(buildSuccessPage());
});
```

- [ ] **Step 3: Move HTML templates out of `index.ts`** into `src/views/login.ts`. Copy `buildLoginPage`, `buildSuccessPage`, and rename `buildTicketErrorPage` to `buildErrorPage` accepting a message argument:

```ts
// src/views/login.ts
import { IDENTITY_SERVER } from "../constants.js";

export function buildLoginPage(requestId: string): string {
  // Same HTML as before, but the JS posts to /api/login?req=<id>, and on success
  // navigates to data.redirect (which is the OAuth redirect_uri).
  // Replace the body of the existing buildLoginPage but change:
  //   const TICKET = "${safeTicket}";  →  const REQ = "${encodeURIComponent(requestId)}";
  //   POST_URL = '/api/login?t=...'    →  '/api/login?req=' + encodeURIComponent(REQ)
  //   on success                       →  window.location.href = d.redirect
  // Keep all styling identical.
  // (Full body copied verbatim from index.ts:238-311 with those substitutions.)
  return /* … */ "";
}

export function buildSuccessPage(): string {
  // Copy from index.ts:323-331 verbatim; "Run auth_status" wording stays — still applicable.
  return /* … */ "";
}

export function buildErrorPage(message: string): string {
  // Copy from index.ts:313-321; replace the static "This login link has expired"
  // body with the passed-in `message`.
  return /* … */ "";
}
```

(Implementer: copy the existing HTML strings byte-for-byte from `src/index.ts` lines 238–331 and apply the noted substitutions. They are styled CSS-in-HTML — do not regenerate from scratch.)

- [ ] **Step 4: Modify `src/index.ts`** — delete the inline `/login`, `/api/login`, `/login/success` routes, the `buildLoginPage`/`buildSuccessPage`/`buildTicketErrorPage` functions, and the imports `consumeTicket`, `peekTicket`, `bindMcpToLincxSession`. Replace with:

```ts
import { loginRouter } from "./routes/login.js";
// ...
app.use(loginRouter);
```

- [ ] **Step 5: Build**

```bash
npm run build
```

- [ ] **Step 6: Manual smoke (local)**

```bash
PORT=5001 npm run dev
# In another shell:
curl -i "http://localhost:5001/oauth/authorize?response_type=code&client_id=fake&redirect_uri=https://x&state=s&code_challenge=c&code_challenge_method=S256"
# Expected: 400 with "Unknown client_id."
```

- [ ] **Step 7: Commit**

```bash
git add src/routes/login.ts src/views/login.ts src/services/oauth/codes.ts src/index.ts
git commit -m "feat(oauth): /oauth/authorize + login UI redirect with auth_code issuance"
```

---

## Task 12: Token endpoint (authorization_code + refresh_token grants)

**Files:**
- Create: `src/routes/oauthToken.ts`
- Create: `src/tests/oauth/token.test.ts`

- [ ] **Step 1: Test** — `src/tests/oauth/token.test.ts`

```ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import express from "express";
import { createHash } from "node:crypto";
import { oauthTokenRouter } from "../../routes/oauthToken.js";
import { registerClient } from "../../services/oauth/clients.js";
import { issueAuthCode } from "../../services/oauth/codes.js";

function challenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("POST /oauth/token", () => {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use("/oauth", oauthTokenRouter);

  it("exchanges auth_code (with PKCE) for tokens", async () => {
    const client = await registerClient({ redirect_uris: ["https://x/cb"] });
    const verifier = "a".repeat(64);
    const code = await issueAuthCode({
      client_id: client.client_id,
      redirect_uri: "https://x/cb",
      code_challenge: challenge(verifier),
      lincx_session_id: "lsid",
    });

    const res = await request(app).post("/oauth/token").type("form").send({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://x/cb",
      client_id: client.client_id,
      code_verifier: verifier,
    });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.refresh_token).toMatch(/^[a-f0-9]{64}$/);
    expect(res.body.token_type).toBe("Bearer");
  });

  it("rejects wrong code_verifier", async () => {
    const client = await registerClient({ redirect_uris: ["https://x/cb"] });
    const code = await issueAuthCode({
      client_id: client.client_id,
      redirect_uri: "https://x/cb",
      code_challenge: challenge("a".repeat(64)),
      lincx_session_id: "lsid",
    });

    const res = await request(app).post("/oauth/token").type("form").send({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://x/cb",
      client_id: client.client_id,
      code_verifier: "b".repeat(64),
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("rejects code reuse", async () => {
    const client = await registerClient({ redirect_uris: ["https://x/cb"] });
    const verifier = "a".repeat(64);
    const code = await issueAuthCode({
      client_id: client.client_id,
      redirect_uri: "https://x/cb",
      code_challenge: challenge(verifier),
      lincx_session_id: "lsid",
    });

    const ok = await request(app).post("/oauth/token").type("form").send({
      grant_type: "authorization_code", code, redirect_uri: "https://x/cb",
      client_id: client.client_id, code_verifier: verifier,
    });
    expect(ok.status).toBe(200);

    const reused = await request(app).post("/oauth/token").type("form").send({
      grant_type: "authorization_code", code, redirect_uri: "https://x/cb",
      client_id: client.client_id, code_verifier: verifier,
    });
    expect(reused.status).toBe(400);
    expect(reused.body.error).toBe("invalid_grant");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement** — `src/routes/oauthToken.ts`

```ts
import { Router } from "express";
import { consumeAuthCode } from "../services/oauth/codes.js";
import { issueTokens, refreshTokens } from "../services/oauth/tokens.js";
import { verifyPkce } from "../services/oauth/pkce.js";
import { getClient } from "../services/oauth/clients.js";

export const oauthTokenRouter: Router = Router();

oauthTokenRouter.post("/token", async (req, res) => {
  // Per RFC 6749, the token endpoint accepts application/x-www-form-urlencoded
  const { grant_type } = req.body ?? {};

  if (grant_type === "authorization_code") {
    const { code, redirect_uri, client_id, code_verifier } = req.body;

    if (!code || !redirect_uri || !client_id || !code_verifier) {
      return res.status(400).json({ error: "invalid_request" });
    }

    const client = await getClient(client_id);
    if (!client) return res.status(400).json({ error: "invalid_client" });

    const authCode = await consumeAuthCode(code);
    if (!authCode) return res.status(400).json({ error: "invalid_grant" });

    if (authCode.client_id !== client_id) return res.status(400).json({ error: "invalid_grant" });
    if (authCode.redirect_uri !== redirect_uri) return res.status(400).json({ error: "invalid_grant" });
    if (!verifyPkce(code_verifier, authCode.code_challenge, "S256")) {
      return res.status(400).json({ error: "invalid_grant" });
    }

    const tokens = await issueTokens({
      client_id,
      lincx_session_id: authCode.lincx_session_id,
    });
    return res.json(tokens);
  }

  if (grant_type === "refresh_token") {
    const { refresh_token, client_id } = req.body;
    if (!refresh_token || !client_id) return res.status(400).json({ error: "invalid_request" });

    const tokens = await refreshTokens(refresh_token, client_id);
    if (!tokens) return res.status(400).json({ error: "invalid_grant" });
    return res.json(tokens);
  }

  return res.status(400).json({ error: "unsupported_grant_type" });
});
```

- [ ] **Step 4: Wire in `src/index.ts`** — without `requireAccessKey`:

```ts
import { oauthTokenRouter } from "./routes/oauthToken.js";
// ...
app.use("/oauth", oauthTokenRouter);
```

- [ ] **Step 5: Make sure `app.use(express.urlencoded({ extended: true }))` is already on the app** — it is (index.ts:67).

- [ ] **Step 6: Run tests, verify PASS**

- [ ] **Step 7: Commit**

```bash
git add src/routes/oauthToken.ts src/tests/oauth/token.test.ts src/index.ts
git commit -m "feat(oauth): /oauth/token endpoint with authorization_code + refresh_token grants"
```

---

## Task 13: Update `/mcp` to read Authorization, return 401 challenge, bind to transport

**Files:**
- Modify: `src/index.ts`
- Modify: `src/services/sessionManager.ts` (already updated in Task 8 — no changes here)

- [ ] **Step 1: Replace the existing `/mcp` POST handler in `src/index.ts:176-180`** with:

```ts
app.post("/mcp", requireAccessKey, mcpLimiter, async (req, res) => {
  const lincxSessionId = await resolveLincxSessionFromBearer(req.header("authorization"));
  if (!lincxSessionId) {
    res.setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`
    );
    res.status(401).json({ error: "unauthorized", error_description: "Bearer token required." });
    return;
  }

  const existingId = req.header("mcp-session-id");
  const transport = await getOrCreateTransport(existingId);

  // Refresh the transport→Lincx binding on every request so reconnects (new transport id)
  // inherit the OAuth-resolved Lincx session immediately.
  if (transport.sessionId) {
    await bindMcpToLincxSession(transport.sessionId, lincxSessionId);
  }

  await transport.handleRequest(req, res, req.body);
});
```

- [ ] **Step 2: Update GET and DELETE `/mcp` handlers** to also require Bearer:

```ts
app.get("/mcp", requireAccessKey, async (req, res) => {
  const lincxSessionId = await resolveLincxSessionFromBearer(req.header("authorization"));
  if (!lincxSessionId) {
    res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`);
    res.status(401).end();
    return;
  }
  const existingId = req.header("mcp-session-id");
  if (!existingId || !transports.has(existingId)) {
    res.status(404).json({ error: "Unknown MCP session." });
    return;
  }
  await transports.get(existingId)!.handleRequest(req, res);
});

app.delete("/mcp", requireAccessKey, async (req, res) => {
  const lincxSessionId = await resolveLincxSessionFromBearer(req.header("authorization"));
  if (!lincxSessionId) { res.status(401).end(); return; }
  const existingId = req.header("mcp-session-id");
  if (!existingId || !transports.has(existingId)) { res.status(404).end(); return; }
  await transports.get(existingId)!.handleRequest(req, res);
});
```

- [ ] **Step 3: Add the imports** at the top of `src/index.ts`:

```ts
import { resolveLincxSessionFromBearer, bindMcpToLincxSession } from "./services/sessionManager.js";
import { PUBLIC_BASE_URL } from "./constants.js";
```

- [ ] **Step 4: Build**

```bash
npm run build
```

- [ ] **Step 5: Manual smoke**

```bash
PORT=5001 npm run dev
# In another shell:
curl -i -X POST http://localhost:5001/mcp -H 'Content-Type: application/json' -d '{}'
# Expected: 401 with WWW-Authenticate: Bearer resource_metadata="..."
```

- [ ] **Step 6: Commit**

```bash
git add src/index.ts
git commit -m "feat(oauth): /mcp now requires Bearer; returns RFC 9728 challenge on 401"
```

---

## Task 14: Remove obsolete ticket-based auth_login flow

The legacy `auth_login` MCP tool (in `src/tools/authTools.ts`) returned a browser-login URL with a ticket. With OAuth, the MCP client triggers login itself via the 401 + WWW-Authenticate flow. The tool should now return an explanatory message rather than a URL.

**Files:**
- Modify: `src/tools/authTools.ts`
- Modify: `src/services/sessionManager.ts` (delete `mintTicket`, `consumeTicket`, `peekTicket`, `TICKET_PREFIX`)

- [ ] **Step 1: Read the current `authTools.ts`** to see its shape

```bash
cat src/tools/authTools.ts
```

- [ ] **Step 2: Update `auth_login` tool handler** to return:

```ts
{
  content: [{
    type: "text" as const,
    text: "Authentication is now handled by your MCP client via OAuth. " +
          "If you are not yet signed in, your client should open a browser " +
          "automatically. Use 'auth_status' to check the current session.",
  }],
}
```

(Implementer: keep the rest of the tool registration — title, description — but rewrite the handler. Also remove the `mintTicket` import.)

- [ ] **Step 3: Delete the ticket helpers from `sessionManager.ts`**:
  - Delete `TICKET_PREFIX`, `TICKET_TTL_SECONDS`
  - Delete `mintTicket`, `consumeTicket`, `peekTicket`

- [ ] **Step 4: Build, fix any remaining import errors**

```bash
npm run build
```

- [ ] **Step 5: Run tests**

```bash
npm test
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/authTools.ts src/services/sessionManager.ts
git commit -m "refactor(oauth): retire ticket-based auth_login; clients use OAuth"
```

---

## Task 15: End-to-end flow integration test

**Files:**
- Create: `src/tests/oauth/flow.test.ts`

This drives the full OAuth dance through supertest, with `loginWithCredentials` mocked so we never hit the real identity server.

- [ ] **Step 1: Test**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { createHash, randomBytes } from "node:crypto";
import express from "express";

// Mock Lincx auth so the flow doesn't reach the real identity server
vi.mock("../../services/auth.js", () => ({
  loginWithCredentials: vi.fn(async (email: string) => ({ authToken: `jwt-for-${email}` })),
  revokeToken: vi.fn(async () => {}),
}));
vi.mock("../../services/networkService.js", () => ({
  fetchUserNetworks: vi.fn(async () => [{ id: "svce6t", name: "Test Net" }]),
}));

import { wellKnownRouter } from "../../routes/wellKnown.js";
import { oauthRegisterRouter } from "../../routes/oauthRegister.js";
import { oauthTokenRouter } from "../../routes/oauthToken.js";
import { loginRouter } from "../../routes/login.js";
import { resolveLincxSessionFromBearer } from "../../services/sessionManager.js";

function challenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("OAuth end-to-end", () => {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use("/.well-known", wellKnownRouter);
  app.use("/oauth", oauthRegisterRouter);
  app.use("/oauth", oauthTokenRouter);
  app.use(loginRouter);

  it("client → register → authorize → login → token → bearer resolves to Lincx session", async () => {
    // 1. Register
    const reg = await request(app).post("/oauth/register").send({
      redirect_uris: ["https://localhost:1/cb"],
      client_name: "test",
    });
    expect(reg.status).toBe(201);
    const client_id = reg.body.client_id;

    // 2. Authorize → 302 to /login?req=<id>
    const verifier = randomBytes(40).toString("base64url");
    const auth = await request(app).get("/oauth/authorize").query({
      response_type: "code", client_id, redirect_uri: "https://localhost:1/cb",
      state: "abc", code_challenge: challenge(verifier), code_challenge_method: "S256",
    });
    expect(auth.status).toBe(302);
    const loc = auth.headers.location as string;
    const reqId = new URL(loc, "http://x").searchParams.get("req");
    expect(reqId).toBeTruthy();

    // 3. POST /api/login → JSON { redirect: "https://localhost:1/cb?code=...&state=abc" }
    const login = await request(app).post("/api/login")
      .query({ req: reqId })
      .send({ email: "u@x.com", password: "pw" });
    expect(login.status).toBe(200);
    expect(login.body.success).toBe(true);
    const redirect = new URL(login.body.redirect);
    const code = redirect.searchParams.get("code")!;
    expect(redirect.searchParams.get("state")).toBe("abc");

    // 4. Exchange code → access + refresh tokens
    const tok = await request(app).post("/oauth/token").type("form").send({
      grant_type: "authorization_code", code,
      redirect_uri: "https://localhost:1/cb",
      client_id, code_verifier: verifier,
    });
    expect(tok.status).toBe(200);
    const access = tok.body.access_token;

    // 5. Bearer resolves to a Lincx session id
    const lincxSid = await resolveLincxSessionFromBearer(`Bearer ${access}`);
    expect(lincxSid).toMatch(/^[0-9a-f-]{36}$/);

    // 6. Refresh
    const refr = await request(app).post("/oauth/token").type("form").send({
      grant_type: "refresh_token",
      refresh_token: tok.body.refresh_token,
      client_id,
    });
    expect(refr.status).toBe(200);
    expect(refr.body.access_token).not.toBe(access);
  });
});
```

- [ ] **Step 2: Run**

```bash
npm test
```
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/tests/oauth/flow.test.ts
git commit -m "test(oauth): end-to-end register → authorize → token → bearer flow"
```

---

## Task 16: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Update `CLAUDE.md`**:
  - Replace the "Authentication flow" section to describe OAuth (per the End-to-end flow box at the top of this plan).
  - Update "Session model" — `auth_token` and `Session` are unchanged; bindings now via `oauth:access:*` instead of `mcp:session:*` for HTTP transport.
  - Update "Critical rules" — add: "Never log access/refresh tokens. Truncate to 8 chars max."
  - Replace "Known issues" 401-on-login pointer if no longer relevant; otherwise keep.
  - Update the deployment section: user URL is now `https://<app>.fly.dev/mcp` (no `?key=` if `MCP_ACCESS_KEY` is unset; OAuth is sufficient identity).

- [ ] **Step 2: Update `README.md`** (briefly): add a "Connecting from an MCP client" section describing the OAuth handshake.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs(oauth): document OAuth flow and updated deployment URL"
```

---

## Self-review — open questions to resolve before merge

1. **Should `MCP_ACCESS_KEY` still gate `/mcp`?** With OAuth in place, the bearer token is the user identity. Keeping the access-key gate adds a deploy-wide gate but breaks the standard OAuth UX (clients can't include `?key=…` in the metadata-driven flow). **Recommendation:** drop the access-key gate from `/mcp` once OAuth is verified working. Keep it only on `/dev/*` and `/health` if at all.

2. **Per-client redirect_uri whitelist for claude.ai vs Claude desktop.** DCR is open; any client can register. That's correct per spec. Lock it down later if abuse surfaces.

3. **Do we need to bind multiple device sessions to one Lincx session, or accept N Lincx sessions for N devices?** Plan currently issues a fresh Lincx session per OAuth authorization (one per device). This is simpler and matches the implementation. Tradeoff: a user logging in on 3 devices has 3 Lincx JWTs in flight against the upstream. If the upstream rate-limits per JWT this could matter — confirm with backend team.

4. **Lincx JWT expiry.** Refresh token TTL (30d) matches Lincx JWT lifetime (~30d). When the JWT expires server-side, Work API calls return 401, but the OAuth access token might still be valid. Plan: in a follow-up, have `workApiRequest` detect upstream 401, mark the Session expired, and have `/oauth/token` refresh return `invalid_grant` so the client re-authorizes. Out of scope for this plan; track as a follow-up.

5. **Old `mcp:session:*` keys.** The plan still binds them inside `/mcp` (Task 13, Step 1) so existing tool code (`resolveLincxSession(extra.sessionId)`) keeps working. After OAuth lands, `bindMcpToLincxSession` is called on every authenticated request, so the binding is always fresh. We could remove the binding entirely and pass the Lincx session id through `extra` directly, but that requires reaching into the SDK. Keeping the binding is the lower-risk path.

---

**Plan complete. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration. Best for security-sensitive code where each commit gets a focused review.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
