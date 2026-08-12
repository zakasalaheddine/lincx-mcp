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
 * Header format is draft-7 COMBINED, byte-for-byte what express-rate-limit was
 * emitting (measured against the running Express server before the swap):
 *   RateLimit-Policy: 120;w=60
 *   RateLimit: limit=120, remaining=119, reset=60
 *   Retry-After: 60          (429 only)
 * Draft-6's separate RateLimit-Limit / -Remaining / -Reset headers are NOT what
 * this server sent, and a client parsing the combined form would break on them.
 *
 * ponytail: fixed window, not sliding — a burst can straddle a boundary and
 * briefly allow 2x. Acceptable for abuse damping. Move to a sliding log if the
 * limit ever becomes a correctness boundary rather than a courtesy one.
 */

import { json } from '../http/respond.js'
import { header, clientIp } from '../http/request.js'

export function createLimiter ({ windowMs, limit, keyOf, message }) {
  const hits = new Map() // key -> { count, resetAt }
  const windowSeconds = Math.round(windowMs / 1000)

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

    res.setHeader('RateLimit-Policy', `${limit};w=${windowSeconds}`)
    res.setHeader('RateLimit', `limit=${limit}, remaining=${remaining}, reset=${resetSeconds}`)

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
