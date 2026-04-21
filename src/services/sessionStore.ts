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
