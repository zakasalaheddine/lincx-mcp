import test from 'ava'

// test.serial throughout: these tests share a module-level store, and ava runs a
// file's tests concurrently where vitest's forked pool ran them one at a time.
import { getJwtExpiry, isJwtExpired } from '../services/auth.js'
import { validateSession } from '../services/sessionManager.js'
import { getSessionStore } from '../services/sessionStore.js'

// Build an unsigned-but-structurally-valid JWT (header.payload.sig) for testing.
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`

const NOW = 1_700_000_000_000 // fixed clock for determinism

{ // getJwtExpiry / isJwtExpired
  test.serial('getJwtExpiry / isJwtExpired > reads a numeric exp claim', t => {
    t.is(getJwtExpiry(jwt({ exp: 1234 })), 1234)
  })

  test.serial('getJwtExpiry / isJwtExpired > returns null for non-JWTs and missing/invalid exp', t => {
    t.is(getJwtExpiry('not-a-jwt'), null)
    t.is(getJwtExpiry('a.b.c'), null) // payload not JSON
    t.is(getJwtExpiry(jwt({ sub: 'x' })), null) // no exp
  })

  test.serial('getJwtExpiry / isJwtExpired > is expired only when exp has passed; fails open when unreadable', t => {
    t.is(isJwtExpired(jwt({ exp: Math.floor(NOW / 1000) - 60 }), NOW), true)
    t.is(isJwtExpired(jwt({ exp: Math.floor(NOW / 1000) + 60 }), NOW), false)
    t.is(isJwtExpired('not-a-jwt', NOW), false) // fail open — let the API decide
  })
}

{ // validateSession token-expiry gate
  const baseSession = (token) => ({
    session_id: 's-expiry-test',
    user_id: 'u@x.com',
    email: 'u@x.com',
    auth_token: token,
    networks: [{ id: 'net1', name: 'Net One' }],
    active_network: 'net1'
  })

  test.serial('validateSession token-expiry gate > rejects an expired token with a clear re-login prompt before any network check', async t => {
    const store = await getSessionStore()
    const expired = jwt({ exp: Math.floor(Date.now() / 1000) - 10 })
    await store.set('s-expiry-test', baseSession(expired))

    const r = await validateSession('s-expiry-test')
    t.is(r.valid, false)
    t.regex(r.error, /expired/i)
    t.regex(r.error, /auth_login/)
    await store.delete('s-expiry-test')
  })

  test.serial('validateSession token-expiry gate > passes a still-valid (or expiry-less) token through to a valid session', async t => {
    const store = await getSessionStore()
    const fresh = jwt({ exp: Math.floor(Date.now() / 1000) + 3600 })
    await store.set('s-expiry-test', baseSession(fresh))

    const r = await validateSession('s-expiry-test')
    t.is(r.valid, true)
    t.is(r.session?.active_network, 'net1')
    await store.delete('s-expiry-test')
  })
}
