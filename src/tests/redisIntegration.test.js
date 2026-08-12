import test from 'ava'
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

// Skipped unless a Redis is reachable — CI without one still passes, but the skip
// is LOUD so it can never be mistaken for coverage.
let available = false
test.before(async () => {
  const { Redis } = await import('ioredis')
  const r = new Redis(REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 1500, lazyConnect: true, retryStrategy: () => null })
  try {
    await r.connect()
    await r.ping()
    available = true
  } catch (err) {
    console.error(`[redisIntegration] SKIPPING — no Redis at ${REDIS_URL}: ${err.message}`)
  } finally {
    // Always disconnect: a client left retrying keeps the ava worker alive and the
    // whole file times out instead of reporting the skip.
    r.disconnect()
  }
})

/** A fresh sessionStore module bound to the test Redis. */
async function store () {
  const mod = await esmock('../services/sessionStore.js', {})
  closers.push(mod.closeKvStore)
  return mod.getSessionStore()
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
