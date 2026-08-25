import test from 'ava'
import esmock from 'esmock'
import request from 'supertest'

import { start } from '../server.js'
import { buildContractApp } from './contract/buildApp.js'

// Tests that deliberately EXHAUST a module-global rate-limit budget.
//
// They live in their own file because ava runs files as separate processes, so a
// burnt budget cannot reach any other test. They previously sat at the bottom of
// other files behind a "LAST IN THE FILE" comment, which worked but failed badly:
// a contributor appending a test got an unexplained 429 on something unrelated to
// rate limiting and would reasonably hunt their own code first. Isolation is the
// mechanism; the comment was only a request.

/** A server that is torn down even when an assertion throws. */
async function serve (t) {
  const { server, port } = await start({ port: 0 })
  t.teardown(() => new Promise((resolve) => server.close(resolve)))
  return port
}

test.serial('a 429 still carries the OAuth discovery challenge', async t => {
  // CLAUDE.md § Deployment: /mcp must be able to answer an unauthenticated caller
  // with the RFC-9728 challenge — it is why a query-param access gate was
  // rejected. A bare 429 on the one endpoint that advertises resource_metadata is
  // the same failure: a fresh connector behind a busy shared egress could never
  // learn where to authenticate.
  const port = await serve(t)

  const post = () => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  })

  const first = await post()
  t.is(first.status, 401)
  t.regex(first.headers.get('www-authenticate') ?? '', /^Bearer resource_metadata="/)

  // Burn the address budget, then confirm the challenge survives the 429.
  let limited = null
  for (let i = 0; i < 700 && !limited; i++) {
    const r = await post()
    if (r.status === 429) limited = r
  }
  t.truthy(limited, 'the pre-auth tier never engaged')
  t.regex(limited.headers.get('www-authenticate') ?? '', /^Bearer resource_metadata="/,
    'a rate-limited caller was left with no way to discover OAuth')
})

test.serial('unauthenticated traffic hits the pre-auth rate limit tier', async t => {
  // The test above exhausts the same budget, which is why this one asserts bounds
  // rather than exact counts.
  //
  // The per-user tier is tighter (120 vs 600) so it always trips first for a
  // valid bearer, which means it cannot pin the PRE-AUTH call site — deleting
  // `if (!mcpIpLimiter(req, res)) return` left every other test green. This is
  // the tier that bounds what a caller with NO credential can force: a 100kb body
  // read, then a Redis lookup, per request.
  //
  // It has to live here rather than in mcpProtocol.test.js, which stubs
  // resolveLincxSessionFromBearer to accept any non-empty header — a forged
  // bearer authenticates there and never reaches the unauthenticated path.
  const port = await serve(t)

  const post = (i) => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      // Forged AND rotating: varying this must not mint a fresh bucket per
      // request, which is what keying the limiter on the raw bearer allowed.
      authorization: `Bearer forged-${i}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  })

  let challenged = 0
  let limited = 0
  for (let i = 0; i < 700; i++) {
    const r = await post(i)
    if (r.status === 401) challenged++
    else if (r.status === 429) limited++
  }

  t.true(limited > 0,
    'an unauthenticated caller rotating a forged bearer was never rate limited')
  t.true(challenged <= 600,
    `${challenged} unauthenticated requests were served before limiting — the cap is 600`)
  t.is(challenged + limited, 700, 'every request should be either challenged or limited')
})

test.serial('the per-account tier caps a single session at its limit', async t => {
  // mcpLimiterKey.test.js pins the KEY functions. Nothing pinned that mcpPost
  // CALLS them: deleting `if (!mcpUserLimiter(...)) return` left the suite green.
  //
  // esmock gives this its own module graph, so the limiter Map is fresh here and
  // the counts are exact. Requests go out in waves rather than one at a time —
  // 130 sequential POSTs, each building a fresh 40-tool McpServer, measured ~4.5s
  // and once hit 32s against ava's 30s inactivity cap.
  const { start: startMocked } = await esmock('../server.js', {}, {
    '../services/sessionManager.js': {
      resolveLincxSessionFromBearer: async (h) => (h ? 'lincx-test-session' : null),
      resolveUserBucket: async () => 'ratelimit@test.com',
      resolveLincxSession: async () => 'lincx-test-session',
      cachedLincxSession: () => 'lincx-test-session',
      validateSession: async () => ({
        valid: true,
        session: { session_id: 'lincx-test-session', email: 'a@b.c', active_network: 'svce6t', networks: [] }
      })
    }
  })
  const { server, port } = await startMocked({ port: 0 })
  t.teardown(() => new Promise((resolve) => server.close(resolve)))

  const post = () => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: 'Bearer test-token'
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  }).then((r) => r.status)

  const statuses = []
  for (let wave = 0; wave < 13; wave++) {
    statuses.push(...await Promise.all(Array.from({ length: 10 }, post)))
  }

  t.is(statuses.filter((s) => s === 200).length, 120, 'the per-account tier must cap at its limit')
  t.is(statuses.filter((s) => s === 429).length, 10, 'requests past the cap must be 429, not served')
})

test.serial('/oauth/register is rate limited', async t => {
  // Dynamic Client Registration is unauthenticated and every accepted call writes
  // a 90-day `oauth:client:<id>` key. It had no limiter at all, and neither did
  // /oauth/token or /oauth/authorize. Each has its own bucket now — see the
  // sharing test below.
  const app = buildContractApp().listen(0)
  t.teardown(() => new Promise((resolve) => app.close(resolve)))

  // Two addresses: burning one must not touch the other, or the limiter is one
  // global bucket and a single flooder locks every client out of registration.
  // supertest connects over loopback, so vary the trusted XFF hop instead.
  const from = (ip) => request(app)
    .post('/oauth/register')
    .set('X-Forwarded-For', `10.0.0.1, ${ip}`)
    .send({ redirect_uris: ['http://localhost:9999/cb'], client_name: 'flood' })

  let limited = 0
  for (let i = 0; i < 40; i++) {
    if ((await from('203.0.113.10')).status === 429) limited++
  }
  t.true(limited > 0, '/oauth/register accepted 40 unauthenticated registrations in a minute')

  const other = await from('203.0.113.99')
  t.not(other.status, 429,
    'a second address was locked out by the first — the OAuth limiter is one global bucket')
})

test.serial('the OAuth endpoints do not share one budget', async t => {
  // They used to: one 30/min per-address bucket covered /oauth/register and
  // /oauth/token together. That is the cross-endpoint starvation the two-tier
  // reasoning in rateLimit.js exists to avoid, one level up — a DCR flood, or ~30
  // claude.ai users refreshing in the same minute behind one shared egress, 429s
  // token refresh and the login page for everybody at that address.
  const app = buildContractApp().listen(0)
  t.teardown(() => new Promise((resolve) => app.close(resolve)))

  const ip = '203.0.113.42'
  const xff = `10.0.0.1, ${ip}`

  // Burn the registration budget from one address.
  let registerLimited = 0
  for (let i = 0; i < 15; i++) {
    const r = await request(app)
      .post('/oauth/register')
      .set('X-Forwarded-For', xff)
      .send({ redirect_uris: ['http://localhost:9999/cb'], client_name: 'flood' })
    if (r.status === 429) registerLimited++
  }
  t.true(registerLimited > 0, 'baseline: /oauth/register is exhausted for this address')

  // The other two must still answer the SAME address on their own merits.
  const tok = await request(app)
    .post('/oauth/token').set('X-Forwarded-For', xff)
    .type('form').send({ grant_type: 'refresh_token', refresh_token: 'nope', client_id: 'x' })
  t.not(tok.status, 429, 'a DCR flood locked this address out of token refresh')

  const auth = await request(app)
    .get('/oauth/authorize').set('X-Forwarded-For', xff).query({ response_type: 'code' })
  t.not(auth.status, 429, 'a DCR flood locked this address out of the login page')
})

test.serial('GET /oauth/authorize is rate limited', async t => {
  // Unauthenticated, and every request writes a 10-min `oauth:pending:<id>`. It
  // was the one Redis-writing endpoint with no limiter.
  const app = buildContractApp().listen(0)
  t.teardown(() => new Promise((resolve) => app.close(resolve)))

  let limited = 0
  for (let i = 0; i < 130; i++) {
    const r = await request(app)
      .get('/oauth/authorize')
      .set('X-Forwarded-For', '10.0.0.1, 203.0.113.77')
      .query({ response_type: 'code' })
    if (r.status === 429) limited++
  }
  t.true(limited > 0, 'GET /oauth/authorize accepted 130 unauthenticated requests in a minute')
})

test.serial('POST /api/login is rate limited', async t => {
  // The brute-force guard on the credential endpoint. Removing
  // `if (!loginLimiter(req, res)) return` from routes/login.js left the whole
  // suite green.
  const app = buildContractApp().listen(0)
  t.teardown(() => new Promise((resolve) => app.close(resolve)))

  let limited = 0
  for (let i = 0; i < 14; i++) {
    const r = await request(app).post('/api/login').send({ email: 'a@b.c', password: 'x' })
    if (r.status === 429) limited++
  }
  t.true(limited > 0, 'POST /api/login accepted 14 attempts in a minute')
})

test.serial('one account burning its own cap does not starve others behind the same address', async t => {
  // /mcp spends the shared per-address budget BEFORE it can know who is calling,
  // so without a refund every tier-2 rejection still costs tier-1 a slot. Measured
  // before the fix: user A sent 605 requests, 486 of them already 429s from their
  // own per-account cap, and an innocent user B with ZERO prior requests got a 429.
  //
  // That is round two's shared-egress starvation in a narrower form — claude.ai
  // connectors all egress from one address set, so "behind the same address" is
  // the normal case, not an edge one.
  const { start: startMocked } = await esmock('../server.js', {}, {
    '../services/sessionManager.js': {
      // Identity comes from the bearer, so A and B are distinct accounts on one address.
      resolveLincxSessionFromBearer: async (h) => (h ? `lincx-${h.split(' ')[1]}` : null),
      resolveUserBucket: async (id) => `${id}@test.com`,
      resolveLincxSession: async () => 'lincx-test-session',
      cachedLincxSession: () => 'lincx-test-session',
      validateSession: async () => ({
        valid: true,
        session: { session_id: 'lincx-test-session', email: 'a@b.c', active_network: 'svce6t', networks: [] }
      })
    }
  })
  const { server, port } = await startMocked({ port: 0 })
  t.teardown(() => new Promise((resolve) => server.close(resolve)))

  const post = (who) => fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${who}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  }).then((r) => r.status)

  // A blows through their own 120/min and keeps hammering, well past the 600/min
  // address budget. Every rejection past 120 must be refunded to tier 1.
  for (let wave = 0; wave < 70; wave++) {
    await Promise.all(Array.from({ length: 10 }, () => post('userA')))
  }

  // B has made no requests at all.
  t.is(await post('userB'), 200,
    'an innocent account behind the same address was starved by another account hitting its own cap')
})
