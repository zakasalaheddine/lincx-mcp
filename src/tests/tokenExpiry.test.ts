import { describe, it, expect } from "vitest";
import { getJwtExpiry, isJwtExpired } from "../services/auth.js";
import { validateSession } from "../services/sessionManager.js";
import { getSessionStore } from "../services/sessionStore.js";
import type { Session } from "../types.js";

// Build an unsigned-but-structurally-valid JWT (header.payload.sig) for testing.
const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (payload: object) => `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.sig`;

const NOW = 1_700_000_000_000; // fixed clock for determinism

describe("getJwtExpiry / isJwtExpired", () => {
  it("reads a numeric exp claim", () => {
    expect(getJwtExpiry(jwt({ exp: 1234 }))).toBe(1234);
  });

  it("returns null for non-JWTs and missing/invalid exp", () => {
    expect(getJwtExpiry("not-a-jwt")).toBeNull();
    expect(getJwtExpiry("a.b.c")).toBeNull();           // payload not JSON
    expect(getJwtExpiry(jwt({ sub: "x" }))).toBeNull(); // no exp
  });

  it("is expired only when exp has passed; fails open when unreadable", () => {
    expect(isJwtExpired(jwt({ exp: Math.floor(NOW / 1000) - 60 }), NOW)).toBe(true);
    expect(isJwtExpired(jwt({ exp: Math.floor(NOW / 1000) + 60 }), NOW)).toBe(false);
    expect(isJwtExpired("not-a-jwt", NOW)).toBe(false);  // fail open — let the API decide
  });
});

describe("validateSession token-expiry gate", () => {
  const baseSession = (token: string): Session => ({
    session_id: "s-expiry-test",
    user_id: "u@x.com",
    email: "u@x.com",
    auth_token: token,
    networks: [{ id: "net1", name: "Net One" }],
    active_network: "net1",
  });

  it("rejects an expired token with a clear re-login prompt before any network check", async () => {
    const store = await getSessionStore();
    const expired = jwt({ exp: Math.floor(Date.now() / 1000) - 10 });
    await store.set("s-expiry-test", baseSession(expired));

    const r = await validateSession("s-expiry-test");
    expect(r.valid).toBe(false);
    expect(r.error).toMatch(/expired/i);
    expect(r.error).toMatch(/auth_login/);
    await store.delete("s-expiry-test");
  });

  it("passes a still-valid (or expiry-less) token through to a valid session", async () => {
    const store = await getSessionStore();
    const fresh = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 });
    await store.set("s-expiry-test", baseSession(fresh));

    const r = await validateSession("s-expiry-test");
    expect(r.valid).toBe(true);
    expect(r.session?.active_network).toBe("net1");
    await store.delete("s-expiry-test");
  });
});
