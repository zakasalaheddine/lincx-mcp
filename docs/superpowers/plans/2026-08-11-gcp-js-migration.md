# lincx-mcp-server → Lincx House Stack Migration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move lincx-mcp-server from TypeScript + Express + vitest + Docker/Coolify to plain JavaScript + `http-hash-router` + `ava`, deployed on Google App Engine with the existing GCP Memorystore Redis — with zero behavioural change to the MCP/OAuth wire surface.

**Architecture:** Four sequential conversions, one variable each, all gated by a single black-box HTTP contract suite written **first** against the current Express server. The contract suite is the invariant: it is written once in Phase 0, survives the runner swap unchanged in assertions, and must pass byte-for-byte after the router swap. Nothing is deleted until its replacement passes that suite.

**Tech Stack:** Node ≥ 22 (GAE `nodejs22`), plain ESM JavaScript, `http-hash-router@2.0.1`, `ava@6.4.1`, `esmock@2.7.6`, `supertest@7`, `ioredis@5`, `zod@3` (protocol requirement, stays), `@modelcontextprotocol/sdk@1.29`, Google App Engine Standard + Memorystore + Secret Manager.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **`console.log` is banned repo-wide.** All logging goes to stderr via `console.error`. Applies to every new file in this plan. (CLAUDE.md hard rule.)
- **Never log tokens.** OAuth access/refresh tokens, auth codes, and the Lincx JWT are bearer credentials. At most 8 chars or a SHA hash.
- **Tools never accept `networkId`.** Network context comes from `session.active_network` inside `workApiRequest()`. No task in this plan touches that.
- **`session_id` is never exposed to a tool.** Session identity comes from `extra.sessionId`.
- **Single instance only.** MCP transport state is an in-process `Map`. Every deployment config in this plan must guarantee exactly one running instance.
- **`/mcp` must answer unauthenticated callers with `401` + `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource"`.** No auth gate may sit in front of it. This is the entire OAuth discovery path.
- **All imports keep the `.js` extension.** The project is `"type": "module"` ESM; extensionless imports do not resolve.
- **Dependency budget.** Phases 1–3 must not increase the runtime dependency count: `express` + `express-rate-limit` out, `http-hash-router` in, so 6 → 5. Phase 4 adds exactly one, `@google-cloud/secret-manager` (6), and that is the only sanctioned addition in this plan — `app.yaml` is committed to git, so `REDIS_URL` cannot live in it and there is no smaller way to read a secret on GAE. Anything beyond that needs a deletion to pay for it.
- **Every phase ends with the full contract suite green.** A phase is not done otherwise.
- **Node floor: `>=22.20.0`** if `ava@8` is chosen; `>=22.0.0` for `ava@6.4.1` (the default in this plan — see Decision D4).
- **`zod` stays.** The MCP SDK requires runtime schemas for tool definitions. It is protocol, not TypeScript. Do not remove it while stripping types.

---

## Decisions and Assumptions

These are stated so the plan can proceed. Each names its alternative; flag disagreement before Phase 1, not during.

| # | Decision | Why | Alternative if rejected |
|---|---|---|---|
| **D1** | **Order: evidence → TS strip → runner swap → router swap → deploy.** | One variable per phase. Each is a separately reviewable PR against a fixed acceptance harness. | Router-first would mean rewriting Express routes in TS and then stripping them — same work twice. |
| **D2** | **Strip types with `ts-blank-space`, not by hand and not by shipping `dist/`.** | It replaces type syntax with whitespace: line numbers, comments, and formatting are preserved, so the diff is reviewable as "types removed" rather than "file rewritten". Verified clean: the codebase has no `enum`, `namespace`, `declare`, parameter properties, or value-imports from `types.ts`. | `tsc` emit — downlevels and reflows everything, unreviewable diff. |
| **D3** | **Mock with `esmock@2.7.6`.** Node ≥ 20.6 needs **no** `--loader` flag. | Only 5 test files use `vi.mock`. esmock's 3rd argument does transitive (whole-import-tree) mocking, which `flow.test.ts` needs. | Refactor tools to constructor-injected dependencies — a source change during a test change, which breaks D1. |
| **D4** | **`ava@6.4.1`.** | `ava@8` requires Node `^22.20`; the dev machine is on 22.13.1. `6.4.1` accepts `^22`. | If other lincx repos already pin a specific ava major, **match theirs** — that is the entire point of this migration. Confirm before Task 12. |
| **D5** | **GAE Standard, scaling mode decided by the Phase 0 spike — not asserted here.** | Request-timeout and response-buffering behaviour differ per scaling mode and are the only real platform risk. Task 3 measures it. | Cloud Run if the spike fails. |
| **D6** | **Secrets (`REDIS_URL`, `STATS_TOKEN`) in Secret Manager, read at boot.** | `app.yaml` is committed to git; `REDIS_URL` carries the Redis password. | `gcloud app deploy --appyaml=env.yaml` with a gitignored file — works, but couples deploys to a file that only lives on someone's laptop. |
| **D7** | **`docker-compose.dev.yml` stays, for local Redis only.** | Dev-only convenience is not "introducing Docker to the org". `Dockerfile`, `docker-compose.yml`, and `docker-compose.coolify.yml` are deleted. | `brew install redis` and drop the file entirely. |
| **D8** | **Hand-roll the rate limiter (~50 lines) rather than find an Express-free package.** | `express-rate-limit` is Express-only and must go. A fixed-window counter over a `Map` is smaller than evaluating a replacement, and D-constraint "no net new dependency" applies. | `rate-limiter-flexible` if a Redis-backed shared limiter is ever needed (it isn't — single instance). |

---

## File Structure

### Deleted
```
tsconfig.json                    # no build step
vitest.config.ts                 # replaced by ava config in package.json
Dockerfile                       # GAE builds from source
docker-compose.yml               # prod compose — replaced by app.yaml
docker-compose.coolify.yml       # Coolify is off the table
src/types.ts                     # all interfaces; erases to empty
dist/                            # no compile output
```

### Created
```
app.yaml                         # GAE service config
.gcloudignore                    # what not to upload
cloudbuild.yaml                  # master-push deploy
src/config/secrets.js            # Secret Manager fetch at boot
src/http/respond.js              # json() / send() / redirect() / noContent()
src/http/request.js              # query() / header() / clientIp() / readBody()
src/http/router.js               # http-hash-router route table + error handler
src/tests/contract/http.test.js  # THE acceptance harness (Phase 0, survives all phases)
src/tests/helpers/spy.js         # 6-line vi.fn() replacement
src/tests/mcpProtocol.test.js    # new: real MCP client ↔ server round trip
src/tests/redisIntegration.test.js # new: sessionStore against real Redis
scripts/smoke-prod.mjs           # post-deploy verification against the live URL
```

### Modified (every `.ts` → `.js`; 43 source + 24 test files)
```
src/index.ts   → src/index.js    # express app → http.createServer + router table
src/routes/*.ts → *.js           # express.Router → plain (req,res,opts,cb) handlers
src/middleware/rateLimit.ts → .js # express-rate-limit → hand-rolled
src/services/**, src/tools/**    # type erasure only, no logic change
src/tests/**                     # type erasure, then vitest → ava
package.json                     # scripts, deps, engines, ava config
```

### Unchanged in behaviour (touched only by type erasure)
`src/tools/*` (19 files), `src/services/*` (11 files), `src/views/login.ts`, `src/constants.ts`, `src/middleware/toolGuard.ts`. **No business logic changes anywhere in this plan.** If a diff in these files changes anything but type syntax, it is a bug.

---

# PHASE 0 — Evidence and the Acceptance Harness

Nothing is rewritten in this phase. Its only output is (a) knowledge of whether GAE can host this, and (b) the test suite that makes the next three phases safe.

---

### Task 1: Instrument `GET /mcp` on the currently deployed server

The whole GAE risk assessment turns on one unknown: `enableJsonResponse: true` is already set (`src/index.ts:142`), so `POST /mcp` returns `application/json` — **the only SSE surface in the entire server is `GET /mcp`**. If real clients never open it, the streaming risk evaporates and GAE Standard is uncontroversial.

Measure it on production before designing a spike around it.

**Files:**
- Modify: `src/index.ts:221-234` (the `app.get("/mcp", ...)` handler)

**Interfaces:**
- Produces: a stderr log line `[MCP-PROBE] {...}` in production logs, consumed by Task 3's decision gate.

- [ ] **Step 1: Add the probe log**

In `src/index.ts`, at the very top of the `app.get("/mcp", ...)` handler (before the bearer check):

```ts
app.get("/mcp", async (req, res) => {
  // TEMPORARY (remove after Phase 0 Task 3): measures whether any real client
  // opens the SSE stream. Decides whether GAE's request-timeout behaviour matters.
  console.error(JSON.stringify({
    probe: "GET /mcp",
    ua: req.header("user-agent") ?? "",
    has_session: Boolean(req.header("mcp-session-id")),
    has_auth: Boolean(req.header("authorization")),
    accept: req.header("accept") ?? "",
  }));
  const lincxSessionId = await resolveLincxSessionFromBearer(req.header("authorization"));
  // ... rest unchanged
```

Also add the same one-liner to `app.post("/mcp", ...)` so you get a denominator:

```ts
app.post("/mcp", mcpLimiter, async (req, res) => {
  console.error(JSON.stringify({ probe: "POST /mcp", ua: req.header("user-agent") ?? "" }));
  try {
```

- [ ] **Step 2: Verify the build still compiles**

Run: `npm run build`
Expected: exit 0, no TS errors.

- [ ] **Step 3: Run the existing suite**

Run: `npm test`
Expected: all tests pass (this change adds no behaviour).

- [ ] **Step 4: Commit and deploy to the current production host**

```bash
git add src/index.ts
git commit -m "chore(probe): log GET /mcp opens to size the GAE streaming risk"
```

Deploy via the existing Coolify/compose path. This is the last deploy on the old platform.

- [ ] **Step 5: Let it run and collect**

Leave it for **at least 24 hours of real client traffic** (Claude Desktop, claude.ai, and Claude Code via `mcp-remote` — exercise all three at least once yourself).

Then count:

```bash
# on the production host
docker compose logs app 2>&1 | grep -c '"probe":"GET /mcp"'
docker compose logs app 2>&1 | grep -c '"probe":"POST /mcp"'
docker compose logs app 2>&1 | grep '"probe":"GET /mcp"' | head -20
```

Record the numbers in `docs/superpowers/plans/phase0-findings.md`:

```markdown
# Phase 0 findings

## GET /mcp traffic (Task 1)
- Window: <start> → <end>
- POST /mcp count: <n>
- GET /mcp count: <n>
- Clients that opened GET: <list of user-agents>
- Longest observed GET hold: <duration, from log timestamps>

**Gate:** if GET count is 0 across all three client types → SSE is not on the
critical path; Task 3 tests request duration only for completeness.
If GET count > 0 → Task 3's SSE hold test is a hard gate.
```

- [ ] **Step 6: Commit the findings file**

```bash
git add docs/superpowers/plans/phase0-findings.md
git commit -m "docs(phase0): record GET /mcp traffic measurement"
```

---

### Task 2: Write the HTTP contract suite against the current Express server

This is the single most important task in the plan. It pins the **observable** behaviour of every HTTP route so the router swap in Phase 3 is verifiable rather than hopeful. It is written in vitest now, converted mechanically to ava in Phase 2, and must pass **unchanged in its assertions** after Phase 3.

It deliberately pins the edges where `http-hash` + `http-methods` differ from Express: method-not-allowed, trailing slashes, redirects, malformed bodies, body size limits, and the `WWW-Authenticate` challenge.

**Files:**
- Create: `src/tests/contract/http.test.ts`
- Create: `src/tests/contract/buildApp.ts`

**Interfaces:**
- Produces: `buildContractApp()` — returns a listener accepted by `supertest`. Phase 3 replaces its body; the test file never changes.

- [ ] **Step 1: Write the app builder**

`src/tests/contract/buildApp.ts`:

```ts
/**
 * The ONE place the contract suite knows how the server is assembled.
 * Phase 3 rewrites this file's body to build the http-hash-router listener;
 * http.test.ts must not change.
 */
import express from "express";
import { wellKnownRouter } from "../../routes/wellKnown.js";
import { oauthRegisterRouter } from "../../routes/oauthRegister.js";
import { oauthTokenRouter } from "../../routes/oauthToken.js";
import { statsRouter } from "../../routes/stats.js";
import { loginRouter } from "../../routes/login.js";

export function buildContractApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", uptime_s: Math.round(process.uptime()), active_sessions: 0 });
  });
  app.use("/.well-known", wellKnownRouter);
  app.use("/oauth", oauthRegisterRouter);
  app.use("/oauth", oauthTokenRouter);
  app.use(statsRouter);
  app.use(loginRouter);
  return app;
}
```

- [ ] **Step 2: Write the failing contract test**

`src/tests/contract/http.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import request from "supertest";
import { buildContractApp } from "./buildApp.js";

const app = buildContractApp();

describe("contract: /health", () => {
  it("200 with status ok", async () => {
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    expect(typeof r.body.uptime_s).toBe("number");
  });

  it("records the method-not-allowed behaviour for POST /health", async () => {
    const r = await request(app).post("/health");
    // RECORD-THEN-PIN: run once, replace with the observed value, never change again.
    expect([404, 405]).toContain(r.status);
  });

  it("records the trailing-slash behaviour for /health/", async () => {
    const r = await request(app).get("/health/");
    expect([200, 404]).toContain(r.status);
  });
});

describe("contract: OAuth discovery", () => {
  it("serves authorization-server metadata", async () => {
    const r = await request(app).get("/.well-known/oauth-authorization-server");
    expect(r.status).toBe(200);
    expect(r.body.issuer).toBeDefined();
    expect(r.body.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
    expect(r.body.token_endpoint).toMatch(/\/oauth\/token$/);
    expect(r.body.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(r.body.code_challenge_methods_supported).toEqual(["S256"]);
  });

  it("serves protected-resource metadata at the ROOT form", async () => {
    const r = await request(app).get("/.well-known/oauth-protected-resource");
    expect(r.status).toBe(200);
    expect(r.body.resource).toMatch(/\/mcp$/);
  });

  it("serves protected-resource metadata at the RFC-9728 path-suffixed form", async () => {
    const r = await request(app).get("/.well-known/oauth-protected-resource/mcp");
    expect(r.status).toBe(200);
    expect(r.body.resource).toMatch(/\/mcp$/);
  });
});

describe("contract: dynamic client registration", () => {
  it("201 with a client_id for a valid redirect_uri", async () => {
    const r = await request(app)
      .post("/oauth/register")
      .send({ redirect_uris: ["http://localhost:9999/callback"], client_name: "contract" });
    expect(r.status).toBe(201);
    expect(typeof r.body.client_id).toBe("string");
    expect(r.body.token_endpoint_auth_method).toBe("none");
    expect(r.body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(r.body.response_types).toEqual(["code"]);
  });

  it("400 invalid_redirect_uri for a missing redirect_uris", async () => {
    const r = await request(app).post("/oauth/register").send({ client_name: "bad" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_redirect_uri");
  });

  it("rejects a malformed JSON body", async () => {
    const r = await request(app)
      .post("/oauth/register")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(r.status).toBe(400);
  });

  it("rejects a body over the 100kb limit", async () => {
    const big = { redirect_uris: ["http://x/cb"], client_name: "x".repeat(200_000) };
    const r = await request(app)
      .post("/oauth/register")
      .set("Content-Type", "application/json")
      .send(JSON.stringify(big));
    expect(r.status).toBe(413);
  });
});

describe("contract: token endpoint", () => {
  it("400 unsupported_grant_type for an unknown grant", async () => {
    const r = await request(app).post("/oauth/token").send({ grant_type: "password" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("unsupported_grant_type");
  });

  it("400 invalid_request when authorization_code fields are missing", async () => {
    const r = await request(app).post("/oauth/token").send({ grant_type: "authorization_code" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_request");
  });

  it("400 invalid_client for an unknown client_id", async () => {
    const r = await request(app).post("/oauth/token").send({
      grant_type: "authorization_code",
      code: "x", redirect_uri: "http://x/cb", client_id: "nope", code_verifier: "v",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_client");
  });

  it("accepts an application/x-www-form-urlencoded body", async () => {
    const r = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({ grant_type: "password" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("unsupported_grant_type");
  });

  it("records the method-not-allowed behaviour for GET /oauth/token", async () => {
    const r = await request(app).get("/oauth/token");
    expect([404, 405]).toContain(r.status);
  });
});

describe("contract: authorize + login UI", () => {
  it("400 HTML for an unsupported response_type", async () => {
    const r = await request(app).get("/oauth/authorize?response_type=token");
    expect(r.status).toBe(400);
    expect(r.headers["content-type"]).toMatch(/html/);
  });

  it("400 for missing required params", async () => {
    const r = await request(app).get("/oauth/authorize?response_type=code&client_id=a");
    expect(r.status).toBe(400);
  });

  it("400 for a non-S256 code_challenge_method", async () => {
    const r = await request(app).get(
      "/oauth/authorize?response_type=code&client_id=a&redirect_uri=http%3A%2F%2Fx%2Fcb&state=s&code_challenge=c&code_challenge_method=plain"
    );
    expect(r.status).toBe(400);
  });

  it("302-redirects a valid authorize to /login?req=<hex>", async () => {
    const reg = await request(app)
      .post("/oauth/register")
      .send({ redirect_uris: ["http://localhost:9999/callback"] });
    const r = await request(app).get(
      `/oauth/authorize?response_type=code&client_id=${reg.body.client_id}` +
      `&redirect_uri=${encodeURIComponent("http://localhost:9999/callback")}` +
      `&state=st&code_challenge=chal&code_challenge_method=S256`
    );
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/^\/login\?req=[0-9a-f]{32}$/);
  });

  it("400 HTML for /login without a req id", async () => {
    const r = await request(app).get("/login");
    expect(r.status).toBe(400);
    expect(r.headers["content-type"]).toMatch(/html/);
  });

  it("400 HTML for /login with an expired req id", async () => {
    const r = await request(app).get("/login?req=deadbeef");
    expect(r.status).toBe(400);
    expect(r.text).toContain("expired");
  });

  it("serves the success page as HTML", async () => {
    const r = await request(app).get("/login/success");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/html/);
  });

  it("400 JSON for POST /api/login without a req id", async () => {
    const r = await request(app).post("/api/login").send({ email: "a@b.c", password: "p" });
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
  });

  it("400 JSON for POST /api/login without credentials", async () => {
    const r = await request(app).post("/api/login?req=abc").send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/required/i);
  });
});

describe("contract: /stats gating", () => {
  it("404s when STATS_TOKEN is unset", async () => {
    // constants.ts reads STATS_TOKEN at import time; this suite runs with it unset.
    const r = await request(app).get("/stats");
    expect(r.status).toBe(404);
  });
});
```

- [ ] **Step 3: Run it and convert every RECORD-THEN-PIN case to a hard assertion**

Run: `npx vitest run src/tests/contract/http.test.ts --reporter=verbose`

For each `expect([404, 405]).toContain(...)` and `expect([200, 404]).toContain(...)`, read the actual status from the verbose output and replace the loose assertion with the exact one. Example: if `POST /health` returns 404, change to `expect(r.status).toBe(404);` and add a comment `// express falls through; http-methods returns 405 — Phase 3 must preserve 404`.

Expected after this step: every assertion is exact, suite green.

- [ ] **Step 4: Add the trailing-slash sweep**

Express `Router()` mounted with `app.use()` matches both `/stats` and `/stats/`. `http-hash` matches exact pathname segments. Add one case per route so a silent break is impossible:

```ts
describe("contract: trailing slashes", () => {
  const routes = [
    "/health/",
    "/.well-known/oauth-authorization-server/",
    "/.well-known/oauth-protected-resource/",
    "/login/success/",
    "/stats/",
  ];
  for (const path of routes) {
    it(`pins the status of GET ${path}`, async () => {
      const r = await request(app).get(path);
      // RECORD-THEN-PIN: replace with the observed status.
      expect([200, 301, 404]).toContain(r.status);
    });
  }
});
```

Run it, record each actual status, pin it exactly.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass, including the 204 pre-existing assertions.

- [ ] **Step 6: Commit**

```bash
git add src/tests/contract/
git commit -m "test(contract): pin the HTTP surface before the stack migration"
```

---

### Task 3: GAE spike — measure, do not assume

Deploy a throwaway app that answers the questions the migration depends on. **No number about GAE appears anywhere else in this plan except as an output of this task.**

**Files:**
- Create (throwaway, in a scratch dir outside the repo): `spike/app.yaml`, `spike/server.js`, `spike/package.json`

**Interfaces:**
- Produces: the filled-in "GAE spike results" section of `docs/superpowers/plans/phase0-findings.md`, which Task 21 reads to write the real `app.yaml`.

- [ ] **Step 1: Write the spike server**

`spike/server.js`:

```js
import http from 'node:http'

const started = Date.now()

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x')

  if (url.pathname === '/_ah/start' || url.pathname === '/_ah/stop') {
    res.writeHead(200).end('ok')
    return
  }

  // Q1: does GAE hold a long-lived SSE response, and for how long?
  if (url.pathname === '/sse') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    })
    let n = 0
    const timer = setInterval(() => {
      n += 1
      res.write(`data: ${JSON.stringify({ n, elapsed_s: n * 5 })}\n\n`)
    }, 5000)
    req.on('close', () => {
      clearInterval(timer)
      console.error(`[spike] SSE closed after ${n * 5}s`)
    })
    return
  }

  // Q2: is the response buffered or streamed? (chunks must arrive incrementally)
  if (url.pathname === '/drip') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    let n = 0
    const t = setInterval(() => {
      res.write(`chunk ${++n} at ${Date.now()}\n`)
      if (n === 10) { clearInterval(t); res.end() }
    }, 1000)
    return
  }

  // Q3: what does X-Forwarded-For look like from a real client?
  if (url.pathname === '/whoami') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      xff: req.headers['x-forwarded-for'] ?? null,
      xff_split: (req.headers['x-forwarded-for'] ?? '').split(',').map(s => s.trim()),
      socket_remote: req.socket.remoteAddress,
      gae_ip: req.headers['x-appengine-user-ip'] ?? null,
      forwarded: req.headers.forwarded ?? null,
      instance: process.env.GAE_INSTANCE ?? null
    }, null, 2))
    return
  }

  // Q4: does the instance survive, and is it a SINGLE instance?
  if (url.pathname === '/whoinstance') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      instance: process.env.GAE_INSTANCE ?? null,
      version: process.env.GAE_VERSION ?? null,
      uptime_s: Math.round((Date.now() - started) / 1000)
    }))
    return
  }

  // Q5: can we reach Memorystore over the VPC connector?
  if (url.pathname === '/redis') {
    import('ioredis').then(async ({ Redis }) => {
      const r = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 2, connectTimeout: 5000 })
      try {
        await r.set('spike:ping', String(Date.now()), 'EX', 60)
        const v = await r.get('spike:ping')
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, value: v }))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: err.message }))
      } finally {
        r.disconnect()
      }
    })
    return
  }

  res.writeHead(404).end('nope')
}).listen(process.env.PORT || 8080, () => {
  console.error(`[spike] listening on ${process.env.PORT || 8080}`)
})
```

`spike/package.json`:

```json
{
  "name": "gae-spike",
  "private": true,
  "type": "module",
  "scripts": { "start": "node server.js" },
  "dependencies": { "ioredis": "^5.3.0" },
  "engines": { "node": ">=22" }
}
```

- [ ] **Step 2: Deploy variant A — automatic scaling**

`spike/app.yaml`:

```yaml
runtime: nodejs22
service: mcp-spike

automatic_scaling:
  min_instances: 1
  max_instances: 1

env_variables:
  REDIS_URL: "redis://<memorystore-ip>:6379"

vpc_access_connector:
  name: projects/<PROJECT_ID>/locations/<REGION>/connectors/<CONNECTOR_NAME>
```

```bash
cd spike && gcloud app deploy app.yaml --project=<PROJECT_ID> --quiet
```

- [ ] **Step 3: Measure variant A**

```bash
BASE=https://mcp-spike-dot-<PROJECT_ID>.<REGION>.r.appspot.com

# Q3 + Q4
curl -s $BASE/whoami
curl -s $BASE/whoinstance

# Q5
curl -s $BASE/redis

# Q2 — chunks must arrive ~1s apart, not all at once at the end
curl -N -s $BASE/drip | while read -r line; do echo "$(date +%s) $line"; done

# Q1 — hold and time it
curl -N -s --max-time 3900 $BASE/sse | while read -r line; do echo "$(date +%s) $line"; done
```

Record: last `elapsed_s` seen before the SSE stream was cut, whether `/drip` streamed or buffered, and the exact `xff_split` array.

- [ ] **Step 4: Deploy and measure variant B — manual scaling**

Change `spike/app.yaml`:

```yaml
runtime: nodejs22
service: mcp-spike

manual_scaling:
  instances: 1

inbound_services:
  - warmup

env_variables:
  REDIS_URL: "redis://<memorystore-ip>:6379"

vpc_access_connector:
  name: projects/<PROJECT_ID>/locations/<REGION>/connectors/<CONNECTOR_NAME>
```

Redeploy and repeat every measurement from Step 3.

- [ ] **Step 5: Measure instance identity across a redeploy**

```bash
curl -s $BASE/whoinstance     # note GAE_INSTANCE
gcloud app deploy spike/app.yaml --project=<PROJECT_ID> --quiet
curl -s $BASE/whoinstance     # GAE_INSTANCE must differ; uptime resets
```

This confirms the "redeploy drops live MCP sessions" statement in the reply to the platform team — measured, not assumed.

- [ ] **Step 6: Write up the results and take the decision**

Append to `docs/superpowers/plans/phase0-findings.md`:

```markdown
## GAE spike results (Task 3)

| Question | automatic_scaling min=max=1 | manual_scaling instances=1 |
|---|---|---|
| SSE stream held for | <N>s before cut | <N>s before cut |
| /drip streamed or buffered | <streamed \| buffered> | <streamed \| buffered> |
| X-Forwarded-For shape | `<paste xff_split>` | `<paste xff_split>` |
| Memorystore reachable | <yes/no> | <yes/no> |
| Instance count observed | <n distinct GAE_INSTANCE> | <n> |
| Cold start on first hit | <yes/no> | <yes/no> |

**Client-IP index:** with `<N>` proxy hops observed, the client IP is
`xff_split[<index>]`. Task 16's `clientIp()` uses this index.

**DECISION:** scaling mode = `<automatic|manual>`, because <reason>.

**Gate check against Task 1:** GET /mcp traffic was <n>. SSE hold of <N>s is
<sufficient|insufficient>.

**If insufficient AND GET /mcp traffic > 0:** stop here. GAE Standard is not a
fit; escalate to Cloud Run (same container-free `npm start`, no request-duration
cap on streaming) before starting Phase 1.
```

- [ ] **Step 7: Tear down the spike and commit findings**

```bash
gcloud app services delete mcp-spike --project=<PROJECT_ID> --quiet
rm -rf spike
git add docs/superpowers/plans/phase0-findings.md
git commit -m "docs(phase0): GAE spike measurements and scaling decision"
```

---

# PHASE 1 — TypeScript → JavaScript

Source and tests both. **Express and vitest stay exactly as they are.** `npm test` must be green after every task.

---

### Task 4: Install the erasure toolchain and the lint that replaces the compiler

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install**

```bash
npm i -D ts-blank-space@^0.9.0 standard@^17.1.2
```

- [ ] **Step 2: Add the lint script and confirm the compiler still runs**

In `package.json` `scripts`, add:

```json
"lint": "standard src/",
"lint:fix": "standard --fix src/"
```

- [ ] **Step 3: Write the erasure script**

`scripts/strip-types.mjs`:

```js
#!/usr/bin/env node
// One-shot: erase TypeScript syntax in place, .ts -> .js, rewriting nothing else.
// ts-blank-space replaces type syntax with spaces, so line numbers, comments and
// formatting survive. `standard --fix` then removes the leftover whitespace.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import tsBlankSpace from 'ts-blank-space'

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: node scripts/strip-types.mjs <file.ts> [...]')
  process.exit(1)
}

for (const file of files) {
  if (!file.endsWith('.ts')) { console.error(`skip (not .ts): ${file}`); continue }
  const src = readFileSync(file, 'utf8')
  const out = tsBlankSpace(src, (node) => {
    console.error(`[strip] UNERASABLE construct in ${file} at pos ${node.pos}: kind ${node.kind}`)
    process.exitCode = 1
  })
  const target = file.replace(/\.ts$/, '.js')
  writeFileSync(target, out)
  unlinkSync(file)
  console.error(`[strip] ${file} -> ${target}`)
}
```

- [ ] **Step 4: Verify on one file first**

```bash
cp src/services/oauth/pkce.ts /tmp/pkce.ts.bak
node scripts/strip-types.mjs src/services/oauth/pkce.ts
cat src/services/oauth/pkce.js
```

Expected: identical to the original except the type annotations are gone. No `[strip] UNERASABLE` lines.

- [ ] **Step 5: Roll it back and commit only the tooling**

```bash
git checkout src/services/oauth/
git add package.json package-lock.json scripts/strip-types.mjs
git commit -m "build: add ts-blank-space erasure script and standard lint"
```

---

### Task 5: Erase types from `src/services/` and `src/tools/`

30 files, no logic change. The whole diff must be "type syntax removed" — nothing else.

**Files:**
- Modify: all 11 files under `src/services/`, all 19 under `src/tools/`
- Delete: `src/types.ts`

**Interfaces:**
- Consumes: `scripts/strip-types.mjs` from Task 4.
- Produces: `.js` modules with identical named exports. Every existing `import { x } from "./y.js"` keeps working because the extension was already `.js`.

- [ ] **Step 1: Confirm every `types.ts` import is type-only**

Run:

```bash
grep -rn 'types\.js"' src/ | grep -v 'sdk/types.js' | grep -v 'import type'
```

Expected: **no output.** (Verified during planning — all 13 imports of `../types.js` are `import type`, so erasing them leaves no runtime import of an empty module. If this grep prints anything, stop and convert that import to `import type` before continuing.)

- [ ] **Step 2: Erase services and tools**

```bash
node scripts/strip-types.mjs src/services/*.ts src/services/oauth/*.ts src/tools/*.ts src/constants.ts src/views/login.ts src/middleware/toolGuard.ts
```

Expected: one `[strip] x.ts -> x.js` line per file, and **no `UNERASABLE` line**. If any appears, fix that construct by hand and re-run.

- [ ] **Step 3: Delete the now-empty types module**

```bash
cat src/types.js   # confirm it is only comments/whitespace
rm src/types.js
```

- [ ] **Step 4: Remove the dangling type-only imports**

`ts-blank-space` erases `import type {...} from "../types.js"` entirely, so there should be nothing left. Confirm:

```bash
grep -rn 'types\.js' src/ | grep -v 'sdk/types.js'
```

Expected: no output.

- [ ] **Step 5: Clean the whitespace**

```bash
npm run lint:fix
```

Fix any remaining `standard` errors by hand. Do **not** let `--fix` reformat semantics; review the diff.

- [ ] **Step 6: Verify no logic changed**

```bash
git diff --stat
git diff src/tools/eligibility.js | grep '^[+-]' | grep -v '^[+-][+-]' | grep -vE '^\+\s*$|^-\s*$' | head -60
```

Every remaining `-` line must be a type annotation, interface, or `import type`. Every `+` line must be the same line with the annotation removed. **If a `+` line contains logic that is not in the corresponding `-` line, revert and redo that file.**

- [ ] **Step 7: Run the suite**

Run: `npm test`
Expected: all 204 assertions pass. vitest resolves `.js` fine; the tests are still `.ts` and still import `../tools/x.js`.

- [ ] **Step 8: Commit**

```bash
git add -A src/
git commit -m "refactor: erase types from services and tools (no logic change)"
```

---

### Task 6: Erase types from `src/routes/`, `src/middleware/rateLimit`, and `src/index`

Kept separate from Task 5 because these are the files Phase 3 rewrites — a reviewer should be able to see the type-erasure diff on them before the router diff lands on top.

**Files:**
- Modify: `src/routes/*.ts` (5), `src/middleware/rateLimit.ts`, `src/index.ts`

- [ ] **Step 1: Erase**

```bash
node scripts/strip-types.mjs src/routes/*.ts src/middleware/rateLimit.ts src/index.ts
```

- [ ] **Step 2: Fix the two casts that carried meaning**

`ts-blank-space` erases `as unknown as {...}` cleanly, but check the two spots that used casts to reach SDK internals:

`src/index.js` around the dev-tools block — the cast is gone and the code reads:

```js
const devServer = createMcpServer()
const registeredTools = devServer._registeredTools
```

`src/middleware/toolGuard.js`:

```js
const registered = server._registeredTools
```

Both are correct — the cast was only satisfying the compiler. Confirm by eye.

- [ ] **Step 3: Lint and run**

```bash
npm run lint:fix
npm test
```

Expected: green.

- [ ] **Step 4: Boot the server for real**

```bash
node --env-file=.env src/index.js
```

Expected on stderr:
```
[HTTP]   Listening on :5001
[HTTP]   /health, /login, /mcp
[MCP]    HTTP transport ready
```

Then, in another terminal:

```bash
curl -s localhost:5001/health
curl -s -i -X POST localhost:5001/mcp | head -5
```

Expected: `/health` returns JSON; `POST /mcp` returns `401` with a `WWW-Authenticate` header.

- [ ] **Step 5: Commit**

```bash
git add -A src/
git commit -m "refactor: erase types from routes, rate limiter and entry point"
```

---

### Task 7: Erase types from the test suite

**Files:**
- Modify: all 24 files under `src/tests/` including `helpers/`, plus the Task 2 contract files

- [ ] **Step 1: Erase**

```bash
node scripts/strip-types.mjs src/tests/*.ts src/tests/helpers/*.ts src/tests/oauth/*.ts src/tests/contract/*.ts
```

- [ ] **Step 2: Update the vitest include glob**

`vitest.config.ts` → rename to `vitest.config.js` and change the glob:

```js
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/tests/**/*.test.js'],
    environment: 'node',
    pool: 'forks'
  }
})
```

```bash
node scripts/strip-types.mjs vitest.config.ts   # if it has annotations; otherwise rename
```

- [ ] **Step 3: Run**

Run: `npm test`
Expected: all pass. **This is the checkpoint that proves the type strip was behaviour-neutral.**

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: erase types from the test suite"
```

---

### Task 8: Remove the compiler and the build step

**Files:**
- Delete: `tsconfig.json`, `dist/`
- Modify: `package.json`, `.gitignore`, `Dockerfile` (temporarily — deleted in Phase 4)

- [ ] **Step 1: Remove the TS dependencies and build script**

```bash
npm rm typescript tsx @types/express @types/node @types/uuid @types/supertest
```

- [ ] **Step 2: Rewrite the scripts block**

`package.json`:

```json
{
  "scripts": {
    "start": "node src/index.js",
    "lint": "standard src/",
    "lint:fix": "standard --fix src/",
    "predev": "docker compose -f docker-compose.dev.yml up -d redis || echo '[predev] Could not start Redis (is Docker running?) — continuing; set REDIS_URL= in .env for the in-memory store.'",
    "dev": "node scripts/dev-tunnel.mjs",
    "predev:local": "docker compose -f docker-compose.dev.yml up -d redis || echo '[predev:local] Could not start Redis (is Docker running?) — continuing; set REDIS_URL= in .env for the in-memory store.'",
    "dev:local": "node --watch --env-file=.env src/index.js",
    "redis:stop": "docker compose -f docker-compose.dev.yml stop redis",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "main": "src/index.js",
  "engines": { "node": ">=22" }
}
```

**Note `"start": "node src/index.js"` — `dist/` no longer exists.** GAE Standard runs `npm start`; leaving this pointing at `dist/` is a guaranteed first-deploy failure.

- [ ] **Step 3: Update `scripts/dev-tunnel.mjs`**

Find the line that spawns the watch server and change `tsx watch --env-file=.env src/index.ts` to `node --watch --env-file=.env src/index.js`:

```bash
grep -n 'tsx\|index\.ts' scripts/dev-tunnel.mjs
```

Edit every hit.

- [ ] **Step 4: Delete build artefacts**

```bash
rm -rf tsconfig.json dist
```

Update `.gitignore`: remove the `dist/` line (nothing produces it now).

- [ ] **Step 5: Patch the Dockerfile so nothing is broken mid-migration**

The Dockerfile is deleted in Phase 4, but must not be broken between now and then:

```dockerfile
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
```

- [ ] **Step 6: Verify end to end**

```bash
npm ci
npm run lint
npm test
npm start &
sleep 2
curl -s localhost:5001/health
kill %1
```

Expected: lint clean, suite green, `/health` returns `{"status":"ok",...}`.

- [ ] **Step 7: Commit — Phase 1 complete**

```bash
git add -A
git commit -m "build: drop TypeScript — plain JS, no build step"
```

**PHASE 1 GATE:** `npm test` green (all pre-existing + contract assertions), `npm run lint` clean, server boots and serves `/health`, `POST /mcp` returns 401 + `WWW-Authenticate`. Express and vitest untouched.

---

# PHASE 2 — vitest → ava

Source untouched. Only `src/tests/**` and `package.json` change.

---

### Task 9: Install ava, configure it, and prove one file passes

**Files:**
- Modify: `package.json`
- Create: `src/tests/helpers/spy.js`

**Interfaces:**
- Produces: `spy(impl?)` → a callable with `.calls` (array of arg-arrays), `.callCount`, `.reset()`. Replaces the 5 `vi.fn()` uses.

- [ ] **Step 1: Confirm which ava major other lincx repos use**

Ask, then pin the same. If there is no precedent, use `ava@6.4.1` (accepts Node `^22`, which the dev machine at 22.13.1 satisfies; `ava@8` requires `^22.20`).

```bash
npm i -D ava@6.4.1 esmock@2.7.6
```

- [ ] **Step 2: Configure ava**

In `package.json`:

```json
"ava": {
  "files": ["src/tests/**/*.test.js"],
  "environmentVariables": {
    "NODE_ENV": "test",
    "STATS_TOKEN": "",
    "REDIS_URL": ""
  },
  "workerThreads": false,
  "timeout": "30s"
}
```

**`STATS_TOKEN` and `REDIS_URL` are pinned empty on purpose.** `constants.js` reads
`process.env` at module scope, so without these the contract suite's "`/stats` 404s
when unset" assertion and every "in-memory store" assumption would depend on
whatever the developer happens to have in `.env` — green on one machine, red on
another. `redisIntegration.test.js` opts back in explicitly via `TEST_REDIS_URL`.

`workerThreads: false` runs each test **file** in a child process — matching vitest's `pool: "forks"`, which the current suite relies on for `process.env` isolation in `stats.route.test.js`, `stats.route.disabled.test.js`, and `analysisToolGating.test.js`.

**esmock needs no `--loader` flag on Node ≥ 20.6.** Do not add `nodeArguments`.

- [ ] **Step 3: Write the spy helper**

`src/tests/helpers/spy.js`:

```js
/** Minimal vi.fn() replacement: records call arguments, optionally delegates. */
export function spy (impl = () => undefined) {
  const fn = (...args) => { fn.calls.push(args); return impl(...args) }
  fn.calls = []
  Object.defineProperty(fn, 'callCount', { get: () => fn.calls.length })
  fn.reset = () => { fn.calls.length = 0 }
  return fn
}
```

- [ ] **Step 4: Convert the smallest pure-unit file as the pilot**

`src/tests/capGroups.test.js` (32 lines, no mocks, no describe nesting beyond one level). Rewrite its header:

```js
import test from 'ava'
import { capGroups } from '../tools/reportingTools.js'
```

Then apply the translation table (Task 10 defines it in full) and flatten the `describe` into title prefixes.

- [ ] **Step 5: Run only that file**

Run: `npx ava src/tests/capGroups.test.js --verbose`
Expected: all its assertions pass with ava.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/tests/helpers/spy.js src/tests/capGroups.test.js
git commit -m "test: add ava alongside vitest; convert capGroups as the pilot"
```

---

### Task 10: Convert the 19 pure-unit test files

These have no mocks and no HTTP: `analysisFit`, `analysisToolGating`, `auth`, `eligibility`, `eligibilityFit`, `filterReportRows`, `fitEntity`, `listEnvelope`, `reportAggregate`, `reportTimezone`, `selectNetworks`, `tokenExpiry`, `toolGuard`, `usageAnalytics`, `zoneInventory`, `oauth/clients`, `oauth/codes`, `oauth/pkce`, `oauth/tokens`.

**Files:**
- Modify: the 19 files listed above

**Interfaces:**
- Consumes: `spy()` from Task 9.
- Produces: nothing — pure conversion.

- [ ] **Step 1: Apply this translation table exactly**

| vitest | ava |
|---|---|
| `import { describe, it, expect } from "vitest"` | `import test from 'ava'` |
| `describe("G", () => { it("c", () => {...}) })` | `test('G > c', t => {...})` — flatten, ava has no nesting |
| `it("c", async () => {...})` | `test('c', async t => {...})` |
| `expect(a).toBe(b)` | `t.is(a, b)` |
| `expect(a).toEqual(b)` | `t.deepEqual(a, b)` |
| `expect(a).toMatchObject(b)` | `t.like(a, b)` |
| `expect(s).toContain(x)` | `t.true(s.includes(x))` |
| `expect(a).toHaveLength(n)` | `t.is(a.length, n)` |
| `expect(a).toBeUndefined()` | `t.is(a, undefined)` |
| `expect(a).toBeDefined()` | `t.not(a, undefined)` |
| `expect(a).toBeNull()` | `t.is(a, null)` |
| `expect(a).toBeTruthy()` | `t.truthy(a)` |
| `expect(s).toMatch(/re/)` | `t.regex(s, /re/)` |
| `expect(o).toHaveProperty("k")` | `t.true('k' in o)` |
| `expect(o).toHaveProperty("k", v)` | `t.is(o.k, v)` |
| `expect(a).toBeGreaterThan(n)` | `t.true(a > n)` |
| `expect(a).toBeLessThan(n)` | `t.true(a < n)` |
| `expect(a).toBeLessThanOrEqual(n)` | `t.true(a <= n)` |
| `expect(a).toBeInstanceOf(C)` | `t.true(a instanceof C)` |
| `expect(fn).toThrow()` | `t.throws(fn)` |
| `beforeEach(fn)` | `test.beforeEach(fn)` |
| `afterEach(fn)` | `test.afterEach(fn)` |
| `vi.fn(impl)` | `spy(impl)` from `./helpers/spy.js` |
| `vi.restoreAllMocks()` | manual restore in `test.afterEach` |

**Titles must be unique within a file** — ava rejects duplicates. Flattening `describe` into a `"Group > case"` prefix guarantees that.

- [ ] **Step 2: Handle `test.serial` where a file shares mutable module state**

Ava runs tests **within a file** concurrently; vitest with `pool: "forks"` does not. Any file where a `test.beforeEach` mutates module-level state must use `test.serial(...)` for every test in it.

Audit for this:

```bash
grep -ln 'beforeEach' src/tests/*.js src/tests/oauth/*.js
```

For each hit, read what `beforeEach` touches. If it mutates anything outside the callback's own closure, convert all `test(` in that file to `test.serial(`.

- [ ] **Step 3: Handle the three `process.env` files**

`stats.route.test.js`, `stats.route.disabled.test.js`, `analysisToolGating.test.js` set env vars **before importing** `constants.js` (which reads them at module scope).

With `workerThreads: false` each file gets its own process, so the pattern survives. But the import must stay dynamic and after the mutation:

```js
import test from 'ava'

process.env.STATS_TOKEN = 'contract-token'
const { statsRouter } = await import('../routes/stats.js')

test('serves stats with the token', async t => { /* ... */ })
```

Top-level `await import()` is legal in ESM. Verify each of the three still asserts what it asserted under vitest.

- [ ] **Step 4: Convert the files in five batches, running after each**

```bash
npx ava src/tests/eligibility.test.js src/tests/eligibilityFit.test.js --verbose
npx ava src/tests/analysisFit.test.js src/tests/analysisToolGating.test.js --verbose
npx ava src/tests/listEnvelope.test.js src/tests/fitEntity.test.js src/tests/zoneInventory.test.js --verbose
npx ava src/tests/report*.test.js src/tests/filterReportRows.test.js --verbose
npx ava src/tests/oauth/*.test.js src/tests/auth.test.js src/tests/tokenExpiry.test.js src/tests/selectNetworks.test.js src/tests/toolGuard.test.js src/tests/usageAnalytics.test.js --verbose
```

Expected after each batch: every test in that batch passes, and the assertion **count** matches what vitest reported for those files. Compare against `npx vitest run <same files> --reporter=verbose` before converting each batch — this is how you catch an assertion silently dropped in translation.

- [ ] **Step 5: Commit per batch**

```bash
git add src/tests/
git commit -m "test(ava): convert pure-unit suites (batch N)"
```

---

### Task 11: Convert the supertest files

`smoke`, `stats.route`, `stats.route.disabled`, `oauth/register`, `oauth/token`, and the Phase 0 contract suite. Supertest accepts any `(req, res)` listener, so it works identically under ava.

**Files:**
- Modify: `src/tests/smoke.test.js`, `src/tests/stats.route.test.js`, `src/tests/stats.route.disabled.test.js`, `src/tests/oauth/register.test.js`, `src/tests/oauth/token.test.js`, `src/tests/contract/http.test.js`

- [ ] **Step 1: Convert, applying the Task 10 table plus this**

Supertest's own chaining (`.expect(200)`) throws on mismatch, which ava reports as an unhandled rejection rather than a clean failure. Prefer asserting on the response object:

```js
// before (vitest)
const r = await request(app).get('/health')
expect(r.status).toBe(200)

// after (ava)
const r = await request(app).get('/health')
t.is(r.status, 200)
```

Do **not** use `.expect(200)` chaining.

- [ ] **Step 2: The contract suite's `describe` blocks flatten to prefixes**

```js
// before
describe("contract: /health", () => {
  it("200 with status ok", async () => {...})
})

// after
test('contract: /health > 200 with status ok', async t => {...})
```

The **assertions inside must not change**. That is the whole point of the harness.

- [ ] **Step 3: Run**

```bash
npx ava src/tests/smoke.test.js src/tests/stats.route*.test.js src/tests/oauth/register.test.js src/tests/oauth/token.test.js src/tests/contract/http.test.js --verbose
```

Expected: identical pass count to the vitest run of the same files.

- [ ] **Step 4: Commit**

```bash
git add src/tests/
git commit -m "test(ava): convert supertest suites including the contract harness"
```

---

### Task 12: Convert the mocked test files to esmock

Four files use `mockWorkApi`: `reportQuery.structured`, `resources`, `getEntityWithIncludes`, and the helper itself.

The helper keeps a **module-global mutable `handlers` array**. Under vitest's forked pool that is safe; under ava's in-file concurrency it is a race. Rather than papering over it with `test.serial`, delete the registry — pass the handler map into each `esmock()` call so every test gets a fresh module graph. Less code, and actually correct.

**Files:**
- Rewrite: `src/tests/helpers/mockWorkApi.js`
- Modify: `src/tests/reportQuery.structured.test.js`, `src/tests/resources.test.js`, `src/tests/getEntityWithIncludes.test.js`

**Interfaces:**
- Produces: `workApiMock(routes)` where `routes` is `Array<[method, pathRegex, handler]>`, returning the mock module object to hand to `esmock`'s 2nd argument; and `sessionMock()` returning the sessionManager stub.

- [ ] **Step 1: Rewrite the helper**

`src/tests/helpers/mockWorkApi.js`:

```js
/**
 * esmock mock factories for the Work API and session layers.
 *
 * No module-global state: each call builds a fresh mock, so ava's in-file
 * concurrency is safe. Pass the results as esmock's child-mock argument.
 *
 *   import esmock from 'esmock'
 *   import { workApiMock, sessionMock } from './helpers/mockWorkApi.js'
 *
 *   const mod = await esmock('../tools/templateTools.js', {
 *     '../services/workApi.js': workApiMock([
 *       ['GET', /\/templates\/123$/, () => ({ id: '123', name: 'My Template' })]
 *     ]),
 *     '../services/sessionManager.js': sessionMock()
 *   })
 */

export function workApiMock (routes = []) {
  return {
    workApiRequest: async (_session, method, path, opts) => {
      const match = routes.find(([m, re]) => m === method && re.test(path))
      if (!match) throw new Error(`workApiMock: unmatched ${method} ${path}`)
      return match[2](opts?.params)
    },
    handleWorkApiError: (err) => `Error: ${err.message}`,
    truncateIfNeeded: (s) => s,
    stripListItems: (d) => d
  }
}

export function sessionMock (overrides = {}) {
  return {
    resolveLincxSession: async () => 'test-session',
    validateSession: async () => ({ valid: true, session: { token: 't' } }),
    ...overrides
  }
}
```

- [ ] **Step 2: Convert `getEntityWithIncludes.test.js` first (43 lines, smallest)**

```js
import test from 'ava'
import esmock from 'esmock'
import { workApiMock, sessionMock } from './helpers/mockWorkApi.js'

test('getEntityWithIncludes > returns the entity without parents', async t => {
  const { getEntityWithIncludes } = await esmock('../tools/_shared.js', {
    '../services/workApi.js': workApiMock([
      ['GET', /\/zones\/z1$/, () => ({ id: 'z1', name: 'Zone One' })]
    ]),
    '../services/sessionManager.js': sessionMock()
  })
  const out = await getEntityWithIncludes(/* ...same args as before... */)
  t.is(out.id, 'z1')
})
```

**The `esmock` mock keys are the specifiers as written in the TARGET module**, not paths relative to the test file. `src/tools/_shared.js` imports `"../services/workApi.js"`, so that exact string is the key.

- [ ] **Step 3: Run it**

Run: `npx ava src/tests/getEntityWithIncludes.test.js --verbose`
Expected: pass. If it fails with "unmatched GET ...", the target module's import specifier does not match the key — check with `grep -n 'import' src/tools/_shared.js`.

- [ ] **Step 4: Convert `resources.test.js` and `reportQuery.structured.test.js`**

Same pattern. `resources.test.js` mocks against `src/tools/resources.js`; `reportQuery.structured.test.js` against `src/tools/reportingTools.js`. Confirm each target's specifiers:

```bash
grep -n '^import' src/tools/resources.js src/tools/reportingTools.js
```

- [ ] **Step 5: Run all three**

```bash
npx ava src/tests/getEntityWithIncludes.test.js src/tests/resources.test.js src/tests/reportQuery.structured.test.js --verbose
```

Expected: assertion counts match the vitest baseline for these three files.

- [ ] **Step 6: Commit**

```bash
git add src/tests/
git commit -m "test(ava): replace vi.mock with esmock; drop the shared handler registry"
```

---

### Task 13: Convert `oauth/flow.test.js` — the transitive-mock case

This file is **not** mechanical and gets its own task. It mocks `services/auth.js` and `services/networkService.js`, then imports `routes/login.js` — which reaches `networkService` **transitively** through `sessionManager.js`. esmock's 2nd argument only replaces the target's *direct* imports; transitive replacement needs the **3rd** argument.

**Files:**
- Modify: `src/tests/oauth/flow.test.js`

- [ ] **Step 1: Confirm the transitive path**

```bash
grep -n 'networkService\|auth\.js' src/routes/login.js src/services/sessionManager.js
```

Expected: `routes/login.js` imports `services/auth.js` directly, and `services/sessionManager.js` imports `services/networkService.js`. That confirms `auth` is a direct mock (2nd arg) and `networkService` is transitive (3rd arg).

- [ ] **Step 2: Rewrite the file's setup**

```js
import test from 'ava'
import request from 'supertest'
import { createHash, randomBytes } from 'node:crypto'
import http from 'node:http'
import esmock from 'esmock'
import { buildContractApp } from '../contract/buildApp.js'

const authMock = {
  loginWithCredentials: async (email) => ({ authToken: `jwt-for-${email}` }),
  revokeToken: async () => {}
}

const networkMock = {
  fetchUserNetworks: async () => [{
    id: 'svce6t',
    name: 'Test Net',
    owner: 'u',
    members: [],
    observers: [],
    dateCreated: '',
    dateUpdated: '',
    userUpdated: '',
    customDimensions: []
  }]
}

// 2nd arg: direct imports of routes/login.js
// 3rd arg: whole-import-tree — reaches networkService through sessionManager
const { loginRouter } = await esmock(
  '../../routes/login.js',
  { '../../services/auth.js': authMock },
  { '../../services/networkService.js': networkMock }
)

const { resolveLincxSessionFromBearer } = await esmock(
  '../../services/sessionManager.js',
  {},
  { '../../services/networkService.js': networkMock }
)

function challenge (verifier) {
  return createHash('sha256').update(verifier).digest('base64url')
}
```

- [ ] **Step 3: Keep the app assembly, swapping in the mocked router**

The file builds its own express app. Leave it on express for now (Phase 3 replaces it) but take `loginRouter` from the esmock result rather than a static import.

- [ ] **Step 4: Convert the assertions and run**

Run: `npx ava src/tests/oauth/flow.test.js --verbose`
Expected: the full authorize → login → code → token → refresh chain passes, same as under vitest.

If `fetchUserNetworks` still hits the network, the 3rd argument is not reaching it — verify the specifier string matches exactly what `sessionManager.js` writes (`grep -n networkService src/services/sessionManager.js`).

- [ ] **Step 5: Add the refresh-rotation assertion that was missing**

```js
test.serial('OAuth end-to-end > refresh rotates and invalidates the old token', async t => {
  // ... obtain tokens via the full flow ...
  const first = await request(app).post('/oauth/token')
    .send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id })
  t.is(first.status, 200)
  t.not(first.body.refresh_token, tokens.refresh_token)

  // the ORIGINAL refresh token must now be dead
  const replay = await request(app).post('/oauth/token')
    .send({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id })
  t.is(replay.status, 400)
  t.is(replay.body.error, 'invalid_grant')
})
```

- [ ] **Step 6: Commit**

```bash
git add src/tests/oauth/flow.test.js
git commit -m "test(ava): convert the OAuth end-to-end flow with transitive esmock; pin refresh rotation"
```

---

### Task 14: Remove vitest

**Files:**
- Delete: `vitest.config.js`
- Modify: `package.json`

- [ ] **Step 1: Confirm nothing still imports vitest**

```bash
grep -rn 'vitest' src/ package.json
```

Expected: only the `package.json` devDependency and the `test` script.

- [ ] **Step 2: Swap the runner**

```bash
npm rm vitest @vitest/coverage-v8
rm vitest.config.js
```

`package.json` scripts:

```json
"test": "ava",
"test:watch": "ava --watch"
```

- [ ] **Step 3: Full run**

Run: `npm test`
Expected: every test file passes. Record the total assertion count.

- [ ] **Step 4: Compare against the pre-migration baseline**

```bash
git stash list   # confirm nothing pending
npm test 2>&1 | tail -5
```

The count must be **≥** the vitest baseline (Task 13 added assertions). If it is lower, a test was silently dropped in conversion — find it with:

```bash
for f in src/tests/**/*.test.js; do echo -n "$f: "; grep -c '^test\|^test\.serial' "$f"; done
```

against the same count of `it(` in the pre-Phase-2 commit.

- [ ] **Step 5: Commit — Phase 2 complete**

```bash
git add -A
git commit -m "test: drop vitest — ava is the runner"
```

**PHASE 2 GATE:** `npm test` green under ava with an assertion count ≥ the vitest baseline. Contract suite assertions unchanged from Phase 0. Source code untouched since Phase 1.

---

# PHASE 3 — express → http-hash-router

Tests do not change except `buildApp.js` (one file, by design). The contract suite is the acceptance criterion.

`http-hash-router@2.0.1` API, confirmed from source:
- `HttpHashRouter()` returns `router(req, res, opts, cb)` and `router.set(path, handler)`
- `handler` is `(req, res, opts, cb)`; `opts.params` holds `:name` captures, `opts.splat` holds `*`
- `router.set(path, { GET: fn, POST: fn })` dispatches by method via `http-methods` and returns **405** for unlisted methods
- Unmatched pathname → `cb(NotFoundError)` where `err.statusCode === 404`
- **Only `url.parse(req.url).pathname` is matched.** Query strings, body parsing, and middleware chains do not exist — every one is replaced below.

---

### Task 15: Response helpers

**Files:**
- Create: `src/http/respond.js`
- Create: `src/tests/http/respond.test.js`

**Interfaces:**
- Produces: `json(res, status, body)`, `send(res, status, body, contentType)`, `html(res, status, body)`, `redirect(res, location)`, `noContent(res, status)` — all return `undefined`, all write and end the response.

- [ ] **Step 1: Write the failing test**

`src/tests/http/respond.test.js`:

```js
import test from 'ava'
import http from 'node:http'
import request from 'supertest'
import { json, html, redirect, noContent } from '../../http/respond.js'

function serve (handler) {
  return http.createServer(handler)
}

test('json > writes status, content-type and body', async t => {
  const r = await request(serve((_req, res) => json(res, 201, { ok: true }))).get('/')
  t.is(r.status, 201)
  t.regex(r.headers['content-type'], /application\/json/)
  t.deepEqual(r.body, { ok: true })
})

test('json > defaults to 200', async t => {
  const r = await request(serve((_req, res) => json(res, 200, { a: 1 }))).get('/')
  t.is(r.status, 200)
})

test('html > sets text/html', async t => {
  const r = await request(serve((_req, res) => html(res, 400, '<p>bad</p>'))).get('/')
  t.is(r.status, 400)
  t.regex(r.headers['content-type'], /text\/html/)
  t.is(r.text, '<p>bad</p>')
})

test('redirect > 302 with Location', async t => {
  const r = await request(serve((_req, res) => redirect(res, '/login?req=abc'))).get('/')
  t.is(r.status, 302)
  t.is(r.headers.location, '/login?req=abc')
})

test('noContent > status with an empty body', async t => {
  const r = await request(serve((_req, res) => noContent(res, 404))).get('/')
  t.is(r.status, 404)
  t.is(r.text, '')
})

test('json > does not double-write when headers are already sent', async t => {
  const r = await request(serve((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.write('partial')
    json(res, 500, { error: 'late' })   // must be a no-op that still ends
    res.end()
  })).get('/')
  t.is(r.status, 200)
  t.is(r.text, 'partial')
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx ava src/tests/http/respond.test.js`
Expected: FAIL — `Cannot find module '../../http/respond.js'`

- [ ] **Step 3: Implement**

`src/http/respond.js`:

```js
/**
 * http/respond.js — the Express `res.json` / `res.send` / `res.redirect`
 * replacements, over a bare Node ServerResponse.
 *
 * All logging in this project goes to stderr (console.error); these helpers do
 * not log at all.
 */

export function send (res, status, body, contentType) {
  if (res.headersSent) return
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : String(body ?? '')
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

export function json (res, status, body) {
  send(res, status, JSON.stringify(body), 'application/json; charset=utf-8')
}

export function html (res, status, body) {
  send(res, status, body, 'text/html; charset=utf-8')
}

export function redirect (res, location, status = 302) {
  if (res.headersSent) return
  res.writeHead(status, { Location: location, 'Content-Length': 0 })
  res.end()
}

export function noContent (res, status) {
  if (res.headersSent) return
  res.writeHead(status, { 'Content-Length': 0 })
  res.end()
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx ava src/tests/http/respond.test.js --verbose`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add src/http/respond.js src/tests/http/respond.test.js
git commit -m "feat(http): response helpers replacing express res.json/send/redirect"
```

---

### Task 16: Request helpers — query, headers, client IP, body

The riskiest file in Phase 3. `readBody` re-implements `express.json()` + `express.urlencoded()` including their **100kb limit** and their **400 on malformed JSON** — both pinned by the contract suite.

**Files:**
- Create: `src/http/request.js`
- Create: `src/tests/http/request.test.js`

**Interfaces:**
- Produces:
  - `query(req)` → `URLSearchParams`
  - `header(req, name)` → `string | undefined`
  - `clientIp(req)` → `string`
  - `readBody(req)` → `Promise<object>`; throws `BodyError` with `.statusCode` 400 (malformed) or 413 (too large)

- [ ] **Step 1: Write the failing test**

`src/tests/http/request.test.js`:

```js
import test from 'ava'
import http from 'node:http'
import request from 'supertest'
import { query, header, clientIp, readBody } from '../../http/request.js'

function serve (handler) { return http.createServer(handler) }

test('query > parses the search string', async t => {
  const app = serve((req, res) => {
    const q = query(req)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ req: q.get('req'), missing: q.get('nope') }))
  })
  const r = await request(app).get('/login?req=abc123&x=1')
  t.is(r.body.req, 'abc123')
  t.is(r.body.missing, null)
})

test('query > empty when there is no search string', async t => {
  const app = serve((req, res) => {
    res.writeHead(200).end(String(query(req).get('a')))
  })
  const r = await request(app).get('/login')
  t.is(r.text, 'null')
})

test('header > is case-insensitive and returns undefined when absent', async t => {
  const app = serve((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      auth: header(req, 'Authorization') ?? null,
      sid: header(req, 'MCP-Session-Id') ?? null,
      none: header(req, 'x-nope') ?? null
    }))
  })
  const r = await request(app).get('/').set('authorization', 'Bearer x').set('mcp-session-id', 's1')
  t.is(r.body.auth, 'Bearer x')
  t.is(r.body.sid, 's1')
  t.is(r.body.none, null)
})

test('clientIp > takes the trusted hop from X-Forwarded-For', async t => {
  const app = serve((req, res) => res.writeHead(200).end(clientIp(req)))
  const r = await request(app).get('/').set('X-Forwarded-For', '203.0.113.7, 10.0.0.1')
  // With exactly one trusted proxy hop, the client is the LAST entry.
  // Task 3's spike measured the real GAE shape — this index must match its finding.
  t.is(r.text, '10.0.0.1')
})

test('clientIp > falls back to the socket address with no XFF', async t => {
  const app = serve((req, res) => res.writeHead(200).end(clientIp(req)))
  const r = await request(app).get('/')
  t.true(r.text.length > 0)
})

test('readBody > parses application/json', async t => {
  const app = serve(async (req, res) => {
    const body = await readBody(req)
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  })
  const r = await request(app).post('/').send({ a: 1, b: 'x' })
  t.deepEqual(r.body, { a: 1, b: 'x' })
})

test('readBody > parses application/x-www-form-urlencoded', async t => {
  const app = serve(async (req, res) => {
    const body = await readBody(req)
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  })
  const r = await request(app).post('/').type('form').send({ grant_type: 'refresh_token', client_id: 'c' })
  t.deepEqual(r.body, { grant_type: 'refresh_token', client_id: 'c' })
})

test('readBody > returns {} for an empty body', async t => {
  const app = serve(async (req, res) => {
    const body = await readBody(req)
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  })
  const r = await request(app).post('/').set('Content-Type', 'application/json').send('')
  t.deepEqual(r.body, {})
})

test('readBody > throws 400 on malformed JSON', async t => {
  const app = serve(async (req, res) => {
    try {
      await readBody(req)
      res.writeHead(200).end('unreachable')
    } catch (err) {
      res.writeHead(err.statusCode ?? 500).end(String(err.statusCode))
    }
  })
  const r = await request(app).post('/').set('Content-Type', 'application/json').send('{not json')
  t.is(r.status, 400)
})

test('readBody > throws 413 above the 100kb limit', async t => {
  const app = serve(async (req, res) => {
    try {
      await readBody(req)
      res.writeHead(200).end('unreachable')
    } catch (err) {
      res.writeHead(err.statusCode ?? 500).end(String(err.statusCode))
    }
  })
  const big = JSON.stringify({ x: 'y'.repeat(200_000) })
  const r = await request(app).post('/').set('Content-Type', 'application/json').send(big)
  t.is(r.status, 413)
})

test('readBody > stops reading once the limit is exceeded', async t => {
  // The limit must be enforced while streaming, not after buffering 200MB.
  const app = serve(async (req, res) => {
    try {
      await readBody(req)
      res.writeHead(200).end('unreachable')
    } catch (err) {
      t.is(err.statusCode, 413)
      res.writeHead(413).end('413')
    }
  })
  const r = await request(app).post('/')
    .set('Content-Type', 'application/json')
    .send('x'.repeat(500_000))
  t.is(r.status, 413)
})

test('readBody > treats an unknown content-type as empty', async t => {
  const app = serve(async (req, res) => {
    const body = await readBody(req)
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  })
  const r = await request(app).post('/').set('Content-Type', 'text/plain').send('hello')
  t.deepEqual(r.body, {})
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx ava src/tests/http/request.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`src/http/request.js`:

```js
/**
 * http/request.js — the Express `req.query` / `req.header` / `req.ip` /
 * `express.json()` replacements, over a bare Node IncomingMessage.
 *
 * BODY SIZE LIMIT is a trust boundary, not a nicety: without it an unauthenticated
 * POST can buffer unbounded memory into a single-instance process. Enforced while
 * streaming, matching express.json()'s 100kb default (pinned by the contract suite).
 */

const MAX_BODY_BYTES = 100 * 1024

// Number of reverse-proxy hops we trust. Express's `trust proxy: 1` meant exactly
// one hop; the client is then the LAST entry of X-Forwarded-For. Task 3's GAE
// spike measured the real header shape — if it showed more hops, change this and
// the corresponding test together, never one alone.
const TRUSTED_HOPS = 1

export class BodyError extends Error {
  constructor (message, statusCode) {
    super(message)
    this.name = 'BodyError'
    this.statusCode = statusCode
  }
}

export function query (req) {
  return new URL(req.url, 'http://localhost').searchParams
}

export function header (req, name) {
  const v = req.headers[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}

export function clientIp (req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.length > 0) {
    const hops = xff.split(',').map((s) => s.trim()).filter(Boolean)
    const idx = hops.length - TRUSTED_HOPS
    if (idx >= 0 && hops[idx]) return hops[idx]
  }
  return req.socket?.remoteAddress ?? 'unknown'
}

export async function readBody (req) {
  const type = (req.headers['content-type'] ?? '').split(';')[0].trim()
  if (type !== 'application/json' && type !== 'application/x-www-form-urlencoded') {
    return {}
  }

  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      req.destroy()
      throw new BodyError('request entity too large', 413)
    }
    chunks.push(chunk)
  }

  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.length === 0) return {}

  if (type === 'application/json') {
    try {
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      throw new BodyError('invalid JSON body', 400)
    }
  }

  return Object.fromEntries(new URLSearchParams(raw))
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx ava src/tests/http/request.test.js --verbose`
Expected: 12 passing.

- [ ] **Step 5: Reconcile `clientIp` with the spike**

Open `docs/superpowers/plans/phase0-findings.md` and read the measured `xff_split` array. If GAE presents a different hop count than one, change `TRUSTED_HOPS` **and** the `clientIp` test's expected value in the same commit, with a comment citing the finding.

- [ ] **Step 6: Commit**

```bash
git add src/http/request.js src/tests/http/request.test.js
git commit -m "feat(http): request helpers — query, headers, client IP, size-limited body"
```

---

### Task 17: Hand-rolled rate limiter

Replaces `express-rate-limit`. Fixed window over a `Map`, keyed the same way the Express version was: per-IP for login, per-`mcp-session-id` (IP fallback) for `/mcp`.

**Files:**
- Rewrite: `src/middleware/rateLimit.js`
- Create: `src/tests/rateLimit.test.js`

**Interfaces:**
- Produces: `createLimiter({ windowMs, limit, keyOf, message })` → `limiter(req, res)` returning `true` when the request may proceed, `false` when it has already written a 429. Also exports `loginLimiter` and `mcpLimiter` pre-configured.

- [ ] **Step 1: Write the failing test**

`src/tests/rateLimit.test.js`:

```js
import test from 'ava'
import http from 'node:http'
import request from 'supertest'
import { createLimiter } from '../middleware/rateLimit.js'

function serve (limiter) {
  return http.createServer((req, res) => {
    if (!limiter(req, res)) return
    res.writeHead(200).end('ok')
  })
}

test.serial('allows requests under the limit', async t => {
  const limiter = createLimiter({ windowMs: 60_000, limit: 3, keyOf: () => 'k1' })
  const app = serve(limiter)
  for (let i = 0; i < 3; i++) {
    const r = await request(app).get('/')
    t.is(r.status, 200)
  }
})

test.serial('429s past the limit with a JSON message', async t => {
  const limiter = createLimiter({ windowMs: 60_000, limit: 2, keyOf: () => 'k2', message: { error: 'slow down' } })
  const app = serve(limiter)
  await request(app).get('/')
  await request(app).get('/')
  const r = await request(app).get('/')
  t.is(r.status, 429)
  t.is(r.body.error, 'slow down')
})

test.serial('sets draft-7 RateLimit headers', async t => {
  const limiter = createLimiter({ windowMs: 60_000, limit: 5, keyOf: () => 'k3' })
  const r = await request(serve(limiter)).get('/')
  t.is(r.headers['ratelimit-limit'], '5')
  t.is(r.headers['ratelimit-remaining'], '4')
  t.truthy(r.headers['ratelimit-reset'])
})

test.serial('sets Retry-After on a 429', async t => {
  const limiter = createLimiter({ windowMs: 60_000, limit: 1, keyOf: () => 'k4' })
  const app = serve(limiter)
  await request(app).get('/')
  const r = await request(app).get('/')
  t.is(r.status, 429)
  t.truthy(r.headers['retry-after'])
})

test.serial('counts keys independently', async t => {
  let n = 0
  const limiter = createLimiter({ windowMs: 60_000, limit: 1, keyOf: () => `key-${n}` })
  const app = serve(limiter)
  n = 1; t.is((await request(app).get('/')).status, 200)
  n = 2; t.is((await request(app).get('/')).status, 200)
  n = 1; t.is((await request(app).get('/')).status, 429)
})

test.serial('resets after the window elapses', async t => {
  const limiter = createLimiter({ windowMs: 30, limit: 1, keyOf: () => 'k6' })
  const app = serve(limiter)
  t.is((await request(app).get('/')).status, 200)
  t.is((await request(app).get('/')).status, 429)
  await new Promise((r) => setTimeout(r, 45))
  t.is((await request(app).get('/')).status, 200)
})

test.serial('evicts expired keys so the Map cannot grow unbounded', async t => {
  const limiter = createLimiter({ windowMs: 20, limit: 100, keyOf: (req) => req.headers['x-key'] })
  const app = serve(limiter)
  for (let i = 0; i < 50; i++) await request(app).get('/').set('x-key', `k${i}`)
  await new Promise((r) => setTimeout(r, 40))
  await request(app).get('/').set('x-key', 'trigger-sweep')
  t.true(limiter.size() <= 1, `expected the window sweep to evict; size=${limiter.size()}`)
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx ava src/tests/rateLimit.test.js`
Expected: FAIL — `createLimiter is not a function`.

- [ ] **Step 3: Implement**

`src/middleware/rateLimit.js`:

```js
/**
 * middleware/rateLimit.js — fixed-window rate limiting over an in-process Map.
 *
 * Replaces express-rate-limit. Single-instance-only deployment (see CLAUDE.md),
 * so an in-process counter is the correct scope — a Redis-backed limiter would
 * add a network hop for no gain.
 *
 * Two configs, unchanged from the Express version:
 *   loginLimiter — POST /api/login — 10 req/min per client IP
 *   mcpLimiter   — POST /mcp       — 120 req/min per mcp-session-id (IP fallback)
 *
 * ponytail: fixed window, not sliding — a burst can straddle a boundary and
 * briefly allow 2x. Acceptable for abuse damping. Move to a sliding log if the
 * limit ever becomes a correctness boundary rather than a courtesy one.
 */

import { json } from '../http/respond.js'
import { header, clientIp } from '../http/request.js'

export function createLimiter ({ windowMs, limit, keyOf, message }) {
  const hits = new Map() // key -> { count, resetAt }

  function sweep (now) {
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k)
  }

  function limiter (req, res) {
    const now = Date.now()
    sweep(now)

    const key = keyOf(req) ?? 'unknown'
    let entry = hits.get(key)
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs }
      hits.set(key, entry)
    }
    entry.count += 1

    const resetSeconds = Math.max(0, Math.ceil((entry.resetAt - now) / 1000))
    const remaining = Math.max(0, limit - entry.count)

    res.setHeader('RateLimit-Limit', String(limit))
    res.setHeader('RateLimit-Remaining', String(remaining))
    res.setHeader('RateLimit-Reset', String(resetSeconds))

    if (entry.count > limit) {
      res.setHeader('Retry-After', String(resetSeconds))
      json(res, 429, message ?? { error: 'Too many requests.' })
      return false
    }
    return true
  }

  limiter.size = () => hits.size
  return limiter
}

export const loginLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 10,
  keyOf: (req) => clientIp(req),
  message: { error: 'Too many login attempts — try again in a minute.' }
})

export const mcpLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 120,
  keyOf: (req) => header(req, 'mcp-session-id') ?? clientIp(req),
  message: { error: 'Rate limit exceeded for this MCP session.' }
})
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx ava src/tests/rateLimit.test.js --verbose`
Expected: 7 passing.

- [ ] **Step 5: Drop the dependency**

```bash
npm rm express-rate-limit
```

- [ ] **Step 6: Commit**

```bash
git add src/middleware/rateLimit.js src/tests/rateLimit.test.js package.json package-lock.json
git commit -m "feat(http): hand-rolled fixed-window rate limiter; drop express-rate-limit"
```

---

### Task 18: Port the five route modules

Each Express `Router` becomes a plain object of `(req, res, opts, cb)` handlers. No behaviour change — the contract suite is the judge.

**Files:**
- Rewrite: `src/routes/wellKnown.js`, `src/routes/oauthRegister.js`, `src/routes/oauthToken.js`, `src/routes/stats.js`, `src/routes/login.js`

**Interfaces:**
- Produces, from each module, named handler functions with signature `(req, res, opts, cb)`:
  - `wellKnown.js` → `authServerMetadata`, `resourceMetadata`
  - `oauthRegister.js` → `postRegister`
  - `oauthToken.js` → `postToken`
  - `stats.js` → `getStats`
  - `login.js` → `getAuthorize`, `getLogin`, `postApiLogin`, `getLoginSuccess`
- Consumes: `json`/`html`/`redirect`/`noContent` (Task 15), `query`/`header`/`readBody`/`BodyError` (Task 16), `loginLimiter` (Task 17).

- [ ] **Step 1: Port `wellKnown.js`**

```js
import { buildAuthServerMetadata, buildResourceMetadata } from '../services/oauth/metadata.js'
import { PUBLIC_BASE_URL } from '../constants.js'
import { json } from '../http/respond.js'

export function authServerMetadata (_req, res) {
  json(res, 200, buildAuthServerMetadata(PUBLIC_BASE_URL))
}

// RFC 9728 §3.1: spec-conformant clients construct
// "<base>/.well-known/oauth-protected-resource/mcp". Both forms are registered
// in the route table (http-hash matches exact pathnames — no array paths).
export function resourceMetadata (_req, res) {
  json(res, 200, buildResourceMetadata(PUBLIC_BASE_URL))
}
```

- [ ] **Step 2: Port `oauthRegister.js`**

```js
import { registerClient } from '../services/oauth/clients.js'
import { json } from '../http/respond.js'
import { readBody } from '../http/request.js'

export async function postRegister (req, res, _opts, cb) {
  let body
  try {
    body = await readBody(req)
  } catch (err) {
    return cb(err)   // BodyError carries statusCode 400 or 413
  }

  const { redirect_uris: redirectUris, client_name: clientName } = body
  try {
    const client = await registerClient({ redirect_uris: redirectUris, client_name: clientName })
    json(res, 201, {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(client.created_at / 1000),
      redirect_uris: client.redirect_uris,
      client_name: client.client_name,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'registration_failed'
    console.error(`[OAuth] register failed: ${msg}`)
    json(res, 400, { error: 'invalid_redirect_uri', error_description: msg })
  }
}
```

- [ ] **Step 3: Port `oauthToken.js`**

Body-for-body identical logic; only the plumbing changes.

```js
import { consumeAuthCode } from '../services/oauth/codes.js'
import { issueTokens, refreshTokens } from '../services/oauth/tokens.js'
import { verifyPkce } from '../services/oauth/pkce.js'
import { getClient } from '../services/oauth/clients.js'
import { json } from '../http/respond.js'
import { readBody } from '../http/request.js'

export async function postToken (req, res, _opts, cb) {
  let body
  try {
    body = await readBody(req)
  } catch (err) {
    return cb(err)
  }

  const { grant_type: grantType } = body

  if (grantType === 'authorization_code') {
    const { code, redirect_uri: redirectUri, client_id: clientId, code_verifier: codeVerifier } = body

    if (!code || !redirectUri || !clientId || !codeVerifier) {
      return json(res, 400, { error: 'invalid_request' })
    }
    const client = await getClient(clientId)
    if (!client) return json(res, 400, { error: 'invalid_client' })

    const authCode = await consumeAuthCode(code)
    if (!authCode) return json(res, 400, { error: 'invalid_grant' })
    if (authCode.client_id !== clientId) return json(res, 400, { error: 'invalid_grant' })
    if (authCode.redirect_uri !== redirectUri) return json(res, 400, { error: 'invalid_grant' })
    if (!verifyPkce(codeVerifier, authCode.code_challenge, 'S256')) {
      return json(res, 400, { error: 'invalid_grant' })
    }

    const tokens = await issueTokens({ client_id: clientId, lincx_session_id: authCode.lincx_session_id })
    return json(res, 200, tokens)
  }

  if (grantType === 'refresh_token') {
    const { refresh_token: refreshToken, client_id: clientId } = body
    if (!refreshToken || !clientId) return json(res, 400, { error: 'invalid_request' })
    const tokens = await refreshTokens(refreshToken, clientId)
    if (!tokens) return json(res, 400, { error: 'invalid_grant' })
    return json(res, 200, tokens)
  }

  json(res, 400, { error: 'unsupported_grant_type' })
}
```

- [ ] **Step 4: Port `stats.js`**

Keep the file header comment verbatim — it documents the `?token=` leak risk.

```js
import { STATS_TOKEN, USAGE_EVENT_CAP } from '../constants.js'
import { getEventSink, computeStats } from '../services/usageAnalytics.js'
import { json, noContent } from '../http/respond.js'
import { query, header } from '../http/request.js'

export async function getStats (req, res) {
  if (!STATS_TOKEN) return noContent(res, 404)

  const q = query(req)
  const presented = header(req, 'authorization') === `Bearer ${STATS_TOKEN}` ||
    q.get('token') === STATS_TOKEN
  if (!presented) return json(res, 401, { error: 'unauthorized' })

  const parsed = parseInt(q.get('limit') ?? '', 10)
  const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, USAGE_EVENT_CAP) : USAGE_EVENT_CAP
  try {
    const events = await (await getEventSink()).readRecent(limit)
    json(res, 200, computeStats(events))
  } catch (err) {
    console.error('[Stats] read failed:', err instanceof Error ? err.message : String(err))
    json(res, 200, computeStats([])) // degrade to empty, never 500
  }
}
```

- [ ] **Step 5: Port `login.js`**

```js
import { randomBytes } from 'node:crypto'
import { loginWithCredentials } from '../services/auth.js'
import { createSession } from '../services/sessionManager.js'
import {
  storePendingAuthRequest,
  consumePendingAuthRequest,
  peekPendingAuthRequest,
  issueAuthCode
} from '../services/oauth/codes.js'
import { getClient } from '../services/oauth/clients.js'
import { loginLimiter } from '../middleware/rateLimit.js'
import { buildLoginPage, buildSuccessPage, buildErrorPage } from '../views/login.js'
import { json, html, redirect } from '../http/respond.js'
import { query, readBody } from '../http/request.js'

export async function getAuthorize (req, res) {
  const q = query(req)
  const responseType = q.get('response_type')
  const clientId = q.get('client_id')
  const redirectUri = q.get('redirect_uri')
  const state = q.get('state')
  const codeChallenge = q.get('code_challenge')
  const codeChallengeMethod = q.get('code_challenge_method')
  const scope = q.get('scope')

  if (responseType !== 'code') return html(res, 400, buildErrorPage('Unsupported response_type.'))
  if (!clientId || !redirectUri || !state || !codeChallenge) {
    return html(res, 400, buildErrorPage('Missing required OAuth parameters.'))
  }
  if (codeChallengeMethod !== 'S256') {
    return html(res, 400, buildErrorPage('Only S256 code_challenge_method is supported.'))
  }

  const client = await getClient(clientId)
  if (!client) return html(res, 400, buildErrorPage('Unknown client_id.'))
  if (!client.redirect_uris.includes(redirectUri)) {
    return html(res, 400, buildErrorPage('redirect_uri does not match registered URIs.'))
  }

  const requestId = randomBytes(16).toString('hex')
  await storePendingAuthRequest({
    request_id: requestId,
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    scope: scope ?? 'mcp'
  })

  redirect(res, `/login?req=${requestId}`)
}

export async function getLogin (req, res) {
  const requestId = query(req).get('req') ?? ''
  if (!requestId) return html(res, 400, buildErrorPage('Missing auth request id.'))
  const pending = await peekPendingAuthRequest(requestId)
  if (!pending) return html(res, 400, buildErrorPage('This login link has expired.'))
  html(res, 200, buildLoginPage(requestId))
}

export async function postApiLogin (req, res, _opts, cb) {
  if (!loginLimiter(req, res)) return

  let body
  try {
    body = await readBody(req)
  } catch (err) {
    return cb(err)
  }

  const requestId = query(req).get('req') ?? ''
  const { email, password } = body

  if (!requestId) return json(res, 400, { success: false, error: 'Missing request id.' })
  if (!email || !password) {
    return json(res, 400, { success: false, error: 'Email and password required.' })
  }

  const pending = await consumePendingAuthRequest(requestId)
  if (!pending) {
    return json(res, 400, {
      success: false,
      error: 'Login link expired. Restart from your MCP client.'
    })
  }

  try {
    const { authToken } = await loginWithCredentials(email, password)
    const session = await createSession({ user_id: email, email, auth_token: authToken })
    const code = await issueAuthCode({
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      lincx_session_id: session.session_id
    })
    const url = new URL(pending.redirect_uri)
    url.searchParams.set('code', code)
    url.searchParams.set('state', pending.state)
    console.error(`[OAuth] auth_code issued for ${email} → client=${pending.client_id}`)
    json(res, 200, { success: true, redirect: url.toString() })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Login failed'
    console.error(`[OAuth] login failed for ${email}: ${msg}`)
    json(res, 401, { success: false, error: msg })
  }
}

export function getLoginSuccess (_req, res) {
  html(res, 200, buildSuccessPage())
}
```

- [ ] **Step 6: Do not run the contract suite yet**

It still imports `buildApp.js`, which still builds an Express app from the now-deleted routers. Task 19 wires the new handlers.

- [ ] **Step 7: Commit**

```bash
git add src/routes/
git commit -m "refactor(routes): express Routers become bare (req,res,opts,cb) handlers"
```

---

### Task 19: The router table and the server bootstrap

**Files:**
- Create: `src/http/router.js`
- Rewrite: `src/index.js`
- Rewrite: `src/tests/contract/buildApp.js`
- Delete: `src/tests/helpers/testApp.js`

**Interfaces:**
- Produces: `buildRouter({ transports, mcpHandlers })` → an `http-hash-router` instance; `onRouterError(err, req, res)` → writes 404/405/413/400/500.
- Consumes: every handler exported in Task 18, plus the `/mcp` handlers defined here.

- [ ] **Step 1: Write the router module**

`src/http/router.js`:

```js
/**
 * http/router.js — the whole URL surface in one table.
 *
 * http-hash-router matches ONLY url.pathname; query strings, bodies and
 * middleware chains are handled explicitly by the helpers in ./request.js.
 * A `{ GET, POST }` object dispatches by method and returns 405 for anything
 * unlisted (Express fell through to 404 — the contract suite pins which).
 */

import HttpHashRouter from 'http-hash-router'
import { json, noContent } from './respond.js'
import { authServerMetadata, resourceMetadata } from '../routes/wellKnown.js'
import { postRegister } from '../routes/oauthRegister.js'
import { postToken } from '../routes/oauthToken.js'
import { getStats } from '../routes/stats.js'
import { getAuthorize, getLogin, postApiLogin, getLoginSuccess } from '../routes/login.js'

export function buildRouter ({ health, mcp, dev }) {
  const router = HttpHashRouter()

  router.set('/health', { GET: health })

  // GAE manual/basic scaling sends these; a non-200 means the instance never
  // becomes healthy and the deploy silently fails.
  router.set('/_ah/start', { GET: (_req, res) => noContent(res, 200) })
  router.set('/_ah/stop', { GET: (_req, res) => noContent(res, 200) })
  router.set('/_ah/warmup', { GET: (_req, res) => noContent(res, 200) })

  router.set('/.well-known/oauth-authorization-server', { GET: authServerMetadata })
  router.set('/.well-known/oauth-protected-resource', { GET: resourceMetadata })
  router.set('/.well-known/oauth-protected-resource/mcp', { GET: resourceMetadata })

  router.set('/oauth/register', { POST: postRegister })
  router.set('/oauth/token', { POST: postToken })
  router.set('/oauth/authorize', { GET: getAuthorize })

  router.set('/login', { GET: getLogin })
  router.set('/login/success', { GET: getLoginSuccess })
  router.set('/api/login', { POST: postApiLogin })

  router.set('/stats', { GET: getStats })

  if (mcp) {
    router.set('/mcp', { POST: mcp.post, GET: mcp.get, DELETE: mcp.del })
  }

  if (dev) {
    router.set('/dev/tools', { GET: dev.list })
    router.set('/dev/tools/:name', { POST: dev.call })
  }

  return router
}

export function onRouterError (err, _req, res) {
  if (!err) return
  if (res.headersSent) return

  const status = err.statusCode ?? 500
  if (status === 404) return json(res, 404, { error: 'not_found' })
  if (status === 405) return json(res, 405, { error: 'method_not_allowed' })
  if (status === 413) return json(res, 413, { error: 'payload_too_large' })
  if (status === 400) return json(res, 400, { error: 'bad_request' })

  console.error('[HTTP]   unhandled route error:', err instanceof Error ? err.message : String(err))
  json(res, 500, { error: 'internal_server_error' })
}
```

- [ ] **Step 2: Rewrite the contract app builder — its assertions must not change**

`src/tests/contract/buildApp.js`:

```js
/**
 * Phase 3: same exported name, same contract, new plumbing. http.test.js is
 * unchanged — that is what makes the router swap verifiable.
 */
import http from 'node:http'
import { buildRouter, onRouterError } from '../../http/router.js'
import { json } from '../../http/respond.js'

export function buildContractApp () {
  const router = buildRouter({
    health: (_req, res) => json(res, 200, {
      status: 'ok',
      uptime_s: Math.round(process.uptime()),
      active_sessions: 0
    })
  })
  return http.createServer((req, res) => {
    router(req, res, {}, (err) => onRouterError(err, req, res))
  })
}
```

- [ ] **Step 3: Run the contract suite — this is the gate**

Run: `npx ava src/tests/contract/http.test.js --verbose`

Expected: **failures**, specifically on the `RECORD-THEN-PIN` cases where `http-methods` returns 405 where Express returned 404, and on trailing slashes.

For each failure, decide deliberately and write the decision into a comment:
- **Method mismatch (405 vs 404):** accept 405. It is more correct and no MCP client depends on 404. Update the contract assertion **and add a comment naming Phase 3 as the change point**.
- **Trailing slash (404 where Express served 200):** if any real client or the OAuth spec could hit the slashed form, register the extra path in `router.set`. `/.well-known/*` forms in particular — register both.
- **Anything else:** it is a regression. Fix the implementation, not the test.

- [ ] **Step 4: Delete the obsolete test helper**

```bash
rm src/tests/helpers/testApp.js
grep -rn 'testApp' src/tests/ || echo "no references"
```

- [ ] **Step 5: Rewrite `src/index.js`**

```js
/**
 * index.js — Lincx MCP Server entry point
 *
 * Two surfaces on one bare Node HTTP server:
 *  1. HTTP login UI (GET /login, POST /api/login, GET /login/success)
 *  2. MCP Streamable HTTP transport (POST|GET|DELETE /mcp)
 *
 * HTTP-only — MCP clients connect over /mcp. There is no stdio transport.
 */

import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

import { registerAuthTools } from './tools/authTools.js'
import { registerNetworkTools } from './tools/networkTools.js'
import { registerTemplateTools } from './tools/templateTools.js'
import { registerCreativeAssetGroupTools } from './tools/creativeAssetGroupTools.js'
import { registerZoneTools } from './tools/zoneTools.js'
import { registerAdTools } from './tools/adTools.js'
import { registerAdGroupTools } from './tools/adGroupTools.js'
import { registerCreativeTools } from './tools/creativeTools.js'
import { registerCampaignTools } from './tools/campaignTools.js'
import { registerChannelTools } from './tools/channelTools.js'
import { registerSiteTools } from './tools/siteTools.js'
import { registerPublisherTools } from './tools/publisherTools.js'
import { registerAdvertiserTools } from './tools/advertiserTools.js'
import { registerExperienceTools } from './tools/experienceTools.js'
import { registerReportingTools } from './tools/reportingTools.js'
import { registerZoneInventoryTools } from './tools/zoneInventoryTools.js'
import { registerZoneEligibilityTools } from './tools/zoneEligibilityTools.js'
import { registerAnalysisTools } from './tools/analysisTools.js'
import { registerResources } from './tools/resources.js'
import { installToolGuards } from './middleware/toolGuard.js'
import { mcpLimiter } from './middleware/rateLimit.js'
import { SERVER_PORT, IS_PRODUCTION, PUBLIC_BASE_URL } from './constants.js'
import { resolveLincxSessionFromBearer, bindMcpToLincxSession } from './services/sessionManager.js'
import { buildRouter, onRouterError } from './http/router.js'
import { json, noContent } from './http/respond.js'
import { header, readBody } from './http/request.js'

// ── MCP SERVER ───────────────────────────────────────────────────────────────

// A single McpServer can be bound to exactly ONE transport, and the Streamable
// HTTP transport is per-session — so build a fresh server per session.
function createMcpServer () {
  const server = new McpServer({ name: 'lincx-mcp-server', version: '1.0.0' })

  registerAuthTools(server)
  registerNetworkTools(server)
  registerTemplateTools(server)
  registerCreativeAssetGroupTools(server)
  registerZoneTools(server)
  registerAdTools(server)
  registerAdGroupTools(server)
  registerCreativeTools(server)
  registerCampaignTools(server)
  registerChannelTools(server)
  registerSiteTools(server)
  registerPublisherTools(server)
  registerAdvertiserTools(server)
  registerExperienceTools(server)
  registerReportingTools(server)
  registerZoneInventoryTools(server)
  registerZoneEligibilityTools(server)
  registerAnalysisTools(server)
  registerResources(server)

  installToolGuards(server)
  return server
}

// ── MCP HTTP transport — per-session ─────────────────────────────────────────

const transports = new Map()

async function createTransport () {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      transports.set(id, transport)
      console.error(`[MCP]    session initialized: ${id}`)
    }
  })
  transport.onclose = () => {
    if (transport.sessionId) {
      transports.delete(transport.sessionId)
      console.error(`[MCP]    session closed: ${transport.sessionId}`)
    }
  }
  const mcpServer = createMcpServer()
  try {
    await mcpServer.connect(transport)
  } catch (err) {
    await transport.close().catch(() => {})
    throw err
  }
  return transport
}

function bearerChallengeHeader () {
  return `Bearer resource_metadata="${PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`
}

function unauthorized (res, withBody) {
  res.setHeader('WWW-Authenticate', bearerChallengeHeader())
  if (withBody) {
    json(res, 401, { error: 'unauthorized', error_description: 'Bearer token required.' })
  } else {
    noContent(res, 401)
  }
}

async function mcpPost (req, res, _opts, cb) {
  if (!mcpLimiter(req, res)) return

  let body
  try {
    body = await readBody(req)
  } catch (err) {
    return cb(err)
  }

  try {
    const lincxSessionId = await resolveLincxSessionFromBearer(header(req, 'authorization'))
    if (!lincxSessionId) return unauthorized(res, true)

    const existingId = header(req, 'mcp-session-id')
    let transport

    if (existingId && transports.has(existingId)) {
      transport = transports.get(existingId)
    } else if (!existingId && isInitializeRequest(body)) {
      transport = await createTransport()
    } else {
      // Unknown/stale session id, or a non-initialize request without a session.
      // Common after a restart drops in-memory transports — tell the client to
      // re-initialize instead of silently minting a new session.
      return json(res, 400, {
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: {
          code: -32000,
          message: 'Bad Request: unknown or missing MCP session ID. Re-initialize the session.'
        }
      })
    }

    // Refresh the transport→Lincx binding on every request so reconnects
    // inherit the OAuth-resolved Lincx session immediately.
    if (transport.sessionId) {
      await bindMcpToLincxSession(transport.sessionId, lincxSessionId)
    }

    await transport.handleRequest(req, res, body)
  } catch (err) {
    console.error('[MCP]    POST /mcp error:', err instanceof Error ? err.message : String(err))
    if (!res.headersSent) {
      json(res, 500, {
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: { code: -32603, message: 'Internal server error.' }
      })
    }
  }
}

// NOTE: GET and DELETE take NO body reader. GET /mcp is the long-lived SSE
// stream; awaiting a body on it would hang the request forever.
async function mcpGet (req, res) {
  const lincxSessionId = await resolveLincxSessionFromBearer(header(req, 'authorization'))
  if (!lincxSessionId) return unauthorized(res, false)
  const existingId = header(req, 'mcp-session-id')
  if (!existingId || !transports.has(existingId)) {
    return json(res, 404, { error: 'Unknown MCP session.' })
  }
  await transports.get(existingId).handleRequest(req, res)
}

async function mcpDelete (req, res) {
  const lincxSessionId = await resolveLincxSessionFromBearer(header(req, 'authorization'))
  if (!lincxSessionId) return unauthorized(res, false)
  const existingId = header(req, 'mcp-session-id')
  if (!existingId || !transports.has(existingId)) return noContent(res, 404)
  await transports.get(existingId).handleRequest(req, res)
}

// ── Dev debug routes (non-production only) ───────────────────────────────────

function buildDevHandlers () {
  if (IS_PRODUCTION) return null
  const registeredTools = createMcpServer()._registeredTools
  return {
    list: (_req, res) => {
      const tools = Object.entries(registeredTools).map(([name, t]) => ({ name, description: t.description }))
      json(res, 200, { tools })
    },
    call: async (req, res, opts, cb) => {
      const tool = registeredTools[opts.params.name]
      if (!tool) return json(res, 404, { error: `Tool '${opts.params.name}' not found` })
      let body
      try { body = await readBody(req) } catch (err) { return cb(err) }
      try {
        json(res, 200, await tool.handler(body ?? {}, { sessionId: 'stdio' }))
      } catch (err) {
        json(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    }
  }
}

// ── STARTUP ──────────────────────────────────────────────────────────────────

/**
 * Everything below is inside start() DELIBERATELY — importing this module must
 * have no side effects. buildDevHandlers() constructs a whole McpServer (19 tool
 * registrations), so at module scope every test that imports this file would pay
 * for it at import time and could not choose a port. Task 26 mocks and starts
 * this module four times; module-scope construction would make that unusable.
 *
 * `port: 0` asks the OS for a free port — that is how tests avoid colliding
 * with a running dev server.
 */
export function start ({ port = SERVER_PORT } = {}) {
  const router = buildRouter({
    health: (_req, res) => json(res, 200, {
      status: 'ok',
      uptime_s: Math.round(process.uptime()),
      active_sessions: transports.size
    }),
    mcp: { post: mcpPost, get: mcpGet, del: mcpDelete },
    dev: buildDevHandlers()
  })

  const httpServer = http.createServer((req, res) => {
    router(req, res, {}, (err) => onRouterError(err, req, res))
  })

  httpServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`[HTTP]   Port ${port} in use — aborting.`)
    } else {
      console.error('[HTTP]   Server error:', err.message)
    }
    process.exit(1)
  })

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      const actual = httpServer.address().port
      console.error(`[HTTP]   Listening on :${actual}`)
      console.error('[HTTP]   /health, /login, /mcp')
      console.error('[MCP]    HTTP transport ready')
      resolve({ server: httpServer, port: actual })
    })
  })
}

// Task 21 moves this file to src/server.js and deletes the two lines below —
// src/index.js becomes the bootstrap that awaits loadSecrets() first.
await start()
```

- [ ] **Step 6: Full suite**

Run: `npm test`
Expected: everything green, including the contract suite with only the deliberate 405/trailing-slash amendments from Step 3.

- [ ] **Step 7: Manual smoke**

```bash
node --env-file=.env src/index.js &
sleep 2
curl -s localhost:5001/health
curl -s -i -X POST localhost:5001/mcp | grep -i 'www-authenticate'
curl -s -i localhost:5001/mcp | grep -i 'www-authenticate'
curl -s -i -X DELETE localhost:5001/mcp | grep -i 'www-authenticate'
curl -s -i -X PUT localhost:5001/mcp | head -1        # expect 405
curl -s localhost:5001/.well-known/oauth-protected-resource/mcp
curl -s -i localhost:5001/_ah/start | head -1         # expect 200
kill %1
```

Expected: all three `/mcp` methods emit `WWW-Authenticate` on 401; `PUT /mcp` is 405; `/_ah/start` is 200.

- [ ] **Step 8: Commit**

```bash
git add -A src/
git commit -m "refactor(http): replace express with http-hash-router"
```

---

### Task 20: Remove express

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Find every remaining reference**

```bash
grep -rn "express" src/ package.json scripts/
```

Expected: only `package.json`'s dependency entry. If `src/tests/oauth/flow.test.js` still builds an express app (Task 13 left it there deliberately), convert it now to `buildContractApp()` from `src/tests/contract/buildApp.js`.

- [ ] **Step 2: Uninstall**

```bash
npm rm express
```

- [ ] **Step 3: Verify the dependency budget held**

```bash
node -e "const p=require('./package.json');console.log(Object.keys(p.dependencies))"
```

Expected: `@modelcontextprotocol/sdk`, `http-hash-router`, `ioredis`, `uuid`, `zod` — **five**, down from six. `express`, `express-rate-limit` gone; `http-hash-router` added.

- [ ] **Step 4: Full run**

```bash
npm ci
npm run lint
npm test
```

Expected: all green from a clean install.

- [ ] **Step 5: Commit — Phase 3 complete**

```bash
git add -A
git commit -m "build: drop express — http-hash-router is the router"
```

**PHASE 3 GATE:** contract suite green with only the documented 405/trailing-slash amendments. `express` and `express-rate-limit` absent from `package.json`. Net dependency count decreased. All three `/mcp` methods emit the RFC-9728 challenge.

---

# PHASE 4 — Google App Engine

---

### Task 21: Secret Manager loader

`app.yaml` is committed to git, so `REDIS_URL` (which carries the Redis password) and `STATS_TOKEN` cannot live in it.

**Files:**
- Create: `src/config/secrets.js`
- Create: `src/tests/secrets.test.js`
- Modify: `src/index.js` (await secrets before importing constants), `package.json`

**Interfaces:**
- Produces: `loadSecrets()` → `Promise<void>`; sets `process.env.REDIS_URL` and `process.env.STATS_TOKEN` from Secret Manager when running on GAE. **No-op off GAE**, so local dev keeps using `.env`.

- [ ] **Step 1: Write the failing test**

`src/tests/secrets.test.js`:

```js
import test from 'ava'
import esmock from 'esmock'

test.serial('is a no-op when GAE_ENV is unset', async t => {
  delete process.env.GAE_ENV
  process.env.REDIS_URL = 'redis://local'
  let called = false
  const { loadSecrets } = await esmock('../config/secrets.js', {
    '@google-cloud/secret-manager': {
      SecretManagerServiceClient: class { async accessSecretVersion () { called = true; return [{}] } }
    }
  })
  await loadSecrets()
  t.false(called)
  t.is(process.env.REDIS_URL, 'redis://local')
})

test.serial('populates env from Secret Manager on GAE', async t => {
  process.env.GAE_ENV = 'standard'
  process.env.GOOGLE_CLOUD_PROJECT = 'proj'
  delete process.env.REDIS_URL
  delete process.env.STATS_TOKEN

  const { loadSecrets } = await esmock('../config/secrets.js', {
    '@google-cloud/secret-manager': {
      SecretManagerServiceClient: class {
        async accessSecretVersion ({ name }) {
          const key = name.includes('redis') ? 'redis://from-sm' : 'token-from-sm'
          return [{ payload: { data: Buffer.from(key) } }]
        }
      }
    }
  })
  await loadSecrets()
  t.is(process.env.REDIS_URL, 'redis://from-sm')
  t.is(process.env.STATS_TOKEN, 'token-from-sm')
  delete process.env.GAE_ENV
})

test.serial('an unreadable secret does not crash the boot', async t => {
  process.env.GAE_ENV = 'standard'
  process.env.GOOGLE_CLOUD_PROJECT = 'proj'
  const { loadSecrets } = await esmock('../config/secrets.js', {
    '@google-cloud/secret-manager': {
      SecretManagerServiceClient: class {
        async accessSecretVersion () { throw new Error('PERMISSION_DENIED') }
      }
    }
  })
  await t.notThrowsAsync(loadSecrets())
  delete process.env.GAE_ENV
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `npx ava src/tests/secrets.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Install and implement**

```bash
npm i @google-cloud/secret-manager
```

`src/config/secrets.js`:

```js
/**
 * config/secrets.js — populate process.env from Secret Manager before
 * constants.js is imported.
 *
 * app.yaml is committed to git, so REDIS_URL (carries the Redis password) and
 * STATS_TOKEN cannot live there. On GAE the runtime service account reads them
 * from Secret Manager at boot. Off GAE this is a no-op and .env still wins.
 *
 * NEVER log a secret value — only its name and whether it resolved.
 */

const SECRETS = [
  { env: 'REDIS_URL', secret: 'lincx-mcp-redis-url' },
  { env: 'STATS_TOKEN', secret: 'lincx-mcp-stats-token' }
]

export async function loadSecrets () {
  if (!process.env.GAE_ENV) return   // local / test — .env is authoritative

  const project = process.env.GOOGLE_CLOUD_PROJECT
  if (!project) {
    console.error('[Secrets] GOOGLE_CLOUD_PROJECT unset — skipping Secret Manager')
    return
  }

  const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager')
  const client = new SecretManagerServiceClient()

  for (const { env, secret } of SECRETS) {
    try {
      const [version] = await client.accessSecretVersion({
        name: `projects/${project}/secrets/${secret}/versions/latest`
      })
      const value = version.payload?.data?.toString()
      if (value) {
        process.env[env] = value
        console.error(`[Secrets] loaded ${env} from ${secret}`)
      } else {
        console.error(`[Secrets] ${secret} resolved empty — leaving ${env} unset`)
      }
    } catch (err) {
      // Fail open: an unset STATS_TOKEN 404s /stats, and an unset REDIS_URL
      // falls back to the in-memory store with a loud warning. Neither should
      // stop the instance from becoming healthy.
      console.error(`[Secrets] could not read ${secret}: ${err.message}`)
    }
  }
}
```

- [ ] **Step 4: Run it, verify it passes**

Run: `npx ava src/tests/secrets.test.js --verbose`
Expected: 3 passing.

- [ ] **Step 5: Wire it into boot — before `constants.js` is evaluated**

`constants.js` reads `process.env` at module scope, so `loadSecrets()` must run before it is imported. Split `src/index.js` into a thin bootstrap.

```bash
git mv src/index.js src/server.js
```

Then delete the last two lines of `src/server.js` (the `// Task 21 moves this file…` comment and the `await start()` call). **Do not change `start()`'s signature** — Task 19 already wrote it as `start({ port = SERVER_PORT } = {})` returning `{ server, port }`, which is exactly what both the bootstrap and Task 26's tests need. `src/server.js` now has no import-time side effects.

Create `src/index.js`:

```js
/**
 * index.js — bootstrap only.
 *
 * loadSecrets() must run BEFORE constants.js is evaluated, and constants.js is
 * imported transitively by almost everything in server.js. A static import here
 * would evaluate it too early, so server.js is imported dynamically.
 */
import { loadSecrets } from './config/secrets.js'

await loadSecrets()
const { start } = await import('./server.js')
await start()
```

Update the two references to the old path:

```bash
grep -rn "index\.js" package.json cloudbuild.yaml scripts/ CLAUDE.md 2>/dev/null
```

`package.json`'s `"start"` and `"main"` stay pointed at `src/index.js` — the bootstrap is still the entry point.

- [ ] **Step 6: Verify local boot is unaffected**

```bash
node --env-file=.env src/index.js &
sleep 2
curl -s localhost:5001/health
kill %1
```

Expected: `[Secrets]` prints nothing (GAE_ENV unset), `/health` returns ok.

- [ ] **Step 7: Create the secrets in GCP**

```bash
printf '%s' "redis://:<PASSWORD>@<MEMORYSTORE_IP>:6379" | \
  gcloud secrets create lincx-mcp-redis-url --data-file=- --project=<PROJECT_ID>

printf '%s' "$(openssl rand -hex 32)" | \
  gcloud secrets create lincx-mcp-stats-token --data-file=- --project=<PROJECT_ID>

# grant the GAE default service account read access
for S in lincx-mcp-redis-url lincx-mcp-stats-token; do
  gcloud secrets add-iam-policy-binding "$S" \
    --member="serviceAccount:<PROJECT_ID>@appspot.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor" \
    --project=<PROJECT_ID>
done
```

- [ ] **Step 8: Commit**

```bash
git add src/config/secrets.js src/server.js src/index.js src/tests/secrets.test.js package.json package-lock.json
git commit -m "feat(gcp): read REDIS_URL and STATS_TOKEN from Secret Manager at boot"
```

---

### Task 22: `app.yaml`, `.gcloudignore`, and the first deploy

Every value here comes from Task 3's findings file. Do not fill it from memory.

**Files:**
- Create: `app.yaml`, `.gcloudignore`

- [ ] **Step 1: Write `app.yaml`**

Substitute `<SCALING_BLOCK>` with whichever variant Task 3's decision line names.

```yaml
# GAE Standard service config for lincx-mcp-server.
#
# SINGLE INSTANCE IS A CORRECTNESS REQUIREMENT, not a cost choice: MCP transport
# state lives in an in-process Map (src/server.js). More than one instance gives
# intermittent "session not found". See CLAUDE.md § Deployment.
#
# Scaling mode chosen by the Phase 0 spike — see
# docs/superpowers/plans/phase0-findings.md § GAE spike results.

runtime: nodejs22
service: default

# <SCALING_BLOCK> — ONE of these, per the spike decision:
#
# manual_scaling:
#   instances: 1
#
# automatic_scaling:
#   min_instances: 1
#   max_instances: 1

inbound_services:
  - warmup

# instance_class: left at the runtime default for the first deploy. Task 23
# measures real memory under a whole-network scan and sets it from data.

env_variables:
  NODE_ENV: "production"
  WORK_API_BASE_URL: "https://api.lincx.com"
  PUBLIC_BASE_URL: "https://mcp.lincx.com"
  IDENTITY_SERVER: "https://ix-id.lincx.la"
  RESPONSE_SIZE_LIMIT: "30000"
  USAGE_EVENT_CAP: "50000"

# REDIS_URL and STATS_TOKEN are deliberately absent — this file is committed.
# src/config/secrets.js reads them from Secret Manager at boot.

vpc_access_connector:
  name: projects/<PROJECT_ID>/locations/<REGION>/connectors/<CONNECTOR_NAME>
```

- [ ] **Step 2: Write `.gcloudignore`**

```
.git
.gitignore
node_modules
.env
.sessions
.worktrees
dist
docs
docker-compose.dev.yml
scripts/dev-tunnel.mjs
src/tests
*.md
!package.json
```

**Do not exclude `src/`** — with no build step, `src/index.js` is what `npm start` runs.

- [ ] **Step 3: Verify the packaged file list before deploying**

```bash
gcloud meta list-files-for-upload . | sort
```

Expected: `package.json`, `package-lock.json`, `app.yaml`, and every file under `src/` **except** `src/tests/`. If `src/index.js` is missing, the `.gcloudignore` is wrong — fix it before deploying.

- [ ] **Step 4: Deploy without promoting traffic**

```bash
gcloud app deploy app.yaml --project=<PROJECT_ID> --no-promote --version=migration-1
```

- [ ] **Step 5: Smoke the un-promoted version**

```bash
V=https://migration-1-dot-<PROJECT_ID>.<REGION>.r.appspot.com

curl -s $V/health
curl -s -i -X POST $V/mcp | grep -i 'www-authenticate'
curl -s $V/.well-known/oauth-authorization-server
curl -s $V/.well-known/oauth-protected-resource/mcp
curl -s -i $V/_ah/start | head -1
curl -s -i $V/stats | head -1        # expect 401 (STATS_TOKEN loaded), NOT 404
```

`/stats` returning **404** means Secret Manager did not resolve `STATS_TOKEN` — check the instance logs for `[Secrets] could not read`.

- [ ] **Step 6: Verify Redis actually connected**

```bash
gcloud app logs tail -s default --project=<PROJECT_ID> | grep SessionStore
```

Expected: `[SessionStore] Using Redis`. If it says "No REDIS_URL — using in-memory store", the VPC connector or the secret is wrong. **Do not promote until this line is correct** — in-memory sessions mean every redeploy logs every user out.

- [ ] **Step 7: Commit**

```bash
git add app.yaml .gcloudignore
git commit -m "feat(gcp): App Engine service config and upload filter"
```

---

### Task 23: Domain mapping, instance class, and traffic cutover

- [ ] **Step 1: Map the custom domain**

```bash
gcloud app domain-mappings create mcp.lincx.com --project=<PROJECT_ID>
```

Add the DNS records it prints. Wait for the managed certificate:

```bash
gcloud app domain-mappings describe mcp.lincx.com --project=<PROJECT_ID>
```

Expected: `sslSettings.certificateId` populated.

- [ ] **Step 2: Confirm `PUBLIC_BASE_URL` matches the domain exactly**

```bash
curl -s https://mcp.lincx.com/.well-known/oauth-authorization-server | grep issuer
```

Expected: `https://mcp.lincx.com`, **no trailing slash**. A mismatch here breaks the OAuth redirect with no useful client-side error — it is the single most common deployment failure for this server.

- [ ] **Step 3: Measure memory under the heaviest tool, then set `instance_class`**

`get_zone_eligible_ad_groups` and `get_zone_targeting_inventory` scan a whole network's ad-groups/campaigns/ads/creatives in memory. Run the heaviest one against the largest network through a real MCP client, then read actual usage:

```bash
gcloud app instances list --service=default --project=<PROJECT_ID>
# then in Cloud Console → App Engine → Instances, read Memory Usage
```

Set `instance_class` in `app.yaml` to the smallest class with headroom above the observed peak, redeploy, and re-run the same tool to confirm no OOM restart:

```bash
gcloud app logs tail -s default --project=<PROJECT_ID> | grep -i 'memory\|exceeded\|killed'
```

- [ ] **Step 4: Promote traffic**

```bash
gcloud app services set-traffic default --splits=migration-1=1 --project=<PROJECT_ID>
```

- [ ] **Step 5: Full client verification — all three, by hand**

For each of Claude Code (via `mcp-remote https://mcp.lincx.com/mcp`), Claude Desktop, and claude.ai:

1. Add the connector — it must trigger the browser login page.
2. Log in with real credentials — it must redirect back and the client must show connected.
3. Run `auth_status` — must show the email and the active network.
4. Run `network_list` — must list networks.
5. Run `list_zones` with `limit: 5` — must return rows.
6. Run `get_zone_targeting_inventory` on a large zone — must return the full rollup, not a size error.
7. Run `report_query` over a 7-day range — must return aggregated groups.
8. Leave the client idle **over an hour**, then run a tool again — this exercises the OAuth access-token refresh (1h TTL). It must refresh silently.

Record each result in `docs/superpowers/plans/phase0-findings.md` under a "Cutover verification" heading.

- [ ] **Step 6: Confirm the redeploy behaviour you promised the platform team**

With a client connected and authenticated:

```bash
gcloud app deploy app.yaml --project=<PROJECT_ID> --quiet
```

Then run a tool from the still-open client. Expected: the client re-initializes (a new `mcp-session-id`) and **does not** prompt for login again — the OAuth tokens live in Redis and survive. Record the observed client behaviour.

- [ ] **Step 7: Commit**

```bash
git add app.yaml docs/superpowers/plans/phase0-findings.md
git commit -m "feat(gcp): pin instance_class from measured usage; record cutover verification"
```

---

### Task 24: Continuous deploy on master push

- [ ] **Step 1: Write `cloudbuild.yaml`**

```yaml
steps:
  - name: 'node:22'
    entrypoint: npm
    args: ['ci']

  - name: 'node:22'
    entrypoint: npm
    args: ['run', 'lint']

  - name: 'node:22'
    entrypoint: npm
    args: ['test']

  - name: 'gcr.io/google.com/cloudsdktool/cloud-sdk'
    entrypoint: gcloud
    args: ['app', 'deploy', 'app.yaml', '--quiet']

options:
  logging: CLOUD_LOGGING_ONLY
timeout: '1200s'
```

Tests gate the deploy — a red suite must not reach production.

- [ ] **Step 2: Create the trigger**

```bash
gcloud builds triggers create github \
  --repo-name=<REPO> --repo-owner=<ORG> \
  --branch-pattern='^master$' \
  --build-config=cloudbuild.yaml \
  --project=<PROJECT_ID>
```

- [ ] **Step 3: Grant the Cloud Build service account App Engine deploy rights**

```bash
PROJECT_NUMBER=$(gcloud projects describe <PROJECT_ID> --format='value(projectNumber)')
for ROLE in roles/appengine.deployer roles/appengine.serviceAdmin roles/cloudbuild.serviceAgent roles/iam.serviceAccountUser; do
  gcloud projects add-iam-policy-binding <PROJECT_ID> \
    --member="serviceAccount:${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com" --role="$ROLE"
done
```

- [ ] **Step 4: Prove the gate works**

Push a commit with a deliberately failing test on a branch, open a PR to master, merge it, and confirm the build **fails at the test step and does not deploy**. Then revert.

- [ ] **Step 5: Commit**

```bash
git add cloudbuild.yaml
git commit -m "ci: deploy to App Engine on master push, gated by lint and tests"
```

---

### Task 25: Delete the old deployment artefacts and rewrite the docs

**Files:**
- Delete: `Dockerfile`, `docker-compose.yml`, `docker-compose.coolify.yml`, `.dockerignore`
- Keep: `docker-compose.dev.yml` (local Redis only — see Decision D7)
- Modify: `DEPLOYMENT.md`, `CLAUDE.md`, `README.md`, `.env.example`

- [ ] **Step 1: Delete**

```bash
git rm Dockerfile docker-compose.yml docker-compose.coolify.yml .dockerignore
```

- [ ] **Step 2: Make `docker-compose.dev.yml` standalone**

It currently overlays `docker-compose.yml`, which is gone. Open it and make it a complete file defining only the `redis` service, then verify:

```bash
docker compose -f docker-compose.dev.yml up -d redis
docker compose -f docker-compose.dev.yml ps
docker compose -f docker-compose.dev.yml stop redis
```

- [ ] **Step 3: Rewrite `DEPLOYMENT.md`**

Replace the whole document. It must cover, in this order: prerequisites (`gcloud`, project, VPC connector, Memorystore), creating the two secrets, `gcloud app deploy`, domain mapping, the `PUBLIC_BASE_URL` exact-match warning, reading logs, rolling back (`gcloud app versions list` / `set-traffic`), and how to kill access deploy-wide (stop the version, or flush Redis to invalidate every OAuth token).

- [ ] **Step 4: Update `CLAUDE.md`**

Edit these sections — they are now wrong in the ways that will mislead the next reader most:

- **"Project structure"** — `.ts` → `.js`; add `src/http/`, `src/config/`; remove `src/types.ts`.
- **"Build and run"** — remove `npm run build` and the `tsc`/`tsx` references; `npm start` runs `node src/index.js`; `npm test` runs ava.
- **"TypeScript conventions"** → rename to **"JavaScript conventions"**: ESM with `.js` extensions (unchanged), `standard` lint, no build step, `z.object({}).strict()` on all tool schemas (unchanged — zod is protocol), no type annotations. **Delete the "Tool handler return type" and "`as const` on `type: 'text'`" lines** — the `as const` requirement was a TypeScript artefact and no longer applies.
- **"How to add a new business tool"** — rewrite the code sample as plain JS.
- **"Deployment"** — replace the Coolify/compose paragraph with App Engine. **Keep the two constraint bullets verbatim** (single instance, no auth gate in front of `/mcp`) — they are as true on GAE as on Docker, and the `src/index.ts:137` line reference becomes `src/server.js`.
- **"Environment variables"** — note that `REDIS_URL` and `STATS_TOKEN` come from Secret Manager in production, everything else from `app.yaml`.

- [ ] **Step 5: Update `.env.example`**

Strip the `REDIS_PASSWORD` var (it only fed the deleted prod compose file) and rewrite the header comment: this file is **local dev only**; production config lives in `app.yaml` + Secret Manager.

- [ ] **Step 6: Verify the docs are not lying**

Follow `DEPLOYMENT.md` literally, from a clean shell, as if you had never seen the project. Every command must run as written. Fix whatever does not.

- [ ] **Step 7: Commit — Phase 4 complete**

```bash
git add -A
git commit -m "docs: App Engine deployment; delete Docker/Coolify artefacts"
```

**PHASE 4 GATE:** `https://mcp.lincx.com/mcp` serves all three MCP clients through a full login → tool-call → token-refresh cycle. `[SessionStore] Using Redis` in the logs. Master push deploys. No Docker artefact remains except the local-dev Redis compose file.

---

# PHASE 5 — The verification suite

Everything above proves the migration did not change behaviour. This phase adds the tests that **should have existed already** and that the migration makes it cheap to add.

---

### Task 26: MCP protocol integration test

The current `smoke.test.js` is 43 lines and never speaks the protocol. Nothing in the suite catches a break in the transport wiring — the exact thing Phase 3 rewrote.

**Files:**
- Create: `src/tests/mcpProtocol.test.js`

**Interfaces:**
- Consumes: `buildRouter`/`onRouterError` (Task 19), `@modelcontextprotocol/sdk/client`.

- [ ] **Step 1: Write the failing test**

```js
import test from 'ava'
import http from 'node:http'
import esmock from 'esmock'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// A real server, with auth resolution and the Work API stubbed at the seam.
async function startServer () {
  const { start } = await esmock('../server.js', {}, {
    '../services/sessionManager.js': {
      resolveLincxSessionFromBearer: async (h) => (h ? 'lincx-test-session' : null),
      bindMcpToLincxSession: async () => {},
      resolveLincxSession: async () => 'lincx-test-session',
      validateSession: async () => ({
        valid: true,
        session: { session_id: 'lincx-test-session', email: 'a@b.c', active_network: 'svce6t', networks: [] }
      })
    }
  })
  return start({ port: 0 })   // signature written in Task 19 Step 5; port 0 = OS-assigned
}

test.serial('MCP > initialize, tools/list, tools/call, DELETE', async t => {
  const { server, port } = await startServer()
  const url = new URL(`http://127.0.0.1:${port}/mcp`)

  const client = new Client({ name: 'contract-client', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { authorization: 'Bearer test-token' } }
  })

  await client.connect(transport)
  t.truthy(transport.sessionId, 'the server must mint an mcp-session-id')

  const { tools } = await client.listTools()
  t.true(tools.length > 30, `expected the full tool surface, got ${tools.length}`)

  const names = tools.map((x) => x.name)
  for (const required of ['auth_status', 'network_list', 'list_zones', 'report_query']) {
    t.true(names.includes(required), `missing tool ${required}`)
  }

  // Every tool schema must reject networkId — the multi-tenancy invariant.
  for (const tool of tools) {
    t.false(
      Object.keys(tool.inputSchema?.properties ?? {}).includes('networkId'),
      `${tool.name} must not accept networkId`
    )
  }

  const result = await client.callTool({ name: 'auth_status', arguments: {} })
  t.true(Array.isArray(result.content))
  t.is(result.content[0].type, 'text')

  await transport.terminateSession()
  await client.close()
  await new Promise((r) => server.close(r))
})

test.serial('MCP > POST without a bearer token is 401 with the RFC-9728 challenge', async t => {
  const { server, port } = await startServer()
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  })
  t.is(r.status, 401)
  t.regex(r.headers.get('www-authenticate') ?? '', /^Bearer resource_metadata="/)
  await new Promise((res) => server.close(res))
})

test.serial('MCP > a stale session id gets -32000, not a silent new session', async t => {
  const { server, port } = await startServer()
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer test-token',
      'mcp-session-id': 'does-not-exist'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  })
  t.is(r.status, 400)
  const body = await r.json()
  t.is(body.error.code, -32000)
  await new Promise((res) => server.close(res))
})

test.serial('MCP > GET and DELETE do not hang waiting for a body', async t => {
  // Regression guard: blanket-wrapping every route in a body reader would make
  // these two never resolve. The bodyless methods must answer immediately.
  const { server, port } = await startServer()
  for (const method of ['GET', 'DELETE']) {
    const r = await Promise.race([
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method,
        headers: { authorization: 'Bearer test-token', 'mcp-session-id': 'nope' }
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error(`${method} hung`)), 3000))
    ])
    t.is(r.status, 404, `${method} with an unknown session should 404`)
  }
  await new Promise((res) => server.close(res))
})
```

- [ ] **Step 2: Verify esmock MERGES rather than replaces, before debugging the wrong layer**

`startServer()` supplies a partial `sessionManager` mock (four functions), but `routes/login.js` also imports `createSession` from that module. esmock's default (non-`strict`) mode merges the mock over the original exports, so `createSession` survives. If that assumption is wrong for 2.7.6, all four tests fail with an unhelpful error deep inside the SDK.

Confirm it in one throwaway assertion first:

```js
test.serial('esmock merges partial mocks with the original module', async t => {
  const mod = await esmock('../services/sessionManager.js', {}, {
    '../services/networkService.js': { fetchUserNetworks: async () => [] }
  })
  t.is(typeof mod.createSession, 'function', 'esmock replaced instead of merged — use esmock.strict semantics and mock every export')
})
```

Run it. If it fails, every mock object in Task 26 must define **every** export of the module it replaces — fix that before continuing.

- [ ] **Step 3: Run the suite, verify it fails for the right reason**

Run: `npx ava src/tests/mcpProtocol.test.js`
Expected: FAIL on assertions, **not** on `start is not a function` or a port collision. Task 19 already wrote `start({ port = SERVER_PORT } = {})` returning `{ server, port }`; if that signature is missing, Task 19 Step 5 was not applied as written — go back rather than patching it here.

- [ ] **Step 4: Make the tests pass**

The failures should be assertion-level (tool count, tool names, status codes). Fix the test's expectations against what the server actually returns — **not** the server, unless a genuine regression is found. Any real regression here means Phase 3 broke the transport wiring and belongs in a Phase 3 fix commit.

Run: `npx ava src/tests/mcpProtocol.test.js --verbose`
Expected: 4 passing (5 with the esmock-merge guard).

- [ ] **Step 5: Commit**

```bash
git add src/tests/mcpProtocol.test.js
git commit -m "test(mcp): end-to-end protocol round trip over the new transport wiring"
```

---

### Task 27: Redis integration test

`sessionStore` has a Redis path and an in-memory path. Only the in-memory path is exercised today, and the Redis path is the one production depends on.

**Files:**
- Create: `src/tests/redisIntegration.test.js`

- [ ] **Step 1: Write the test**

```js
import test from 'ava'
import esmock from 'esmock'

const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://default:localdev@localhost:6379'

// Skipped unless a Redis is reachable — CI without one still passes, but the
// skip is LOUD so it can never be mistaken for coverage.
let available = false
test.before(async () => {
  try {
    const { Redis } = await import('ioredis')
    const r = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true })
    await r.connect()
    await r.ping()
    r.disconnect()
    available = true
  } catch (err) {
    console.error(`[redisIntegration] SKIPPING — no Redis at ${REDIS_URL}: ${err.message}`)
  }
})

async function store () {
  process.env.REDIS_URL = REDIS_URL
  return esmock('../services/sessionStore.js', {})
}

test.serial('round-trips a session and reports Redis as the backend', async t => {
  if (!available) return t.pass('skipped — no Redis')
  const s = await store()
  const session = {
    session_id: 'itest-1',
    user_id: 'u@example.com',
    email: 'u@example.com',
    auth_token: 'jwt-value',
    networks: [{ id: 'svce6t', name: 'Net' }],
    active_network: 'svce6t'
  }
  await s.setSession(session)
  const back = await s.getSession('itest-1')
  t.is(back.email, 'u@example.com')
  t.is(back.active_network, 'svce6t')
  await s.deleteSession('itest-1')
  t.is(await s.getSession('itest-1'), null)
})

test.serial('a key expires at its TTL', async t => {
  if (!available) return t.pass('skipped — no Redis')
  const s = await store()
  const { Redis } = await import('ioredis')
  const r = new Redis(REDIS_URL)
  await s.setSession({ session_id: 'itest-ttl', user_id: 'x', email: 'x', auth_token: 't', networks: [], active_network: null })
  const ttl = await r.ttl('lincx:session:itest-ttl')
  t.true(ttl > 0 && ttl <= 60 * 60 * 24 * 7, `expected a 7-day TTL, got ${ttl}`)
  await s.deleteSession('itest-ttl')
  r.disconnect()
})

test.serial('the usage-event log is capped', async t => {
  if (!available) return t.pass('skipped — no Redis')
  process.env.REDIS_URL = REDIS_URL
  process.env.USAGE_EVENT_CAP = '10'
  const { getEventSink } = await esmock('../services/usageAnalytics.js', {})
  const sink = await getEventSink()
  for (let i = 0; i < 25; i++) {
    await sink.record({ type: 'tool', name: `t${i}`, status: 'ok', duration_ms: 1, response_chars: 1, params_keys: [] })
  }
  const events = await sink.readRecent(100)
  t.true(events.length <= 10, `cap not enforced: ${events.length} events retained`)
})
```

- [ ] **Step 2: Bring up the dev Redis and run**

```bash
docker compose -f docker-compose.dev.yml up -d redis
npx ava src/tests/redisIntegration.test.js --verbose
```

Expected: 3 passing, **no** `SKIPPING` line on stderr.

- [ ] **Step 3: Confirm the skip path is loud**

```bash
docker compose -f docker-compose.dev.yml stop redis
npx ava src/tests/redisIntegration.test.js --verbose
```

Expected: 3 passing with a visible `[redisIntegration] SKIPPING` line. Bring Redis back up.

- [ ] **Step 4: Adjust the exported names if they differ**

`grep -n 'export' src/services/sessionStore.js` and align the test with the real export names.

- [ ] **Step 5: Commit**

```bash
git add src/tests/redisIntegration.test.js
git commit -m "test(redis): integration coverage for the session store and the capped event log"
```

---

### Task 28: Production smoke script

**Files:**
- Create: `scripts/smoke-prod.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write it**

```js
#!/usr/bin/env node
/**
 * Post-deploy verification against a live URL.
 *   node scripts/smoke-prod.mjs https://mcp.lincx.com
 *
 * Read-only and unauthenticated: it never logs in and never sends a token, so
 * it is safe to run against production on every deploy.
 */

const base = (process.argv[2] ?? 'https://mcp.lincx.com').replace(/\/$/, '')
let failures = 0

async function check (name, fn) {
  try {
    await fn()
    console.error(`  PASS  ${name}`)
  } catch (err) {
    failures += 1
    console.error(`  FAIL  ${name} — ${err.message}`)
  }
}

function assert (cond, msg) { if (!cond) throw new Error(msg) }

console.error(`Smoking ${base}`)

await check('/health returns ok', async () => {
  const r = await fetch(`${base}/health`)
  assert(r.status === 200, `status ${r.status}`)
  const b = await r.json()
  assert(b.status === 'ok', `status field ${b.status}`)
})

await check('POST /mcp challenges with RFC-9728', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  assert(r.status === 401, `status ${r.status}`)
  const wa = r.headers.get('www-authenticate') ?? ''
  assert(wa.startsWith('Bearer resource_metadata="'), `WWW-Authenticate: ${wa}`)
  assert(wa.includes(base), `challenge points elsewhere: ${wa}`)
})

await check('GET /mcp challenges with RFC-9728', async () => {
  const r = await fetch(`${base}/mcp`)
  assert(r.status === 401, `status ${r.status}`)
  assert((r.headers.get('www-authenticate') ?? '').startsWith('Bearer '), 'missing challenge')
})

await check('authorization-server metadata matches the public base URL', async () => {
  const r = await fetch(`${base}/.well-known/oauth-authorization-server`)
  assert(r.status === 200, `status ${r.status}`)
  const b = await r.json()
  assert(b.issuer === base, `issuer ${b.issuer} != ${base} — PUBLIC_BASE_URL is wrong`)
  assert(b.authorization_endpoint === `${base}/oauth/authorize`, `authorization_endpoint ${b.authorization_endpoint}`)
  assert(b.token_endpoint === `${base}/oauth/token`, `token_endpoint ${b.token_endpoint}`)
})

await check('protected-resource metadata is served at both paths', async () => {
  for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const r = await fetch(`${base}${p}`)
    assert(r.status === 200, `${p} → ${r.status}`)
    const b = await r.json()
    assert(b.resource === `${base}/mcp`, `${p} resource ${b.resource}`)
  }
})

await check('DCR issues a client_id', async () => {
  const r = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://localhost:9999/cb'], client_name: 'smoke' })
  })
  assert(r.status === 201, `status ${r.status}`)
  const b = await r.json()
  assert(typeof b.client_id === 'string' && b.client_id.length > 0, 'no client_id')
})

await check('/stats is gated, not open', async () => {
  const r = await fetch(`${base}/stats`)
  assert(r.status === 401 || r.status === 404, `status ${r.status} — /stats must never be 200 unauthenticated`)
})

await check('/_ah/start answers 200', async () => {
  const r = await fetch(`${base}/_ah/start`)
  assert(r.status === 200, `status ${r.status}`)
})

console.error(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) FAILED.`)
process.exit(failures === 0 ? 0 : 1)
```

- [ ] **Step 2: Run it locally first**

```bash
node --env-file=.env src/index.js &
sleep 2
node scripts/smoke-prod.mjs http://localhost:5001
kill %1
```

Expected: all pass except `/stats` if `STATS_TOKEN` is blank locally (404 is an accepted outcome).

- [ ] **Step 3: Run it against production**

```bash
node scripts/smoke-prod.mjs https://mcp.lincx.com
```

Expected: all pass, exit 0.

- [ ] **Step 4: Add it to the deploy pipeline**

Append to `cloudbuild.yaml`:

```yaml
  - name: 'node:22'
    entrypoint: node
    args: ['scripts/smoke-prod.mjs', 'https://mcp.lincx.com']
```

- [ ] **Step 5: Add the npm script**

```json
"smoke": "node scripts/smoke-prod.mjs"
```

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke-prod.mjs cloudbuild.yaml package.json
git commit -m "test: post-deploy production smoke script, wired into the pipeline"
```

---

### Task 29: Soak test — the single-instance and session-longevity claims

The two riskiest production properties are the two nothing above proves: that the instance really stays singular, and that a session survives a realistic idle period.

**Files:**
- Create: `scripts/soak.mjs`

- [ ] **Step 1: Write it**

```js
#!/usr/bin/env node
/**
 * Soak: hold an authenticated MCP session open and poll, verifying that a single
 * instance serves every request and the session never silently dies.
 *
 *   SOAK_TOKEN=<access_token> node scripts/soak.mjs https://mcp.lincx.com 3600
 *
 * The token comes from the environment, never argv — a CLI argument lands in
 * shell history and in `ps` output. Get it from your MCP client's stored
 * credentials after a normal browser login.
 */

const [base, secondsArg] = process.argv.slice(2)
const token = process.env.SOAK_TOKEN
if (!base || !token) {
  console.error('usage: SOAK_TOKEN=<access-token> node scripts/soak.mjs <base-url> [seconds]')
  process.exit(1)
}
const durationMs = (Number(secondsArg) || 3600) * 1000

const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }

const init = await fetch(`${base}/mcp`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'soak', version: '1.0.0' } }
  })
})
const sessionId = init.headers.get('mcp-session-id')
if (!sessionId) { console.error(`initialize failed: ${init.status}`); process.exit(1) }
console.error(`session ${sessionId.slice(0, 8)}… established`)

const started = Date.now()
let n = 0
let failures = 0
const uptimes = []

while (Date.now() - started < durationMs) {
  await new Promise((r) => setTimeout(r, 60_000))
  n += 1

  const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null)
  if (health) uptimes.push(health.uptime_s)

  const r = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { ...headers, 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: n + 1, method: 'tools/list', params: {} })
  })

  const ok = r.status === 200
  if (!ok) failures += 1
  console.error(`[${Math.round((Date.now() - started) / 60000)}m] tools/list ${r.status} ${ok ? '' : '<-- FAILURE'} uptime_s=${health?.uptime_s ?? '?'} active_sessions=${health?.active_sessions ?? '?'}`)

  if (!ok) {
    console.error(await r.text())
    break
  }
}

// A monotonically increasing uptime proves one instance served the whole run.
const restarts = uptimes.filter((u, i) => i > 0 && u < uptimes[i - 1]).length
console.error(`\npolls=${n} failures=${failures} observed_restarts=${restarts}`)
console.error(restarts === 0 && failures === 0 ? 'PASS — one instance, session held throughout.' : 'FAIL — see above.')
process.exit(restarts === 0 && failures === 0 ? 0 : 1)
```

- [ ] **Step 2: Run a 60-minute soak against production**

```bash
read -rs SOAK_TOKEN && export SOAK_TOKEN   # paste the token, it stays out of history
node scripts/soak.mjs https://mcp.lincx.com 3600
```

Expected: `observed_restarts=0`, `failures=0`. The run must cross the 1-hour OAuth access-token TTL — if the last polls 401, the client-side refresh is what covers it in a real client, and that is worth recording explicitly.

- [ ] **Step 3: Run a concurrent-instance check during the soak**

In a second terminal, while the soak runs:

```bash
for i in $(seq 1 40); do curl -s https://mcp.lincx.com/health | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d["uptime_s"])'; done | sort -n | uniq -c
```

Expected: a tight cluster of increasing values. **Two widely separated uptime values means two instances are serving** — the config is wrong and MCP sessions will fail intermittently. Stop and fix `app.yaml` before anything else.

- [ ] **Step 4: Record and commit**

Append the soak results to `docs/superpowers/plans/phase0-findings.md` under "Soak results".

```bash
git add scripts/soak.mjs docs/superpowers/plans/phase0-findings.md
git commit -m "test: soak script verifying single-instance and session longevity"
```

---

## Full verification checklist

Run before declaring the migration done.

### Automated — `npm test` must cover all of these

| # | Check | Where | Added by |
|---|---|---|---|
| 1 | 204 pre-existing unit assertions | `src/tests/**` | existing |
| 2 | HTTP contract: every route's status, content-type, headers | `contract/http.test.js` | Task 2 |
| 3 | Method-not-allowed on every route | `contract/http.test.js` | Task 2/19 |
| 4 | Trailing-slash behaviour on every route | `contract/http.test.js` | Task 2 |
| 5 | `/oauth/authorize` → 302 + exact `Location` | `contract/http.test.js` | Task 2 |
| 6 | Malformed JSON → 400 | `contract/http.test.js`, `http/request.test.js` | Task 2/16 |
| 7 | Body over 100kb → 413, enforced while streaming | `http/request.test.js` | Task 16 |
| 8 | `WWW-Authenticate` on 401 from POST, GET and DELETE `/mcp` | `mcpProtocol.test.js` | Task 26 |
| 9 | Response helpers: status, content-type, headers-sent guard | `http/respond.test.js` | Task 15 |
| 10 | Query parsing, case-insensitive headers, client-IP hop index | `http/request.test.js` | Task 16 |
| 11 | Rate limiter: limit, 429, draft-7 headers, `Retry-After`, per-key isolation, window reset, Map eviction | `rateLimit.test.js` | Task 17 |
| 12 | OAuth end-to-end: authorize → login → code → token → refresh | `oauth/flow.test.js` | Task 13 |
| 13 | Refresh-token rotation invalidates the old token | `oauth/flow.test.js` | Task 13 |
| 14 | PKCE S256 verification, code single-use, TTLs | `oauth/*.test.js` | existing |
| 15 | MCP: initialize → tools/list → tools/call → DELETE | `mcpProtocol.test.js` | Task 26 |
| 16 | Full tool surface present (>30 tools, named ones exist) | `mcpProtocol.test.js` | Task 26 |
| 17 | **No tool schema accepts `networkId`** | `mcpProtocol.test.js` | Task 26 |
| 18 | Stale `mcp-session-id` → `-32000`, not a silent new session | `mcpProtocol.test.js` | Task 26 |
| 19 | `GET`/`DELETE /mcp` never hang on a body read | `mcpProtocol.test.js` | Task 26 |
| 20 | `create_analysis` absent when `NODE_ENV=production` | `analysisToolGating.test.js` | existing |
| 21 | `/stats` 404s with `STATS_TOKEN` unset, 401s without the token | `stats.route*.test.js` | existing |
| 22 | Redis session round-trip, 7-day TTL, capped event log | `redisIntegration.test.js` | Task 27 |
| 23 | Secret Manager: no-op locally, populates on GAE, survives a read failure | `secrets.test.js` | Task 21 |
| 24 | Response-size guard trips above `RESPONSE_SIZE_LIMIT` | `toolGuard.test.js` | existing |
| 25 | List paging terminates over an oversized row | `listEnvelope.test.js` | existing |

### Manual — run once at cutover, record in `phase0-findings.md`

- [ ] Claude Code via `mcp-remote`: connect → browser login → `auth_status` → `network_list` → `list_zones` → `get_zone_targeting_inventory` → `report_query`
- [ ] Claude Desktop: same sequence
- [ ] claude.ai connector: same sequence
- [ ] Idle > 1 hour, then a tool call — OAuth access token refreshes silently
- [ ] `network_switch` then a tool call — the new network's data comes back
- [ ] `auth_logout` then a tool call — a re-login prompt, not a stack trace
- [ ] Redeploy with a client connected — the client re-initializes without a login prompt
- [ ] `node scripts/smoke-prod.mjs https://mcp.lincx.com` — exit 0
- [ ] `node scripts/soak.mjs … 3600` — `observed_restarts=0`, `failures=0`
- [ ] 40× `/health` during the soak — one uptime cluster, i.e. one instance
- [ ] `gcloud app logs tail | grep SessionStore` — `Using Redis`
- [ ] `/.well-known/oauth-authorization-server` `issuer` exactly equals `https://mcp.lincx.com`
- [ ] Push a red test to master — Cloud Build fails and does **not** deploy

### Rollback

If the cutover fails, the previous platform is still running until you tear it down:

```bash
gcloud app versions list --project=<PROJECT_ID>
gcloud app services set-traffic default --splits=<PREVIOUS_VERSION>=1 --project=<PROJECT_ID>
```

Keep the old Docker host running, and the git tag for the last Express/TS commit, until the soak passes and all three clients are verified. **Do not delete the old deployment in the same week as the cutover.**

---

## Self-review

**Spec coverage.** All four stack changes are covered: deployment target (Phase 0 Task 3, Phase 4 Tasks 21–25), TypeScript → JavaScript (Phase 1, Tasks 4–8), express → http-hash-router (Phase 3, Tasks 15–20), vitest → ava (Phase 2, Tasks 9–14). Coolify removal is Task 25. The "existing GCP Redis, dedicated keyspace" requirement is Task 21 (the URL comes from Secret Manager; the app's keys are already prefixed `lincx:`/`oauth:`/`mcp:`/`usage:`). "Stable deploys on master push" is Task 24.

**Known gaps, stated rather than hidden.**
1. The GAE scaling block in Task 22 is deliberately left as a placeholder filled from Task 3's measurement. That is a decision gate, not a placeholder defect — no number about GAE in this plan is asserted from memory.
2. `instance_class` is likewise set from measured memory in Task 23 Step 3, not guessed.
3. The exact `clientIp` hop index in Task 16 is reconciled against the spike in Step 5. The plan ships a default of one trusted hop (matching Express's `trust proxy: 1`) and a test that must change with it.
4. Task 19 Step 3 will produce real failures. That is intended: those are the behavioural deltas between Express and `http-hash`, and each is resolved by an explicit written decision rather than by adjusting a test until it goes green.

**Type consistency.** `buildContractApp()` keeps its name and signature across Tasks 2 and 19 — the contract test never changes. `start({ port = SERVER_PORT } = {}) → Promise<{ server, port }>` is written **once**, in Task 19 Step 5; Task 21 only moves the file and drops the trailing `await start()`, and Task 26 consumes it as written. No two tasks edit that signature. `createLimiter(...)` returns a function used as `limiter(req, res) → boolean` in Tasks 17, 18 and 19 consistently. `readBody(req)` throws `BodyError` with `.statusCode`, which `onRouterError` maps in Task 19 and every caller forwards via `cb(err)`.

**Import-time side effects.** `src/server.js` constructs nothing at module scope — `buildRouter()` and `buildDevHandlers()` (which builds a full 19-tool `McpServer`) live inside `start()`. This is load-bearing: Task 26 esmocks and starts the module four times, and module-scope construction would make that both slow and unable to choose a port.

**Test determinism.** The ava config pins `STATS_TOKEN=""` and `REDIS_URL=""` so the contract suite's `/stats`-404 assertion and the in-memory-store assumptions do not depend on the developer's `.env`. `redisIntegration.test.js` opts back in through `TEST_REDIS_URL` and skips loudly when no Redis answers.

---

## Sequencing summary

| Phase | Tasks | Ends when | Reviewable as |
|---|---|---|---|
| 0 — Evidence | 1–3 | GAE decision recorded; contract suite green on Express | 2 PRs (probe, harness) |
| 1 — TS → JS | 4–8 | `npm test` green, no `tsc`, server boots | 1 PR, diff is "types removed" |
| 2 — vitest → ava | 9–14 | ava green, assertion count ≥ baseline | 1 PR |
| 3 — express → router | 15–20 | contract suite green, express gone | 1 PR |
| 4 — GAE | 21–25 | live on `mcp.lincx.com`, all 3 clients verified | 1 PR + infra |
| 5 — Verification | 26–29 | soak passes, smoke wired into CI | 1 PR |

Six reviewable pull requests against a fixed acceptance harness — not one 8,343-line rewrite.
