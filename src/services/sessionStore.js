/**
 * services/sessionStore.js
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

import { REDIS_URL, SESSION_TTL_SECONDS, MEMORY_SWEEP_INTERVAL_MS } from '../constants.js'

let _kv = null
let _redis = null

export async function getKvStore () {
  if (_kv) return _kv

  if (REDIS_URL) {
    const { Redis } = await import('ioredis')
    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 })
    _redis = redis
    _kv = {
      async get (key) { return await redis.get(key) },
      async set (key, value, ttl) { await redis.setex(key, ttl, value) },
      async delete (key) { await redis.del(key) }
    }
    console.error('[SessionStore] Using Redis')
  } else {
    const mem = new Map()
    _kv = {
      async get (key) {
        const e = mem.get(key)
        if (!e) return null
        if (Date.now() > e.expiresAt) { mem.delete(key); return null }
        return e.value
      },
      async set (key, value, ttl) {
        mem.set(key, { value, expiresAt: Date.now() + ttl * 1000 })
      },
      async delete (key) { mem.delete(key) }
    }

    // Periodic sweep — proactively evict entries past their TTL so memory doesn't
    // grow with abandoned sessions. unref() keeps this from holding the process open.
    const sweep = setInterval(() => {
      const now = Date.now()
      let evicted = 0
      for (const [key, entry] of mem) {
        if (now > entry.expiresAt) { mem.delete(key); evicted++ }
      }
      if (evicted > 0) {
        console.error(`[SessionStore] Swept ${evicted} expired entr${evicted === 1 ? 'y' : 'ies'} (${mem.size} remaining)`)
      }
    }, MEMORY_SWEEP_INTERVAL_MS)
    sweep.unref?.()

    console.error('[SessionStore] No REDIS_URL — using in-memory store (dev only); sweeping expired entries every ' + Math.round(MEMORY_SWEEP_INTERVAL_MS / 1000) + 's')
  }

  return _kv
}

/**
 * Close the Redis connection and forget the cached store.
 *
 * A long-lived server never needs this, but an open ioredis handle keeps a test
 * worker (and a GAE instance handling /_ah/stop) alive with nothing left to do.
 */
export async function closeKvStore () {
  if (_redis) {
    _redis.disconnect()
    _redis = null
  }
  _kv = null
}

// ── Typed Lincx-session accessors (backwards-compat façade) ───────────────

const LINCX_PREFIX = 'lincx:session:'

export async function getSessionStore () {
  const kv = await getKvStore()
  return {
    async get (id) {
      const raw = await kv.get(LINCX_PREFIX + id)
      if (!raw) return null
      try { return JSON.parse(raw) } catch { return null }
    },
    async set (id, session) {
      await kv.set(LINCX_PREFIX + id, JSON.stringify(session), SESSION_TTL_SECONDS)
    },
    async delete (id) {
      await kv.delete(LINCX_PREFIX + id)
    }
  }
}
