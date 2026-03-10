/**
 * services/sessionStore.ts
 *
 * Thin key-value store for sessions.
 * Uses Redis when REDIS_URL is set, otherwise falls back to an
 * in-memory Map with TTL — good for local dev, NOT for production.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "../types.js";
import { REDIS_URL, SESSION_TTL_SECONDS } from "../constants.js";

const KEY_PREFIX = "lincx:session:";
const DEV_SESSION_DIR = join(process.cwd(), ".sessions");
const DEV_SESSION_FILE = join(DEV_SESSION_DIR, "store.json");

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

    console.error("[SessionStore] Using Redis:", REDIS_URL);
  } else {
    const ttlMs = SESSION_TTL_SECONDS * 1000;

    // File-backed store — survives dev server restarts
    type StoreData = Record<string, { session: Session; expiresAt: number }>;

    function loadFromDisk(): StoreData {
      try {
        const raw = readFileSync(DEV_SESSION_FILE, "utf-8");
        return JSON.parse(raw) as StoreData;
      } catch { return {}; }
    }

    function saveToDisk(data: StoreData): void {
      try {
        mkdirSync(DEV_SESSION_DIR, { recursive: true });
        writeFileSync(DEV_SESSION_FILE, JSON.stringify(data, null, 2));
      } catch (err) {
        console.error("[SessionStore] Failed to write session file:", err);
      }
    }

    _store = {
      async get(id) {
        const data = loadFromDisk();
        const entry = data[id];
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) { delete data[id]; saveToDisk(data); return null; }
        return entry.session;
      },
      async set(id, session) {
        const data = loadFromDisk();
        data[id] = { session, expiresAt: Date.now() + ttlMs };
        saveToDisk(data);
      },
      async delete(id) {
        const data = loadFromDisk();
        delete data[id];
        saveToDisk(data);
      },
    };

    console.error("[SessionStore] No REDIS_URL — using file-backed store at .sessions/store.json");
  }

  return _store;
}