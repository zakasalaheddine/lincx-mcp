/**
 * services/sessionStore.ts
 *
 * Thin key-value store for sessions.
 * Uses Redis when REDIS_URL is set, otherwise falls back to an
 * in-memory Map with TTL — good for local dev, NOT for production.
 */

import type { Session } from "../types.js";
import { REDIS_URL, SESSION_TTL_SECONDS } from "../constants.js";

const KEY_PREFIX = "lincx:session:";

export interface SessionStore {
  get(sessionId: string): Promise<Session | null>;
  set(sessionId: string, session: Session): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

// Lazily-initialized singleton
let _store: SessionStore | null = null;

export async function getSessionStore(): Promise<SessionStore> {
  if (_store) return _store;

  if (REDIS_URL) {
    const { Redis } = await import("ioredis");
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });

    _store = {
      async get(id) {
        const raw = await redis.get(KEY_PREFIX + id);
        if (!raw) return null;
        try { return JSON.parse(raw) as Session; } catch { return null; }
      },
      async set(id, session) {
        await redis.setex(KEY_PREFIX + id, SESSION_TTL_SECONDS, JSON.stringify(session));
      },
      async delete(id) {
        await redis.del(KEY_PREFIX + id);
      },
    };

    console.log("[SessionStore] Using Redis:", REDIS_URL);
  } else {
    const ttlMs = SESSION_TTL_SECONDS * 1000;
    const map = new Map<string, { session: Session; expiresAt: number }>();

    _store = {
      async get(id) {
        const entry = map.get(id);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) { map.delete(id); return null; }
        return entry.session;
      },
      async set(id, session) {
        map.set(id, { session, expiresAt: Date.now() + ttlMs });
      },
      async delete(id) {
        map.delete(id);
      },
    };

    console.warn("[SessionStore] No REDIS_URL — using in-memory store (not for production)");
  }

  return _store;
}
