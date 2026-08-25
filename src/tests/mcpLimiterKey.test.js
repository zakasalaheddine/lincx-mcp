import test from 'ava'

import { createLimiter, mcpIpLimiter, mcpUserLimiter, ipKey, userKey } from '../middleware/rateLimit.js'

// rateLimit.test.js exercises createLimiter with an injected keyOf, so no real key
// function is ever executed by a test. The KEY is the whole security property
// here, and it has been wrong in three different directions already:
//
//   mcp-session-id — client-supplied under the stateless transport, so rotating
//                    it per request buys unbounded fresh buckets (full bypass)
//   client IP      — claude.ai connectors share an egress address set, so every
//                    claude.ai user of this server lands in ONE window
//   hashed bearer  — the limiter must run BEFORE the bearer is validated, so an
//                    unauthenticated caller sending a fresh random bearer per
//                    request mints a fresh bucket per request: no limit at all,
//                    plus unbounded growth in the key Map
//
// All three mutations pass the entire suite without this file.
//
// NOTE the call sites are pinned elsewhere (mcpProtocol.test.js for /mcp,
// contract/http.test.js for /api/login). A previous cut of this file tested only
// the key functions, which left `if (!mcpLimiter(req, res)) return` deletable from
// mcpPost with the suite fully green — a file added to cover the rate limiter,
// covering none of it.

/** Minimal req/res doubles — the limiter only reads headers and writes a 429. */
const req = (headers) => ({ headers, socket: { remoteAddress: '10.0.0.1' } })

function res () {
  return {
    headersSent: false,
    statusCode: 0,
    _headers: {},
    setHeader (k, v) { this._headers[k] = v },
    writeHead (code) { this.statusCode = code; return this },
    end () { this.headersSent = true }
  }
}

/** Requests the per-user tier allows for one session id. */
function allowedForUser (lincxSessionId, attempts = 200) {
  let ok = 0
  for (let i = 0; i < attempts; i++) {
    if (mcpUserLimiter(req({}), res(), userKey(lincxSessionId))) ok++
  }
  return ok
}

/** Requests the pre-auth tier allows for one set of headers. */
function allowedForIp (headers, attempts = 800) {
  let ok = 0
  for (let i = 0; i < attempts; i++) if (mcpIpLimiter(req(headers), res())) ok++
  return ok
}

test.serial('two users behind ONE shared IP get separate per-user budgets', t => {
  // The claude.ai case: same egress address, different people. Exhausting one
  // must not touch the other.
  t.is(allowedForUser('lincx-user-a'), 120, 'first user should get the full window')
  t.is(allowedForUser('lincx-user-b'), 120, 'a second user was starved by the first')
})

test.serial('the per-account key is derived, never taken from the request', t => {
  // `Bearer x`, `bearer x` and `Bearer  x` all authenticate as the same user —
  // the parse is /^Bearer\s+(\S+)$/i. Keying on the raw header therefore handed
  // one user a fresh bucket per spelling. Keying on a value the server DERIVES
  // makes the question unaskable, which is the point.
  //
  // What gets passed in is the ACCOUNT (user_id), not the session id — an earlier
  // version of this test asserted the session-id behaviour and so pinned the bug:
  // createSession mints a fresh UUID per login, so N logins bought N x the budget.
  // `resolveUserBucket` is what turns a session into an account, and that is
  // pinned end to end in bearerIdentity.test.js.
  t.is(userKey('user@example.com'), userKey('user@example.com'), 'the key must be stable for one account')
  t.not(userKey('user@example.com'), userKey('other@example.com'), 'distinct accounts must not collide')
})

test.serial('no bucket key is ever a usable credential or Redis key', t => {
  // Keys live in a process-global Map that a heap dump or a future debug log
  // would expose. A session id is the key of the record holding the Lincx JWT.
  const sessionId = 'lincx-secret-session'
  t.false(userKey(sessionId).includes(sessionId), 'raw session id used as a bucket key')
  t.true(userKey(sessionId).startsWith('u:'))

  // The two tiers must not be able to alias each other: an IP that happens to
  // look like a user key must still land in its own namespace.
  t.true(ipKey(req({ 'x-forwarded-for': 'u:deadbeef' })).startsWith('ip:'))
})

test.serial('the pre-auth tier cannot be split by anything the caller controls', t => {
  // Two attack surfaces, and the first version of this test rotated the wrong one.
  //
  // It varied `Authorization` (never the pre-auth key) while holding
  // `x-forwarded-for` CONSTANT — the value that IS the key and that a caller can
  // choose. Measured at HEAD: rotating XFF took 700/700 against a 600 cap, and
  // 40/40 against the 10/min brute-force guard on POST /api/login. The test that
  // existed to prove the key was unsplittable pinned the wrong header.
  //
  // The deployment premise is one trusted proxy that APPENDS the real client
  // address, so a forged first hop is followed by the truth. Vary the forged hop,
  // hold the appended one fixed: every request must land in one bucket.
  const proxied = (forged) => ({ 'x-forwarded-for': `${forged}, 198.51.100.99` })

  let ok = 0
  for (let i = 0; i < 800; i++) {
    if (mcpIpLimiter(req({ ...proxied(`10.9.9.${i % 250}`), authorization: `Bearer forged-${i}` }), res())) ok++
  }
  t.is(ok, 600, 'the pre-auth bucket was splittable by a header the caller sends')
})

test.serial('the pre-auth ceiling sits above the per-user one, so shared egress is not starved', t => {
  // Ordering property, not a magic number: if the IP tier were at or below the
  // per-user tier it would become the effective limit and re-create the
  // shared-egress starvation the per-user tier exists to prevent.
  const perIp = allowedForIp({ 'x-forwarded-for': '203.0.113.5' })
  const perUser = allowedForUser('lincx-ceiling-probe')
  t.true(perIp > perUser, `IP ceiling ${perIp} must exceed the per-user ceiling ${perUser}`)
})

test.serial('the key ceiling rejects new keys instead of wiping established ones', t => {
  // An earlier cut called hits.clear() at the ceiling, which wiped the FLOODER'S
  // OWN exhausted bucket along with everyone else's — reproduced at 20 served
  // against a configured limit of 10, repeating on every refill. The limiter
  // stopped limiting exactly when the ceiling said it was under attack.
  const limiter = createLimiter({
    windowMs: 60_000,
    limit: 10,
    keyOf: ipKey,
    maxKeys: 100,
    message: { error: 'nope' }
  })
  const hit = (key) => limiter(req({}), res(), key)

  // Attacker burns their own budget.
  let attackerServed = 0
  for (let i = 0; i < 20; i++) if (hit('u:attacker')) attackerServed++
  t.is(attackerServed, 10, 'baseline: the limit works')

  // Then floods the key space to the ceiling.
  for (let i = 0; i < 200; i++) hit(`u:flood-${i}`)

  // Their own bucket must NOT have been reset by the ceiling.
  let afterFlood = 0
  for (let i = 0; i < 20; i++) if (hit('u:attacker')) afterFlood++
  t.is(afterFlood, 0, 'the ceiling reset the flooder\'s own window — total served would be 2x the limit')

  // ...and the ceiling must actually EXIST. The assertion above holds just as well
  // when there is no ceiling at all (verified: deleting the whole block passed),
  // so pin the other half — once the map is full, a brand-new key is refused
  // rather than growing it without bound.
  t.true(limiter.size() >= 100, 'baseline: the map reached the ceiling')
  t.false(hit('u:brand-new'), 'a new key was admitted past the ceiling — the map grows unbounded')
})

test.serial('a batch costs budget per message, not per request', t => {
  // One POST /mcp can carry a JSON-RPC array and the transport runs every message
  // in it: measured at 500 tool executions from a request the limiter counted as
  // 1. Budget must be charged per message or 120 req/min is 120 000 calls/min.
  const limiter = createLimiter({ windowMs: 60_000, limit: 100, keyOf: ipKey })

  t.true(limiter(req({}), res(), 'u:batch', 60), 'first batch of 60 fits')
  t.true(limiter(req({}), res(), 'u:batch', 40), 'second batch of 40 exactly fills it')
  t.false(limiter(req({}), res(), 'u:batch', 1), 'a single message past the budget must be refused')
})

test.serial('a refund gives back budget a later gate rejected', t => {
  // /mcp spends the shared per-address budget BEFORE it can know the caller's
  // identity. Without a refund, a user hitting their own per-user cap burned the
  // address budget everyone behind the same egress shares — measured with an
  // innocent second user, zero prior requests, getting a 429.
  const limiter = createLimiter({ windowMs: 60_000, limit: 10, keyOf: ipKey })

  // Spend the whole window. (A rejected call still increments, which is why the
  // exhaustion probe below is counted rather than assumed.)
  let spent = 0
  for (let i = 0; i < 12; i++) if (limiter(req({}), res(), 'ip:shared')) spent++
  t.is(spent, 10, 'baseline: the window holds exactly the limit')

  // Refund everything the 12 attempts charged, and the window should be whole
  // again — that is the property /mcp relies on when tier 2 rejects a request
  // whose tier-1 slot has already been spent.
  for (let i = 0; i < 12; i++) limiter.refund(req({}), 'ip:shared')
  let served = 0
  for (let i = 0; i < 12; i++) if (limiter(req({}), res(), 'ip:shared')) served++
  t.is(served, 10, 'refunded budget was not returned')
})

test.serial('the ceiling prunes expired keys before it starts rejecting', async t => {
  // `sweep` runs at most once per window, so `hits.size` can carry up to two
  // windows of dead entries — enough to trip the ceiling well below the live key
  // count and start refusing real callers. The ceiling therefore prunes first.
  //
  // The fixture has to open that gap deliberately. Filling the map in one burst
  // does NOT: those entries all expire exactly when the next sweep is due, so a
  // single sweep clears them and the earlier version of this test passed with no
  // prune in the code at all. The gap needs entries created PART-WAY through a
  // window — they expire part-way through the next one, after that window's sweep
  // has already gone by, and then sit in `hits.size` until the sweep after that.
  const W = 300
  const limiter = createLimiter({
    windowMs: W,
    limit: 10,
    keyOf: ipKey,
    maxKeys: 50,
    message: { error: 'nope' }
  })
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  // t≈0 — one request arms the sweep: the next one is not due until t≈W.
  limiter(req({}), res(), 'u:anchor')

  // t≈0.5W — fill to the ceiling. These expire at ≈1.5W.
  await wait(W / 2)
  for (let i = 0; i < 49; i++) limiter(req({}), res(), `u:mid-${i}`)
  t.is(limiter.size(), 50, 'baseline: the map is full')

  // t≈1.1W — a sweep is due and runs, but the mid keys are not expired yet, so it
  // deletes nothing and re-arms for t≈2.1W. (Charged to an existing key so the
  // ceiling branch is not what answers.)
  await wait(0.6 * W)
  limiter(req({}), res(), 'u:anchor')
  t.is(limiter.size(), 50, 'the mid-window sweep must not have collected the mid keys yet')

  // t≈1.7W — every mid key is expired, and the next sweep is not due until 2.1W.
  // Without the ceiling prune, a first-time caller is refused against 49 dead
  // buckets.
  await wait(0.6 * W)
  t.true(limiter(req({}), res(), 'u:fresh'),
    'a new caller was rejected against a map of expired keys the sweep has not reached')
})
