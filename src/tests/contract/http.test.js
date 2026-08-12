/**
 * tests/contract/http.test.js — THE acceptance harness for the stack migration.
 *
 * Every assertion below was RECORDED against the current Express server and then
 * PINNED. These assertions must not drift: they are what makes each of the three
 * stack conversions (#65 TS->JS, #66 vitest->ava, #67 express->http-hash-router)
 * verifiable instead of hopeful.
 *
 * Only src/tests/contract/buildApp.js changes between phases. This file's
 * assertions change ONLY where a behavioural delta is deliberately accepted, and
 * every such change carries a comment naming the phase that caused it.
 *
 * The cases here are chosen for where http-hash + http-methods differ from
 * Express, not for even coverage:
 *   - method-not-allowed  (Express falls through to 404; http-methods returns 405)
 *   - trailing slashes    (Express Router matches both; http-hash matches exactly)
 *   - res.redirect        (status + Location, which the login flow depends on)
 *   - malformed JSON      (body-parser 400s; a hand-rolled reader would 500)
 *   - body size limit     (express.json()'s 100kb default, silently re-implemented)
 *   - WWW-Authenticate    (the RFC-9728 challenge the OAuth discovery path needs)
 */

import test from 'ava'
import request from 'supertest'
import { buildContractApp } from './buildApp.js'

const app = buildContractApp()

async function registerClient (redirectUri = 'http://localhost:9999/callback') {
  const r = await request(app)
    .post('/oauth/register')
    .send({ redirect_uris: [redirectUri], client_name: 'contract' })
  return r.body.client_id
}

// ── /health ──────────────────────────────────────────────────────────────────

// contract: /health
test('contract: /health > 200 with status ok', async t => {
  const r = await request(app).get('/health')
  t.is(r.status, 200)
  t.is(r.body.status, 'ok')
  t.is(typeof r.body.uptime_s, 'number')
})

// ── OAuth discovery ──────────────────────────────────────────────────────────

// contract: OAuth discovery
test('contract: OAuth discovery > serves authorization-server metadata', async t => {
  const r = await request(app).get('/.well-known/oauth-authorization-server')
  t.is(r.status, 200)
  t.not(r.body.issuer, undefined)
  t.regex(r.body.authorization_endpoint, /\/oauth\/authorize$/)
  t.regex(r.body.token_endpoint, /\/oauth\/token$/)
  t.regex(r.body.registration_endpoint, /\/oauth\/register$/)
  t.deepEqual(r.body.response_types_supported, ['code'])
  t.deepEqual(r.body.grant_types_supported, ['authorization_code', 'refresh_token'])
  t.deepEqual(r.body.code_challenge_methods_supported, ['S256'])
  t.deepEqual(r.body.token_endpoint_auth_methods_supported, ['none'])
  t.deepEqual(r.body.scopes_supported, ['mcp'])
})

test('contract: OAuth discovery > serves protected-resource metadata at the ROOT form', async t => {
  const r = await request(app).get('/.well-known/oauth-protected-resource')
  t.is(r.status, 200)
  t.regex(r.body.resource, /\/mcp$/)
  t.deepEqual(r.body.bearer_methods_supported, ['header'])
})

test('contract: OAuth discovery > serves protected-resource metadata at the RFC-9728 path-suffixed form', async t => {
  // RFC 9728 §3.1 — spec-conformant clients build this form and ignore the root.
  // Both must work or discovery breaks for some clients.
  const r = await request(app).get('/.well-known/oauth-protected-resource/mcp')
  t.is(r.status, 200)
  t.regex(r.body.resource, /\/mcp$/)
})

// ── Dynamic client registration ──────────────────────────────────────────────

// contract: dynamic client registration
test('contract: dynamic client registration > 201 with a client_id for a valid redirect_uri', async t => {
  const r = await request(app)
    .post('/oauth/register')
    .send({ redirect_uris: ['http://localhost:9999/callback'], client_name: 'contract' })
  t.is(r.status, 201)
  t.is(typeof r.body.client_id, 'string')
  t.is(r.body.client_id.length, 32)
  t.is(typeof r.body.client_id_issued_at, 'number')
  t.is(r.body.token_endpoint_auth_method, 'none')
  t.deepEqual(r.body.grant_types, ['authorization_code', 'refresh_token'])
  t.deepEqual(r.body.response_types, ['code'])
})

test('contract: dynamic client registration > accepts an https redirect_uri', async t => {
  const r = await request(app)
    .post('/oauth/register')
    .send({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })
  t.is(r.status, 201)
})

test('contract: dynamic client registration > 400 invalid_redirect_uri when redirect_uris is missing', async t => {
  const r = await request(app).post('/oauth/register').send({ client_name: 'bad' })
  t.is(r.status, 400)
  t.is(r.body.error, 'invalid_redirect_uri')
})

test('contract: dynamic client registration > 400 invalid_redirect_uri for a non-https, non-localhost URI', async t => {
  const r = await request(app)
    .post('/oauth/register')
    .send({ redirect_uris: ['http://evil.example.com/cb'] })
  t.is(r.status, 400)
  t.is(r.body.error, 'invalid_redirect_uri')
})

test('contract: dynamic client registration > 400 on a malformed JSON body', async t => {
  // express.json() rejects this via body-parser. A hand-rolled reader that
  // lets JSON.parse throw would surface a 500 instead — pinned so it can't.
  const r = await request(app)
    .post('/oauth/register')
    .set('Content-Type', 'application/json')
    .send('{not json')
  t.is(r.status, 400)
})

test('contract: dynamic client registration > 413 on a body over the 100kb limit', async t => {
  // express.json()'s default limit. Re-implementing the body reader silently
  // re-implements this trust boundary — pinned so the limit cannot vanish.
  const big = JSON.stringify({
    redirect_uris: ['https://example.com/cb'],
    client_name: 'x'.repeat(200_000)
  })
  const r = await request(app)
    .post('/oauth/register')
    .set('Content-Type', 'application/json')
    .send(big)
  t.is(r.status, 413)
})

// ── Token endpoint ───────────────────────────────────────────────────────────

// contract: token endpoint
test('contract: token endpoint > 400 unsupported_grant_type for an unknown grant', async t => {
  const r = await request(app).post('/oauth/token').send({ grant_type: 'password' })
  t.is(r.status, 400)
  t.is(r.body.error, 'unsupported_grant_type')
})

test('contract: token endpoint > 400 unsupported_grant_type for a missing grant_type', async t => {
  const r = await request(app).post('/oauth/token').send({})
  t.is(r.status, 400)
  t.is(r.body.error, 'unsupported_grant_type')
})

test('contract: token endpoint > 400 invalid_request when authorization_code fields are missing', async t => {
  const r = await request(app).post('/oauth/token').send({ grant_type: 'authorization_code' })
  t.is(r.status, 400)
  t.is(r.body.error, 'invalid_request')
})

test('contract: token endpoint > 400 invalid_client for an unknown client_id', async t => {
  const r = await request(app).post('/oauth/token').send({
    grant_type: 'authorization_code',
    code: 'x',
    redirect_uri: 'http://localhost:9999/callback',
    client_id: 'does-not-exist',
    code_verifier: 'v'
  })
  t.is(r.status, 400)
  t.is(r.body.error, 'invalid_client')
})

test('contract: token endpoint > 400 invalid_grant for an unknown code on a known client', async t => {
  const clientId = await registerClient()
  const r = await request(app).post('/oauth/token').send({
    grant_type: 'authorization_code',
    code: 'not-a-real-code',
    redirect_uri: 'http://localhost:9999/callback',
    client_id: clientId,
    code_verifier: 'v'
  })
  t.is(r.status, 400)
  t.is(r.body.error, 'invalid_grant')
})

test('contract: token endpoint > 400 invalid_request when refresh_token fields are missing', async t => {
  const r = await request(app).post('/oauth/token').send({ grant_type: 'refresh_token' })
  t.is(r.status, 400)
  t.is(r.body.error, 'invalid_request')
})

test('contract: token endpoint > 400 invalid_grant for an unknown refresh_token', async t => {
  const r = await request(app)
    .post('/oauth/token')
    .send({ grant_type: 'refresh_token', refresh_token: 'nope', client_id: 'nope' })
  t.is(r.status, 400)
  t.is(r.body.error, 'invalid_grant')
})

test('contract: token endpoint > accepts an application/x-www-form-urlencoded body', async t => {
  // Several OAuth clients post form-encoded rather than JSON. The replacement
  // body reader must handle both content types.
  const r = await request(app).post('/oauth/token').type('form').send({ grant_type: 'password' })
  t.is(r.status, 400)
  t.is(r.body.error, 'unsupported_grant_type')
})

// ── Authorize + login UI ─────────────────────────────────────────────────────

{ // contract: authorize
  const validQuery = (clientId) =>
    `/oauth/authorize?response_type=code&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent('http://localhost:9999/callback')}` +
    '&state=st&code_challenge=chal&code_challenge_method=S256'

  test('contract: authorize > 400 HTML for an unsupported response_type', async t => {
    const r = await request(app).get('/oauth/authorize?response_type=token')
    t.is(r.status, 400)
    t.regex(r.headers['content-type'], /html/)
  })

  test('contract: authorize > 400 for missing required params', async t => {
    const r = await request(app).get('/oauth/authorize?response_type=code&client_id=a')
    t.is(r.status, 400)
  })

  test('contract: authorize > 400 for a non-S256 code_challenge_method', async t => {
    const r = await request(app).get(
      '/oauth/authorize?response_type=code&client_id=a' +
        `&redirect_uri=${encodeURIComponent('http://localhost:9999/callback')}` +
        '&state=s&code_challenge=c&code_challenge_method=plain'
    )
    t.is(r.status, 400)
  })

  test('contract: authorize > 400 for an unknown client_id', async t => {
    const r = await request(app).get(validQuery('unknown-client'))
    t.is(r.status, 400)
    t.regex(r.text, /Unknown client_id/)
  })

  test('contract: authorize > 400 when redirect_uri does not match the registered URIs', async t => {
    const clientId = await registerClient()
    const r = await request(app).get(
      `/oauth/authorize?response_type=code&client_id=${clientId}` +
        `&redirect_uri=${encodeURIComponent('http://localhost:9999/other')}` +
        '&state=st&code_challenge=chal&code_challenge_method=S256'
    )
    t.is(r.status, 400)
    t.regex(r.text, /does not match/)
  })

  test('contract: authorize > 302-redirects a valid authorize to /login?req=<32 hex>', async t => {
    // The login flow hangs off this exact status + Location. A hand-rolled
    // redirect that returns 200-with-a-body, or omits Location, breaks login
    // with no useful client-side error.
    const clientId = await registerClient()
    const r = await request(app).get(validQuery(clientId))
    t.is(r.status, 302)
    t.regex(r.headers.location, /^\/login\?req=[0-9a-f]{32}$/)
  })
}

// contract: login UI
test('contract: login UI > 400 HTML for /login without a req id', async t => {
  const r = await request(app).get('/login')
  t.is(r.status, 400)
  t.regex(r.headers['content-type'], /html/)
})

test('contract: login UI > 400 HTML for /login with an expired req id', async t => {
  const r = await request(app).get('/login?req=deadbeefdeadbeefdeadbeefdeadbeef')
  t.is(r.status, 400)
  t.regex(r.text, /expired/i)
})

test('contract: login UI > serves the login page for a live req id', async t => {
  const clientId = await registerClient()
  const auth = await request(app).get(
    `/oauth/authorize?response_type=code&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent('http://localhost:9999/callback')}` +
      '&state=st&code_challenge=chal&code_challenge_method=S256'
  )
  const reqId = new URL(auth.headers.location, 'http://x').searchParams.get('req')
  const r = await request(app).get(`/login?req=${reqId}`)
  t.is(r.status, 200)
  t.regex(r.headers['content-type'], /html/)
  t.true(r.text.includes(reqId))
})

test('contract: login UI > serves the success page as HTML', async t => {
  const r = await request(app).get('/login/success')
  t.is(r.status, 200)
  t.regex(r.headers['content-type'], /html/)
})

test('contract: login UI > 400 JSON for POST /api/login without a req id', async t => {
  const r = await request(app).post('/api/login').send({ email: 'a@b.c', password: 'p' })
  t.is(r.status, 400)
  t.is(r.body.success, false)
  t.regex(r.body.error, /request id/i)
})

test('contract: login UI > 400 JSON for POST /api/login without credentials', async t => {
  const r = await request(app).post('/api/login?req=abc').send({})
  t.is(r.status, 400)
  t.regex(r.body.error, /required/i)
})

test('contract: login UI > 400 JSON for POST /api/login with an expired req id', async t => {
  const r = await request(app)
    .post('/api/login?req=deadbeefdeadbeefdeadbeefdeadbeef')
    .send({ email: 'a@b.c', password: 'p' })
  t.is(r.status, 400)
  t.regex(r.body.error, /expired/i)
})

// ── /stats gating ────────────────────────────────────────────────────────────

// contract: /stats gating
test('contract: /stats gating > 404s when STATS_TOKEN is unset, so it is never accidentally public', async t => {
  // The ava config pins STATS_TOKEN="" so this does not depend on the
  // developer's .env. constants.js reads it at module scope.
  const r = await request(app).get('/stats')
  t.is(r.status, 404)
})

// ── Method dispatch ──────────────────────────────────────────────────────────

{ // contract: method dispatch
  // RECORDED against Express: an unlisted method on a known path falls through
  // the Router and lands on the 404 handler.
  //
  // PHASE 3 (#67) WILL CHANGE THESE TO 405. http-hash-router dispatches methods
  // through http-methods, which answers 405 for a path it knows with a method it
  // does not. That is more correct and no MCP client depends on the 404 — but it
  // is a real behavioural delta, so it is pinned here and amended deliberately
  // rather than discovered in production.
  const cases = [
    ['post', '/health'],
    ['put', '/health'],
    ['get', '/oauth/token'],
    ['get', '/oauth/register']
  ]

  for (const [method, path] of cases) {
    test(`contract: method dispatch > ${method.toUpperCase()} ${path} -> 404 (Express falls through)`, async t => {
      const r = await (request(app))[method](path)
      t.is(r.status, 404)
    })
  }
}

// ── Trailing slashes ─────────────────────────────────────────────────────────

{ // contract: trailing slashes
  // RECORDED against Express: a Router mounted with app.use() matches BOTH the
  // bare and the slashed form, so every one of these currently serves.
  //
  // http-hash matches exact pathname segments and will 404 all of them. Phase 3
  // (#67) must therefore register both forms for every route below, or these
  // break silently for any client that appends a slash.
  const cases = [
    ['/health/', 200],
    ['/.well-known/oauth-authorization-server/', 200],
    ['/.well-known/oauth-protected-resource/', 200],
    ['/.well-known/oauth-protected-resource/mcp/', 200],
    ['/login/success/', 200],
    ['/login/', 400],
    ['/oauth/authorize/', 400],
    ['/stats/', 404]
  ]

  for (const [path, status] of cases) {
    test(`contract: trailing slashes > GET ${path} -> ${status}`, async t => {
      const r = await request(app).get(path)
      t.is(r.status, status)
    })
  }

  test('contract: trailing slashes > POST /api/login/ -> 400', async t => {
    const r = await request(app).post('/api/login/').send({})
    t.is(r.status, 400)
  })
}
