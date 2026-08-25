import http from 'node:http'
import test from 'ava'
import request from 'supertest'
import esmock from 'esmock'

// sessionStore has a Redis path and an in-memory path. Only the in-memory one is
// exercised by the rest of the suite — and the Redis one is what production runs.
//
// The dev Redis is on 6380 (docker-compose.dev.yml); 6379 belongs to lincx-core's
// test stack, whose suite FLUSHALLs it.
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://default:localdev@localhost:6380'

// constants.js reads process.env at MODULE scope, so both of these have to be set
// before anything imports it — i.e. here, above the dynamic imports below, not
// inside a test.
process.env.REDIS_URL = REDIS_URL
process.env.USAGE_EVENT_CAP = '10'

// The store and the event sink each open their own ioredis client. Every one of
// them is closed in test.after.always — an open handle keeps the ava worker alive
// until the file times out, which reads as a failure with no failing assertion.
const clients = []
const closers = []

// Skipped unless a Redis is reachable — a local run without one still passes, but
// the skip is LOUD so it can never be mistaken for coverage.
//
// TEST_REDIS_REQUIRED=1 turns the skip into a failure. CI sets it alongside a
// redis service container: there, an unreachable Redis is a broken workflow, and
// silently passing would hand back a green run that covered nothing.
let available = false
test.before(async () => {
  const { Redis } = await import('ioredis')
  const r = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true, retryStrategy: () => null })
  try {
    await r.connect()
    await r.ping()
    available = true
  } catch (err) {
    if (process.env.TEST_REDIS_REQUIRED === '1') {
      throw new Error(`[redisIntegration] TEST_REDIS_REQUIRED=1 but no Redis at ${REDIS_URL}: ${err.message}`)
    }
    console.error(`[redisIntegration] SKIPPING — no Redis at ${REDIS_URL}: ${err.message}`)
  } finally {
    // Always disconnect: a client left retrying keeps the ava worker alive and the
    // whole file times out instead of reporting the skip.
    r.disconnect()
  }
})

/** A fresh sessionStore MODULE bound to the test Redis, registered for closing. */
async function storeModule (constants = {}) {
  const mod = await esmock('../services/sessionStore.js', { '../constants.js': constants })
  closers.push(mod.closeKvStore)
  return mod
}

/** A fresh sessionStore bound to the test Redis. */
async function store () {
  return (await storeModule()).getSessionStore()
}

/** /health over a real listener, bound to `storeMod` and the given environment. */
async function healthApp (storeMod, { isProduction }) {
  const { buildHealthHandler } = await esmock('../http/health.js', {
    '../services/sessionStore.js': storeMod,
    '../constants.js': { IS_PRODUCTION: isProduction }
  })
  const handler = buildHealthHandler()
  return http.createServer((req, res) => { handler(req, res) })
}

test.after.always(async () => {
  for (const c of clients) c.disconnect()
  for (const close of closers) await close()
})

test.serial('round-trips a session through Redis', async t => {
  if (!available) return t.pass('skipped — no Redis')
  const s = await store()
  await s.set('itest-1', {
    session_id: 'itest-1',
    user_id: 'u@example.com',
    email: 'u@example.com',
    auth_token: 'jwt-value',
    networks: [{ id: 'svce6t', name: 'Net' }],
    active_network: 'svce6t'
  })

  const back = await s.get('itest-1')
  t.is(back.email, 'u@example.com')
  t.is(back.active_network, 'svce6t')
  t.is(back.auth_token, 'jwt-value')

  await s.delete('itest-1')
  t.is(await s.get('itest-1'), null)
})

test.serial('a session key carries the 7-day TTL', async t => {
  if (!available) return t.pass('skipped — no Redis')
  const s = await store()
  const { Redis } = await import('ioredis')
  const r = new Redis(REDIS_URL)
  clients.push(r)

  await s.set('itest-ttl', {
    session_id: 'itest-ttl', user_id: 'x', email: 'x', auth_token: 't', networks: [], active_network: null
  })
  const ttl = await r.ttl('lincx:session:itest-ttl')
  // A key written with no TTL (-1) outlives its session forever; that is the
  // failure this catches, not the exact number.
  t.true(ttl > 0 && ttl <= 60 * 60 * 24 * 7, `expected a 7-day TTL, got ${ttl}`)

  await s.delete('itest-ttl')
  r.disconnect()
})

// ── /health over the Redis path ──────────────────────────────────────────────
// The rest of the /health coverage (src/tests/health.test.js) runs on the
// in-memory store, because ava sets REDIS_URL=''. These are the rows that need a
// real Redis: the one where the store is genuinely healthy, and the one where it
// is configured but not connected.

test.serial('probeStore reports redis before any session is stored', async t => {
  if (!available) return t.pass('skipped — no Redis')
  // No get/set has happened — the store is lazy, and /health establishing the
  // answer itself is the whole point on a fresh instance.
  const { probeStore } = await storeModule()
  t.deepEqual(await probeStore(), { store: 'redis', redis_ok: true })
})

test.serial('/health is ok in production when Redis answers', async t => {
  if (!available) return t.pass('skipped — no Redis')
  const app = await healthApp(await storeModule(), { isProduction: true })
  const r = await request(app).get('/health')
  t.is(r.status, 200)
  t.is(r.body.status, 'ok')
  t.is(r.body.store, 'redis')
  t.is(r.body.redis_ok, true)
})

test.serial('/health is degraded when Redis is configured but unreachable', async t => {
  // Deliberately NOT gated on `available` — this row needs the absence of a
  // Redis, so it runs everywhere. Port 1 is nothing, and `new Redis(url)` does
  // not throw on an unreachable host: reporting the store as healthy because
  // REDIS_URL was set is exactly the lie the PING exists to catch.
  const mod = await storeModule({ REDIS_URL: 'redis://127.0.0.1:1' })
  const app = await healthApp(mod, { isProduction: true })

  const started = Date.now()
  const r = await request(app).get('/health')
  const elapsed = Date.now() - started

  t.is(r.status, 200, 'must stay 200 — a non-200 gets the instance killed')
  t.is(r.body.status, 'degraded')
  t.is(r.body.store, 'redis')
  t.is(r.body.redis_ok, false)
  // Bounded: without the PING timeout a black-holed host never answers at all.
  // Tied to the constant, not a literal — a bound that outlives the timeout it
  // is meant to police proves nothing.
  const { REDIS_PING_TIMEOUT_MS } = await import('../constants.js')
  t.true(elapsed < REDIS_PING_TIMEOUT_MS + 2000, `probe took ${elapsed}ms`)

  // Close now rather than leaving it to test.after.always — the client retries
  // a refused connection, and each attempt logs an unhandled-error line.
  await mod.closeKvStore()
})

test.serial('the usage-event log is capped', async t => {
  if (!available) return t.pass('skipped — no Redis')
  const { getEventSink, closeEventSink } = await esmock('../services/usageAnalytics.js', {})
  closers.push(closeEventSink)
  const sink = await getEventSink()

  for (let i = 0; i < 25; i++) {
    await sink.append({ ts: Date.now(), type: 'tool', name: `t${i}`, status: 'ok', duration_ms: 1, response_chars: 1, params_keys: [] })
  }

  const events = await sink.readRecent(100)
  t.true(events.length <= 10, `cap not enforced: ${events.length} events retained`)
  // Newest first — the cap must drop the OLD end, not the new one.
  t.is(events[0].name, 't24')
})
