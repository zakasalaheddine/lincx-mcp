/* eslint-disable camelcase -- OAuth params and Work API / tool-output fields are snake_case on the wire: protocol, not style. */
/**
 * services/usageAnalytics.js
 *
 * In-house usage analytics. Every tool call / resource read becomes one
 * UsageEvent in a capped log (Redis list, or in-memory ring buffer in dev).
 * GET /stats computes aggregates on read via computeStats().
 *
 * PRIVACY INVARIANTS (hard):
 *   - never store auth_token / OAuth tokens
 *   - never store parameter VALUES — only Object.keys(params)
 *   - never store raw error messages — only the classified error_kind
 *   - never store a raw session id — `lincx:session:<id>` is the Redis key of the
 *     record holding the Lincx JWT, and this list has NO TTL (LPUSH + LTRIM) on
 *     the SAME Redis instance, so a raw id here outlives the 7-day session it
 *     points at. recordEventAsync resolves the user from it and then stores only
 *     `session_key`, a hash. computeStats never needs to look one up, only to
 *     tell rows apart.
 *   - user_id / email are stored deliberately (adoption analysis), never sent to the model
 *
 * All logging here uses console.error (stderr), never console.log (project rule).
 */

import { createHash } from 'node:crypto'

import { REDIS_URL, USAGE_EVENT_CAP } from '../constants.js'
import { getSessionStore } from './sessionStore.js'

/**
 * Stable, non-reversible stand-in for a Lincx session id.
 *
 * Applied at RECORD time, so no raw session id ever reaches Redis or /stats. A
 * previous cut hashed only the /stats response and left the stored form raw,
 * enforcing the invariant on the read surface and breaking it on the write one.
 */
export const sessionKey = (lincxSessionId) =>
  's:' + createHash('sha256').update(lincxSessionId).digest('hex').slice(0, 12)

/** Classify an error message string into a small fixed enum (never stored raw). */
export function classifyErrorKind (text) {
  if (/Not authenticated/i.test(text)) return 'not_authenticated'
  if (/expired/i.test(text)) return 'auth_expired'
  if (/response_too_large/.test(text)) return 'response_too_large'
  if (/timed out/i.test(text)) return 'timeout'
  if (/Bad request|Unprocessable/i.test(text)) return 'bad_params'
  if (/Unauthorized|Forbidden|not found|Rate limit/i.test(text)) return 'work_api_4xx'
  if (/server error/i.test(text)) return 'work_api_5xx'
  return 'other'
}

/**
 * Inspect an MCP tool/resource result for failure. Tools mostly RETURN errors as
 * `{ content: [{ text: "Error: ..." }] }` (not throws), and the oversized guard
 * sets isError — both count as errors here.
 */
export function classifyResult (result) {
  const r = result
  const text = r?.content?.[0]?.text ?? ''
  const isErr = r?.isError === true || text.startsWith('Error:')
  if (!isErr) return { status: 'ok' }
  return { status: 'error', error_kind: classifyErrorKind(text) }
}

// ── EventSink ─────────────────────────────────────────────────────────────────

;

const EVENTS_KEY = 'usage:events'
let _sinkP = null
let _sinkRedis = null

export function getEventSink () {
  if (_sinkP) return _sinkP
  _sinkP = (async () => {
    if (REDIS_URL) {
      const { Redis } = await import('ioredis')
      const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 })
      _sinkRedis = redis
      console.error('[Analytics] Using Redis event log')
      return {
        async append (event) {
          await redis.lpush(EVENTS_KEY, JSON.stringify(event))
          await redis.ltrim(EVENTS_KEY, 0, USAGE_EVENT_CAP - 1)
        },
        async readRecent (limit) {
          const raw = await redis.lrange(EVENTS_KEY, 0, Math.max(0, limit - 1))
          return raw.map((r) => JSON.parse(r))
        }
      }
    }
    const buf = [] // newest at index 0
    console.error('[Analytics] No REDIS_URL — using in-memory event log (dev only)')
    return {
      async append (event) {
        buf.unshift(event)
        if (buf.length > USAGE_EVENT_CAP) buf.length = USAGE_EVENT_CAP
      },
      async readRecent (limit) {
        return buf.slice(0, limit)
      }
    }
  })()
  return _sinkP
}

/** Close the event log's Redis connection — see closeKvStore() in sessionStore.js. */
export async function closeEventSink () {
  if (_sinkRedis) {
    _sinkRedis.disconnect()
    _sinkRedis = null
  }
  _sinkP = null
}

// ── recordEvent ───────────────────────────────────────────────────────────────

;

/** Awaitable core — used by tests and by the fire-and-forget recordEvent. */
export async function recordEventAsync (input) {
  try {
    // The raw id is used HERE and never stored — see the privacy invariants above.
    const { lincx_session_id: rawSessionId, ...rest } = input
    let user_id
    let email
    if (rawSessionId) {
      const session = await (await getSessionStore()).get(rawSessionId)
      user_id = session?.user_id
      email = session?.email
    }
    const event = {
      ts: Date.now(),
      ...rest,
      session_key: rawSessionId ? sessionKey(rawSessionId) : undefined,
      user_id,
      email
    }
    const sink = await getEventSink()
    await sink.append(event)
  } catch (err) {
    // Analytics must NEVER affect a tool call. Swallow (one stderr line).
    console.error('[Analytics] recordEvent failed:', err instanceof Error ? err.message : String(err))
  }
}

/** Fire-and-forget wrapper — callers must NOT await this. */
export function recordEvent (input) {
  // eslint-disable-next-line no-void -- `void` is the marker that this promise is deliberately not awaited
  void recordEventAsync(input)
}

// ── computeStats ──────────────────────────────────────────────────────────────

;

function percentile (sortedAsc, p) {
  if (sortedAsc.length === 0) return 0
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1))
  return sortedAsc[idx]
}

export function computeStats (events) {
  // ── tools ──
  const byTool = new Map()
  for (const e of events) {
    const t = byTool.get(e.name) ?? { type: e.type, calls: 0, errors: 0, durations: [], chars: 0 }
    t.calls++; if (e.status === 'error') t.errors++
    t.durations.push(e.duration_ms); t.chars += e.response_chars
    byTool.set(e.name, t)
  }
  const tools = [...byTool.entries()].map(([name, t]) => {
    const sorted = [...t.durations].sort((a, b) => a - b)
    return {
      name,
      type: t.type,
      calls: t.calls,
      errors: t.errors,
      error_rate: t.calls ? Math.round((t.errors / t.calls) * 100) / 100 : 0,
      p50_ms: percentile(sorted, 50),
      p95_ms: percentile(sorted, 95),
      avg_chars: t.calls ? Math.round(t.chars / t.calls) : 0
    }
  }).sort((a, b) => b.calls - a.calls)

  // ── users ──
  const byUser = new Map()
  for (const e of events) {
    if (!e.user_id) continue
    const u = byUser.get(e.user_id) ?? { email: e.email, calls: 0, tools: new Set(), first: e.ts, last: e.ts }
    u.calls++; u.tools.add(e.name); u.first = Math.min(u.first, e.ts); u.last = Math.max(u.last, e.ts)
    byUser.set(e.user_id, u)
  }
  const users = [...byUser.entries()].map(([user_id, u]) => ({
    user_id, email: u.email, calls: u.calls, distinct_tools: u.tools.size, first_seen: u.first, last_seen: u.last
  })).sort((a, b) => b.calls - a.calls)

  // ── errors ──
  const byErr = new Map()
  for (const e of events) {
    if (e.status !== 'error' || !e.error_kind) continue
    const x = byErr.get(e.error_kind) ?? { count: 0, sample_tool: e.name }
    x.count++; byErr.set(e.error_kind, x)
  }
  const errors = [...byErr.entries()].map(([kind, x]) => ({ kind, count: x.count, sample_tool: x.sample_tool }))
    .sort((a, b) => b.count - a.count)

  // ── sequences (group by session, chronological) ──
  //
  // `mcp_session_id` is the pre-stateless key — kept as a fallback so events
  // recorded before the transport went stateless still group until they age out
  // of the capped log.
  //
  // NOTE the grain changed with the key. `mcp_session_id` was one MCP connection
  // ≈ one conversation; `lincx_session_id` is a 7-day login, so a row now spans
  // every conversation that user had in the window and `transitions` bridges the
  // gaps between them. Read `recent[].tools` as "what this user did this week",
  // not "what happened in one chat".
  const bySession = new Map()
  for (const e of events) {
    // `session_key` is already hashed at record time. `mcp_session_id` is the
    // pre-stateless field and was stored RAW, so it gets hashed here — otherwise
    // the response would keep echoing resolvable ids until those events age out.
    const key = e.session_key ?? (e.mcp_session_id ? sessionKey(e.mcp_session_id) : null)
    if (!key) continue
    const arr = bySession.get(key) ?? []
    arr.push(e); bySession.set(key, arr)
  }
  const transitions = {}
  const recent = []
  for (const [session, arr] of bySession) {
    arr.sort((a, b) => a.ts - b.ts)
    const toolNames = arr.map((e) => e.name)
    for (let i = 1; i < toolNames.length; i++) {
      const key = `${toolNames[i - 1]}>${toolNames[i]}`
      transitions[key] = (transitions[key] ?? 0) + 1
    }
    // `session` is already a hash — recordEventAsync never stored the raw id.
    //
    // To be precise about what that buys: this is a CAPABILITY control, not an
    // anonymity one. `users[]` below carries user_id AND email, and every row here
    // carries user_id, so nothing about a reader's ability to attribute activity
    // changes. What it prevents is /stats — and the event log behind it — handing
    // anyone a directly usable Redis key.
    //
    // tools is capped because the key change made it unbounded: a heavy user's
    // whole week used to be many short rows and is now one long one.
    recent.push({
      // Emitted, not just sorted on: the response carries no resolvable session
      // id, so this is the only way a reader can tell how recent a row is.
      last_ts: arr.at(-1).ts,
      session,
      user_id: arr[0].user_id,
      tools: toolNames.slice(-200),
      tools_total: toolNames.length
    })
  }
  // Sort on the events themselves — `recent[].session` is hashed now, so it can
  // no longer be used to look the group back up.
  recent.sort((a, b) => b.last_ts - a.last_ts)

  let oldest = Infinity
  let newest = -Infinity
  for (const e of events) {
    if (e.ts < oldest) oldest = e.ts
    if (e.ts > newest) newest = e.ts
  }

  return {
    window: { events: events.length, oldest_ts: events.length ? oldest : 0, newest_ts: events.length ? newest : 0 },
    tools,
    users,
    errors,
    sequences: { recent: recent.slice(0, 50), transitions }
  }
}
