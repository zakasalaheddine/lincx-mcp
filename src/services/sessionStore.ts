/**
 * services/sessionStore.ts
 *
 * Redis or in-memory session persistence.
 * When REDIS_URL is set, uses Redis with TTL; otherwise uses an in-memory Map.
 */

import { Redis } from "ioredis";
import type { Session } from "../types.js";
import { REDIS_URL, SESSION_TTL_SECONDS } from "../constants.js";

const KEY_PREFIX = "mcp:session:";

export interface SessionStore {
  get(sessionId: string): Promise<Session | null>;
  set(sessionId: string, session: Session): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

let storeInstance: SessionStore | null = null;

export async function getSessionStore(): Promise<SessionStore> {
  if (storeInstance) return storeInstance;

  if (REDIS_URL) {
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });
    storeInstance = {
      async get(sessionId: string): Promise<Session | null> {
        const raw = await redis.get(KEY_PREFIX + sessionId);
        if (!raw) return null;
        try {
          return JSON.parse(raw) as Session;
        } catch {
          return null;
        }
      },
      async set(sessionId: string, session: Session): Promise<void> {
        await redis.setex(
          KEY_PREFIX + sessionId,
          SESSION_TTL_SECONDS,
          JSON.stringify(session)
        );
      },
      async delete(sessionId: string): Promise<void> {
        await redis.del(KEY_PREFIX + sessionId);
      },
    };
  } else {
    const memory = new Map<string, { session: Session; expiresAt: number }>();
    const ttlMs = SESSION_TTL_SECONDS * 1000;
    storeInstance = {
      async get(sessionId: string): Promise<Session | null> {
        const entry = memory.get(sessionId);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
          memory.delete(sessionId);
          return null;
        }
        return entry.session;
      },
      async set(sessionId: string, session: Session): Promise<void> {
        memory.set(sessionId, {
          session,
          expiresAt: Date.now() + ttlMs,
        });
      },
      async delete(sessionId: string): Promise<void> {
        memory.delete(sessionId);
      },
    };
  }

  return storeInstance;
}
