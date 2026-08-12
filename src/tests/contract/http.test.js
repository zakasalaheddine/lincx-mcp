/**
 * tests/contract/http.test.ts — THE acceptance harness for the stack migration.
 *
 * Every assertion below was RECORDED against the current Express server and then
 * PINNED. These assertions must not drift: they are what makes each of the three
 * stack conversions (#65 TS->JS, #66 vitest->ava, #67 express->http-hash-router)
 * verifiable instead of hopeful.
 *
 * Only src/tests/contract/buildApp.ts changes between phases. This file's
 * assertions change ONLY where a behavioural delta is deliberately accepted, and
 * every such change carries a comment naming the phase that caused it.
 *
 * The cases here are chosen for where http-hash + http-methods differ from
 * Express, not for even coverage:
 *   - method-not-allowed  (Express falls through to 404; http-methods returns 405)
 *   - trailing slashes    (Express Router matches both; http-hash matches exactly)
 *   - res.redirect        (status + Location, which the login flow depends on)
 *   - malformed JSON      (body-parser 400s; a hand-rolled reader would 500)
 *   - body size limit     (express.json()'s 100kb default, silently re-implemented)
 *   - WWW-Authenticate    (the RFC-9728 challenge the OAuth discovery path needs)
 */

import { describe, it, expect } from "vitest";
import request from "supertest";
import { buildContractApp } from "./buildApp.js";

const app = buildContractApp();

async function registerClient(redirectUri = "http://localhost:9999/callback") {
  const r = await request(app)
    .post("/oauth/register")
    .send({ redirect_uris: [redirectUri], client_name: "contract" });
  return r.body.client_id          ;
}

// ── /health ──────────────────────────────────────────────────────────────────

describe("contract: /health", () => {
  it("200 with status ok", async () => {
    const r = await request(app).get("/health");
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("ok");
    expect(typeof r.body.uptime_s).toBe("number");
  });
});

// ── OAuth discovery ──────────────────────────────────────────────────────────

describe("contract: OAuth discovery", () => {
  it("serves authorization-server metadata", async () => {
    const r = await request(app).get("/.well-known/oauth-authorization-server");
    expect(r.status).toBe(200);
    expect(r.body.issuer).toBeDefined();
    expect(r.body.authorization_endpoint).toMatch(/\/oauth\/authorize$/);
    expect(r.body.token_endpoint).toMatch(/\/oauth\/token$/);
    expect(r.body.registration_endpoint).toMatch(/\/oauth\/register$/);
    expect(r.body.response_types_supported).toEqual(["code"]);
    expect(r.body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(r.body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(r.body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(r.body.scopes_supported).toEqual(["mcp"]);
  });

  it("serves protected-resource metadata at the ROOT form", async () => {
    const r = await request(app).get("/.well-known/oauth-protected-resource");
    expect(r.status).toBe(200);
    expect(r.body.resource).toMatch(/\/mcp$/);
    expect(r.body.bearer_methods_supported).toEqual(["header"]);
  });

  it("serves protected-resource metadata at the RFC-9728 path-suffixed form", async () => {
    // RFC 9728 §3.1 — spec-conformant clients build this form and ignore the root.
    // Both must work or discovery breaks for some clients.
    const r = await request(app).get("/.well-known/oauth-protected-resource/mcp");
    expect(r.status).toBe(200);
    expect(r.body.resource).toMatch(/\/mcp$/);
  });
});

// ── Dynamic client registration ──────────────────────────────────────────────

describe("contract: dynamic client registration", () => {
  it("201 with a client_id for a valid redirect_uri", async () => {
    const r = await request(app)
      .post("/oauth/register")
      .send({ redirect_uris: ["http://localhost:9999/callback"], client_name: "contract" });
    expect(r.status).toBe(201);
    expect(typeof r.body.client_id).toBe("string");
    expect(r.body.client_id.length).toBe(32);
    expect(typeof r.body.client_id_issued_at).toBe("number");
    expect(r.body.token_endpoint_auth_method).toBe("none");
    expect(r.body.grant_types).toEqual(["authorization_code", "refresh_token"]);
    expect(r.body.response_types).toEqual(["code"]);
  });

  it("accepts an https redirect_uri", async () => {
    const r = await request(app)
      .post("/oauth/register")
      .send({ redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    expect(r.status).toBe(201);
  });

  it("400 invalid_redirect_uri when redirect_uris is missing", async () => {
    const r = await request(app).post("/oauth/register").send({ client_name: "bad" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_redirect_uri");
  });

  it("400 invalid_redirect_uri for a non-https, non-localhost URI", async () => {
    const r = await request(app)
      .post("/oauth/register")
      .send({ redirect_uris: ["http://evil.example.com/cb"] });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_redirect_uri");
  });

  it("400 on a malformed JSON body", async () => {
    // express.json() rejects this via body-parser. A hand-rolled reader that
    // lets JSON.parse throw would surface a 500 instead — pinned so it can't.
    const r = await request(app)
      .post("/oauth/register")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(r.status).toBe(400);
  });

  it("413 on a body over the 100kb limit", async () => {
    // express.json()'s default limit. Re-implementing the body reader silently
    // re-implements this trust boundary — pinned so the limit cannot vanish.
    const big = JSON.stringify({
      redirect_uris: ["https://example.com/cb"],
      client_name: "x".repeat(200_000),
    });
    const r = await request(app)
      .post("/oauth/register")
      .set("Content-Type", "application/json")
      .send(big);
    expect(r.status).toBe(413);
  });
});

// ── Token endpoint ───────────────────────────────────────────────────────────

describe("contract: token endpoint", () => {
  it("400 unsupported_grant_type for an unknown grant", async () => {
    const r = await request(app).post("/oauth/token").send({ grant_type: "password" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("unsupported_grant_type");
  });

  it("400 unsupported_grant_type for a missing grant_type", async () => {
    const r = await request(app).post("/oauth/token").send({});
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
      code: "x",
      redirect_uri: "http://localhost:9999/callback",
      client_id: "does-not-exist",
      code_verifier: "v",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_client");
  });

  it("400 invalid_grant for an unknown code on a known client", async () => {
    const clientId = await registerClient();
    const r = await request(app).post("/oauth/token").send({
      grant_type: "authorization_code",
      code: "not-a-real-code",
      redirect_uri: "http://localhost:9999/callback",
      client_id: clientId,
      code_verifier: "v",
    });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_grant");
  });

  it("400 invalid_request when refresh_token fields are missing", async () => {
    const r = await request(app).post("/oauth/token").send({ grant_type: "refresh_token" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_request");
  });

  it("400 invalid_grant for an unknown refresh_token", async () => {
    const r = await request(app)
      .post("/oauth/token")
      .send({ grant_type: "refresh_token", refresh_token: "nope", client_id: "nope" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_grant");
  });

  it("accepts an application/x-www-form-urlencoded body", async () => {
    // Several OAuth clients post form-encoded rather than JSON. The replacement
    // body reader must handle both content types.
    const r = await request(app).post("/oauth/token").type("form").send({ grant_type: "password" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("unsupported_grant_type");
  });
});

// ── Authorize + login UI ─────────────────────────────────────────────────────

describe("contract: authorize", () => {
  const validQuery = (clientId        ) =>
    `/oauth/authorize?response_type=code&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent("http://localhost:9999/callback")}` +
    `&state=st&code_challenge=chal&code_challenge_method=S256`;

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
      "/oauth/authorize?response_type=code&client_id=a" +
        `&redirect_uri=${encodeURIComponent("http://localhost:9999/callback")}` +
        "&state=s&code_challenge=c&code_challenge_method=plain"
    );
    expect(r.status).toBe(400);
  });

  it("400 for an unknown client_id", async () => {
    const r = await request(app).get(validQuery("unknown-client"));
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/Unknown client_id/);
  });

  it("400 when redirect_uri does not match the registered URIs", async () => {
    const clientId = await registerClient();
    const r = await request(app).get(
      `/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent("http://localhost:9999/other")}` +
        `&state=st&code_challenge=chal&code_challenge_method=S256`
    );
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/does not match/);
  });

  it("302-redirects a valid authorize to /login?req=<32 hex>", async () => {
    // The login flow hangs off this exact status + Location. A hand-rolled
    // redirect that returns 200-with-a-body, or omits Location, breaks login
    // with no useful client-side error.
    const clientId = await registerClient();
    const r = await request(app).get(validQuery(clientId));
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/^\/login\?req=[0-9a-f]{32}$/);
  });
});

describe("contract: login UI", () => {
  it("400 HTML for /login without a req id", async () => {
    const r = await request(app).get("/login");
    expect(r.status).toBe(400);
    expect(r.headers["content-type"]).toMatch(/html/);
  });

  it("400 HTML for /login with an expired req id", async () => {
    const r = await request(app).get("/login?req=deadbeefdeadbeefdeadbeefdeadbeef");
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/expired/i);
  });

  it("serves the login page for a live req id", async () => {
    const clientId = await registerClient();
    const auth = await request(app).get(
      `/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent("http://localhost:9999/callback")}` +
        `&state=st&code_challenge=chal&code_challenge_method=S256`
    );
    const reqId = new URL(auth.headers.location, "http://x").searchParams.get("req");
    const r = await request(app).get(`/login?req=${reqId}`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/html/);
    expect(r.text).toContain(reqId          );
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
    expect(r.body.error).toMatch(/request id/i);
  });

  it("400 JSON for POST /api/login without credentials", async () => {
    const r = await request(app).post("/api/login?req=abc").send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/required/i);
  });

  it("400 JSON for POST /api/login with an expired req id", async () => {
    const r = await request(app)
      .post("/api/login?req=deadbeefdeadbeefdeadbeefdeadbeef")
      .send({ email: "a@b.c", password: "p" });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/expired/i);
  });
});

// ── /stats gating ────────────────────────────────────────────────────────────

describe("contract: /stats gating", () => {
  it("404s when STATS_TOKEN is unset, so it is never accidentally public", async () => {
    // vitest.config.ts pins STATS_TOKEN="" so this does not depend on the
    // developer's .env. constants.ts reads it at module scope.
    const r = await request(app).get("/stats");
    expect(r.status).toBe(404);
  });
});

// ── Method dispatch ──────────────────────────────────────────────────────────

describe("contract: method dispatch", () => {
  // RECORDED against Express: an unlisted method on a known path falls through
  // the Router and lands on the 404 handler.
  //
  // PHASE 3 (#67) WILL CHANGE THESE TO 405. http-hash-router dispatches methods
  // through http-methods, which answers 405 for a path it knows with a method it
  // does not. That is more correct and no MCP client depends on the 404 — but it
  // is a real behavioural delta, so it is pinned here and amended deliberately
  // rather than discovered in production.
  const cases                          = [
    ["post", "/health"],
    ["put", "/health"],
    ["get", "/oauth/token"],
    ["get", "/oauth/register"],
  ];

  for (const [method, path] of cases) {
    it(`${method.toUpperCase()} ${path} -> 404 (Express falls through)`, async () => {
      const r = await (request(app)                                                                         )[method](path);
      expect(r.status).toBe(404);
    });
  }
});

// ── Trailing slashes ─────────────────────────────────────────────────────────

describe("contract: trailing slashes", () => {
  // RECORDED against Express: a Router mounted with app.use() matches BOTH the
  // bare and the slashed form, so every one of these currently serves.
  //
  // http-hash matches exact pathname segments and will 404 all of them. Phase 3
  // (#67) must therefore register both forms for every route below, or these
  // break silently for any client that appends a slash.
  const cases                          = [
    ["/health/", 200],
    ["/.well-known/oauth-authorization-server/", 200],
    ["/.well-known/oauth-protected-resource/", 200],
    ["/.well-known/oauth-protected-resource/mcp/", 200],
    ["/login/success/", 200],
    ["/login/", 400],
    ["/oauth/authorize/", 400],
    ["/stats/", 404],
  ];

  for (const [path, status] of cases) {
    it(`GET ${path} -> ${status}`, async () => {
      const r = await request(app).get(path);
      expect(r.status).toBe(status);
    });
  }

  it("POST /api/login/ -> 400", async () => {
    const r = await request(app).post("/api/login/").send({});
    expect(r.status).toBe(400);
  });
});
