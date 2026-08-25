/**
 * middleware/rateLimit.js — fixed-window rate limiting over an in-process Map.
 *
 * Replaces express-rate-limit. The counter is an in-process Map, which is only
 * correct while ONE instance serves everything. The transport is stateless now,
 * so lifting `manual_scaling: instances: 1` is a supported next step — and the
 * moment it is lifted the effective limit silently becomes N × the configured
 * one. Moving this to Redis is a prerequisite for raising the instance count,
 * not a follow-up to it.
 *
 * Three configs:
 *   loginLimiter   — POST /api/login — 10 req/min per client IP
 *   mcpIpLimiter   — POST /mcp       — 600 req/min per client IP, BEFORE auth
 *   mcpUserLimiter — POST /mcp       — 120 req/min per Lincx session, AFTER auth
 *
 * WHY /mcp NEEDS TWO TIERS — this has been wrong twice, so the reasoning lives
 * here rather than in a commit message:
 *
 *   - Keying only on `mcp-session-id` was a bypass: server-minted under the old
 *     stateful transport, caller-supplied under the stateless one, so rotating it
 *     per request buys unbounded fresh buckets.
 *   - Keying only on client IP starves users: claude.ai connectors egress from a
 *     shared address set, so one user paging a large result 429s every other
 *     claude.ai user of this server. Same behind any corporate NAT.
 *   - Keying only on the bearer is worse than either, because the limiter must
 *     run BEFORE the bearer is validated (it is what protects readBody and the
 *     Redis lookup from an unauthenticated flood). An attacker sending a fresh
 *     random bearer per request then mints a fresh bucket per request: no limit
 *     at all, plus unbounded key growth in this Map.
 *
 * So: a coarse IP tier runs first and bounds work by a key the caller cannot vary
 * (cardinality = distinct source addresses), and a fine per-user tier runs after
 * the bearer resolves, keyed on the LINCX SESSION ID — the resolved identity, not
 * the raw header. That last point matters: `Bearer x`, `bearer x` and `Bearer  x`
 * all authenticate as the same user (the parse is /^Bearer\s+(\S+)$/i), so
 * hashing the raw header hands one user three buckets.
 *
 * The IP ceiling deliberately sits well ABOVE the per-user one. It is a flood
 * guard, not the fairness control — set it too close and shared egress starves
 * users again, which is the bug it exists alongside, not one it should cause.
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

import { createHash } from 'node:crypto'

import { json } from '../http/respond.js'
import { clientIp } from '../http/request.js'

/**
 * @param maxKeys hard ceiling on tracked buckets. Reaching it means the key space
 *   is being driven by something other than real traffic; the whole window is
 *   dropped rather than letting the Map grow without bound.
 */
export function createLimiter ({ windowMs, limit, keyOf, message, maxKeys = 50_000 }) {
  const hits = new Map() // key -> { count, resetAt }
  const windowSeconds = Math.round(windowMs / 1000)
  let nextSweep = 0

  // Sweeping on EVERY request walks the whole Map every time, so a large key
  // space costs per request — an attacker who inflates the Map makes every
  // subsequent request slower, on a single-threaded process. Once per window is
  // enough: an expired entry is already treated as absent below.
  function sweep (now) {
    if (now < nextSweep) return
    nextSweep = now + windowMs
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k)
  }

  /**
   * @param cost how much of the budget this request consumes. One HTTP POST to
   *   /mcp can carry a JSON-RPC ARRAY, and the transport executes every message
   *   in it — measured at 500 tool executions from a single request that the
   *   limiter counted as 1. Callers that know the message count pass it.
   */
  function limiter (req, res, explicitKey, cost = 1) {
    const now = Date.now()
    sweep(now)

    const key = explicitKey ?? keyOf(req) ?? 'unknown'

    // A full Map means the key space is being driven by something other than real
    // traffic. An earlier cut called hits.clear() here, which wiped the FLOODER'S
    // OWN exhausted bucket along with everyone else's — reproduced at 20 served
    // against a configured limit of 10, repeating on every refill, so the limiter
    // stopped limiting exactly when it was needed.
    //
    // Reject the NEW key rather than resetting every established one: that costs
    // one unlucky caller a window instead of handing the flooder a fresh budget.
    //
    // Prune expired entries before rejecting — but only here at the ceiling,
    // never on the hot path. `sweep` is deliberately once-per-window because
    // walking the whole Map every request is itself the attack.
    //
    // The gap that closes: an entry created part-way through a window expires
    // part-way through the NEXT one, after that window's sweep has already gone
    // by, and keeps occupying `hits.size` until the sweep after that. Measured at
    // windowMs 1000 / maxKeys 50: 49 of 50 tracked buckets dead and a first-time
    // caller still got the ceiling 429.
    if (hits.size >= maxKeys && !hits.has(key)) {
      for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k)
    }
    if (hits.size >= maxKeys && !hits.has(key)) {
      console.error(`[RateLimit] key ceiling ${maxKeys} reached — rejecting new keys this window`)
      res.setHeader('Retry-After', String(windowSeconds))
      json(res, 429, message ?? { error: 'Too many requests.' })
      return false
    }

    let entry = hits.get(key)
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs }
      hits.set(key, entry)
    }
    entry.count += cost

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

  /**
   * Give back budget already counted for a request that a LATER gate rejected.
   *
   * Without this, /mcp's tier-2 (per-user) 429s still spent tier-1's shared
   * per-address budget: one user hammering their own 120/min cap burned the whole
   * 600/min address budget and starved every other caller behind the same egress
   * — measured with an innocent second user, zero prior requests, getting a 429.
   */
  limiter.refund = (req, explicitKey, cost = 1) => {
    const entry = hits.get(explicitKey ?? keyOf(req) ?? 'unknown')
    if (entry) entry.count = Math.max(0, entry.count - cost)
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

/** Bucket key for the pre-auth tier. Prefixed so it can never alias a user key. */
export const ipKey = (req) => 'ip:' + (clientIp(req) ?? 'unknown')

/**
 * Bucket key for the post-auth tier, from the RESOLVED Lincx session id.
 *
 * Hashed because this Map is process-global and a session id is the Redis key of
 * the record holding the Lincx JWT — a bucket key should never be something a
 * heap dump or a future debug log could use. Truncated because collisions across
 * 16 bytes are not a rate-limiting concern.
 *
 * Both exported for the tests that pin the key choice — it has been wrong twice.
 */
export const userKey = (lincxSessionId) =>
  'u:' + createHash('sha256').update(lincxSessionId).digest('hex').slice(0, 32)

/**
 * OAuth endpoints. `/oauth/register` is unauthenticated Dynamic Client
 * Registration and every call writes a 90-day `oauth:client:<id>` key; `/oauth/token`
 * is where a stolen code or refresh token would be exercised. Neither had any
 * limiter.
 */
export const oauthLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 30,
  keyOf: ipKey,
  message: { error: 'Too many OAuth requests — try again in a minute.' }
})

/** Pre-auth flood guard. Runs before readBody and before the bearer is resolved. */
export const mcpIpLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 600,
  keyOf: ipKey,
  message: { error: 'Rate limit exceeded for this address.' }
})

/** Per-user fairness control. Called with an explicit key once the bearer resolves. */
export const mcpUserLimiter = createLimiter({
  windowMs: 60 * 1000,
  limit: 120,
  keyOf: ipKey, // never reached — mcpPost always passes an explicit key
  message: { error: 'Rate limit exceeded.' }
})
