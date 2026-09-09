import test from 'ava'

import {
  wrapAccessToken,
  unwrapAccessToken,
  wrapAuthCode,
  unwrapAuthCode,
  signClient,
  verifyClient,
  signAuthRequest,
  verifyAuthRequest,
  assertWrappingKey
} from '../services/tokenService.js'

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`

test('assertWrappingKey succeeds when WRAPPING_KEY is configured', t => {
  t.notThrows(() => assertWrappingKey())
})

test('access token round-trips a Lincx JWT', t => {
  const lincx = jwt({ sub: 'u@x.com', exp: Math.floor(Date.now() / 1000) + 3600 })
  const token = wrapAccessToken(lincx)
  t.not(token, lincx)
  t.is(unwrapAccessToken(token), lincx)
})

test('access token rejects tampering', t => {
  const lincx = jwt({ sub: 'u@x.com', exp: Math.floor(Date.now() / 1000) + 3600 })
  const token = wrapAccessToken(lincx)
  const buf = Buffer.from(token, 'base64url')
  buf[buf.length - 5] ^= 0xff
  t.is(unwrapAccessToken(buf.toString('base64url')), null)
})

test('access token rejects random garbage', t => {
  t.is(unwrapAccessToken('not-a-real-token'), null)
  t.is(unwrapAccessToken(''), null)
  t.is(unwrapAccessToken(null), null)
})

test('access token rejects an expired Lincx JWT', t => {
  const expired = jwt({ sub: 'u@x.com', exp: Math.floor(Date.now() / 1000) - 10 })
  const token = wrapAccessToken(expired)
  t.is(unwrapAccessToken(token), null)
})

test('signed client_id round-trips and rejects tampering', t => {
  const payload = {
    redirect_uris: ['https://claude.ai/cb'],
    client_name: 'Claude',
    exp: Math.floor(Date.now() / 1000) + 86400
  }
  const id = signClient(payload)
  t.deepEqual(verifyClient(id).redirect_uris, payload.redirect_uris)

  const buf = Buffer.from(id, 'base64url')
  buf[buf.length - 3] ^= 0xff
  t.is(verifyClient(buf.toString('base64url')), null)
})

test('tokens reject cross-family use', t => {
  // Both envelopes share one key; typ must stop a valid token of one kind
  // verifying as another (a ctx presented as an auth code reached issueTokens
  // with no lincx_jwt and crashed the process).
  const exp = Math.floor(Date.now() / 1000) + 60
  const ctx = signAuthRequest({
    client_id: 'c',
    redirect_uri: 'https://x/cb',
    state: 's',
    code_challenge: 'ch',
    exp
  })
  t.is(unwrapAuthCode(ctx), null)
  t.is(verifyClient(ctx), null)

  const clientToken = signClient({ redirect_uris: ['https://x/cb'], exp })
  t.is(verifyAuthRequest(clientToken), null)
  t.is(unwrapAuthCode(clientToken), null)

  const code = wrapAuthCode({
    client_id: 'c',
    redirect_uri: 'https://x/cb',
    code_challenge: 'ch',
    lincx_jwt: 'jwt',
    exp
  })
  t.is(verifyAuthRequest(code), null)
  t.is(verifyClient(code), null)
  // A code must not verify as a bearer either — same sealed envelope, wrong typ.
  t.is(unwrapAccessToken(code), null)
})

test('auth code does not expose the Lincx JWT', t => {
  // The code transits the browser redirect URL — anyone who sees it can decode
  // base64url. It must be ciphertext, not signed cleartext.
  const secret = 'SECRET-LINCX-JWT-MARKER'
  const code = wrapAuthCode({
    client_id: 'c',
    redirect_uri: 'https://x/cb',
    code_challenge: 'ch',
    lincx_jwt: secret,
    exp: Math.floor(Date.now() / 1000) + 60
  })
  const decoded = Buffer.from(code, 'base64url').toString('utf8')
  t.false(decoded.includes(secret))
  t.false(decoded.includes('lincx_jwt'))
  t.is(unwrapAuthCode(code).lincx_jwt, secret)
})

test('signed auth request / sealed auth code reject expiry', t => {
  const past = Math.floor(Date.now() / 1000) - 5
  t.is(verifyAuthRequest(signAuthRequest({
    client_id: 'c',
    redirect_uri: 'https://x/cb',
    state: 's',
    code_challenge: 'ch',
    exp: past
  })), null)
  t.is(unwrapAuthCode(wrapAuthCode({
    client_id: 'c',
    redirect_uri: 'https://x/cb',
    code_challenge: 'ch',
    lincx_jwt: 'jwt',
    exp: past
  })), null)
})

test('signed tokens verify with the wrapping key derivation', t => {
  // Sanity: two signs of the same payload differ only by nothing (HMAC is
  // deterministic) — payload identity is what matters for client_id reuse.
  const payload = {
    redirect_uris: ['http://localhost/cb'],
    client_name: 'x',
    exp: Math.floor(Date.now() / 1000) + 60
  }
  t.is(signClient(payload), signClient(payload))
  t.truthy(verifyClient(signClient(payload)))
  t.truthy(verifyAuthRequest(signAuthRequest({ ...payload, state: 's', code_challenge: 'c' })))
  t.truthy(unwrapAuthCode(wrapAuthCode({
    client_id: 'c',
    redirect_uri: 'https://x/cb',
    code_challenge: 'ch',
    lincx_jwt: 'jwt',
    exp: Math.floor(Date.now() / 1000) + 60
  })))
})
