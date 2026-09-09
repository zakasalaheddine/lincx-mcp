import test from 'ava'
import { getJwtExpiry, isJwtExpired, getJwtUserId } from '../services/auth.js'
import { validateSession } from '../services/sessionManager.js'

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`

const NOW = 1_700_000_000_000

test.serial('getJwtExpiry / isJwtExpired > reads a numeric exp claim', t => {
  t.is(getJwtExpiry(jwt({ exp: 1234 })), 1234)
})

test.serial('getJwtExpiry / isJwtExpired > returns null for non-JWTs and missing/invalid exp', t => {
  t.is(getJwtExpiry('not-a-jwt'), null)
  t.is(getJwtExpiry('a.b.c'), null)
  t.is(getJwtExpiry(jwt({ sub: 'x' })), null)
})

test.serial('getJwtExpiry / isJwtExpired > is expired only when exp has passed; fails open when unreadable', t => {
  t.is(isJwtExpired(jwt({ exp: Math.floor(NOW / 1000) - 60 }), NOW), true)
  t.is(isJwtExpired(jwt({ exp: Math.floor(NOW / 1000) + 60 }), NOW), false)
  t.is(isJwtExpired('not-a-jwt', NOW), false)
})

test.serial('getJwtUserId > prefers sub, then user_id, then email; null when missing', t => {
  t.is(getJwtUserId(jwt({ sub: 'a@b.c' })), 'a@b.c')
  t.is(getJwtUserId(jwt({ user_id: 'uid' })), 'uid')
  t.is(getJwtUserId(jwt({ email: 'e@x.com' })), 'e@x.com')
  t.is(getJwtUserId(jwt({ nbf: 1 })), null)
  t.is(getJwtUserId('not-a-jwt'), null)
})

test.serial('validateSession > rejects an expired token with a clear re-login prompt', async t => {
  const expired = jwt({
    sub: 'u@x.com',
    exp: Math.floor(Date.now() / 1000) - 10
  })
  const r = await validateSession({ auth_token: expired, email: 'u@x.com' })
  t.is(r.valid, false)
  t.regex(r.error, /expired/i)
  t.regex(r.error, /auth_login/)
})

test.serial('validateSession > passes a still-valid (or expiry-less) token', async t => {
  const fresh = jwt({
    sub: 'u@x.com',
    exp: Math.floor(Date.now() / 1000) + 3600
  })
  const r = await validateSession({ auth_token: fresh, email: 'u@x.com' })
  t.is(r.valid, true)
  t.is(r.session?.auth_token, fresh)
})

test.serial('validateSession > rejects missing auth', async t => {
  const r = await validateSession(null)
  t.is(r.valid, false)
  t.regex(r.error, /Not authenticated/)
})
