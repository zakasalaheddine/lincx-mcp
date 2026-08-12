/* eslint-disable camelcase -- OAuth params and Work API / tool-output fields are snake_case on the wire: protocol, not style. */
import test from 'ava'
import request from 'supertest'
import { createHash, randomBytes } from 'node:crypto'
import { buildContractApp } from '../contract/buildApp.js'
import { resolveLincxSessionFromBearer } from '../../services/sessionManager.js'

// This flow spans FOUR routers and the OAuth client/code/token stores, and it
// asserts on a Lincx session created deep inside that chain. Every participant
// has to see the SAME module instances: esmock (like vi.mock before it) builds a
// fresh module graph per call, so mocking login.js and sessionManager.js
// separately gives the register route one clients store and the authorize route
// another — the registered client_id is then unknown and authorize 400s.
//
// So the two boundaries this test needs to fake are faked where they actually
// are: both services/auth.js and services/networkService.js reach the outside
// world through global fetch, and nothing else here does. One stub, one graph.
// test.serial throughout, since globalThis.fetch is shared state.
const realFetch = globalThis.fetch

function jsonResponse (body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.endsWith('/auth/login')) return jsonResponse({ success: true, data: { authToken: 'jwt-for-u@x.com' } })
  if (u.includes('/api/networks')) {
    return jsonResponse({
      data: [{
        id: 'svce6t',
        name: 'Test Net',
        owner: 'u',
        members: [],
        observers: [],
        dateCreated: '',
        dateUpdated: '',
        userUpdated: '',
        customDimensions: []
      }]
    })
  }
  throw new Error(`unexpected fetch in flow.test.js: ${u}`)
}

test.after.always(() => { globalThis.fetch = realFetch })

function challenge (verifier) {
  return createHash('sha256').update(verifier).digest('base64url')
}

const app = buildContractApp()

/** Register a client, then walk authorize → login → code → tokens. */
async function fullFlow (t) {
  // 1. Register
  const reg = await request(app).post('/oauth/register').send({
    redirect_uris: ['https://localhost:1/cb'],
    client_name: 'test'
  })
  t.is(reg.status, 201)
  const client_id = reg.body.client_id

  // 2. Authorize → 302 to /login?req=<id>
  const verifier = randomBytes(40).toString('base64url')
  const auth = await request(app).get('/oauth/authorize').query({
    response_type: 'code',
    client_id,
    redirect_uri: 'https://localhost:1/cb',
    state: 'abc',
    code_challenge: challenge(verifier),
    code_challenge_method: 'S256'
  })
  t.is(auth.status, 302)
  const reqId = new URL(auth.headers.location, 'http://x').searchParams.get('req')
  t.truthy(reqId)

  // 3. POST /api/login → JSON { redirect: "https://localhost:1/cb?code=...&state=abc" }
  const login = await request(app)
    .post('/api/login')
    .query({ req: reqId })
    .send({ email: 'u@x.com', password: 'pw' })
  t.is(login.status, 200)
  t.is(login.body.success, true)
  const redirect = new URL(login.body.redirect)
  const code = redirect.searchParams.get('code')
  t.is(redirect.searchParams.get('state'), 'abc')

  // 4. Exchange code → access + refresh tokens
  const tok = await request(app).post('/oauth/token').type('form').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'https://localhost:1/cb',
    client_id,
    code_verifier: verifier
  })
  t.is(tok.status, 200)
  return { client_id, tokens: tok.body }
}

test.serial('OAuth end-to-end > client → register → authorize → login → token → bearer resolves to Lincx session', async t => {
  const { client_id, tokens } = await fullFlow(t)

  // 5. Bearer resolves to a Lincx session id
  const lincxSid = await resolveLincxSessionFromBearer(`Bearer ${tokens.access_token}`)
  t.regex(lincxSid, /^[0-9a-f-]{36}$/)

  // 6. Refresh
  const refr = await request(app).post('/oauth/token').type('form').send({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id
  })
  t.is(refr.status, 200)
  t.not(refr.body.access_token, tokens.access_token)
})

test.serial('OAuth end-to-end > refresh rotates and invalidates the old token', async t => {
  const { client_id, tokens } = await fullFlow(t)

  const first = await request(app).post('/oauth/token').type('form').send({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id
  })
  t.is(first.status, 200)
  t.not(first.body.refresh_token, tokens.refresh_token)

  // The ORIGINAL refresh token must now be dead — rotating without invalidating
  // would leave a replayable credential live for its full 30-day TTL.
  const replay = await request(app).post('/oauth/token').type('form').send({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
    client_id
  })
  t.is(replay.status, 400)
  t.is(replay.body.error, 'invalid_grant')
})
