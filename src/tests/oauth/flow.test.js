/* eslint-disable camelcase -- OAuth params are snake_case on the wire. */
import test from 'ava'
import request from 'supertest'
import { createHash, randomBytes } from 'node:crypto'
import { buildContractApp } from '../contract/buildApp.js'
import { resolveLincxSessionFromBearer } from '../../services/sessionManager.js'

const realFetch = globalThis.fetch

function jsonResponse (body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`
const TEST_JWT = jwt({
  sub: 'u@x.com',
  email: 'u@x.com',
  exp: Math.floor(Date.now() / 1000) + 3600
})

globalThis.fetch = async (url) => {
  const u = String(url)
  if (u.endsWith('/auth/login')) {
    return jsonResponse({ success: true, data: { authToken: TEST_JWT } })
  }
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
  const reg = await request(app).post('/oauth/register').send({
    redirect_uris: ['https://localhost:1/cb'],
    client_name: 'test'
  })
  t.is(reg.status, 201)
  const client_id = reg.body.client_id
  t.falsy(reg.body.grant_types?.includes('refresh_token'))

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
  const ctx = new URL(auth.headers.location, 'http://x').searchParams.get('ctx')
  t.truthy(ctx)

  const login = await request(app)
    .post('/api/login')
    .query({ ctx })
    .send({ email: 'u@x.com', password: 'pw' })
  t.is(login.status, 200)
  t.is(login.body.success, true)
  const redirect = new URL(login.body.redirect)
  const code = redirect.searchParams.get('code')
  t.is(redirect.searchParams.get('state'), 'abc')

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

test.serial('OAuth end-to-end > register → authorize → login → wrapped access token', async t => {
  const { tokens } = await fullFlow(t)

  t.truthy(tokens.access_token)
  t.falsy(tokens.refresh_token)
  t.is(tokens.token_type, 'Bearer')

  const auth = await resolveLincxSessionFromBearer(`Bearer ${tokens.access_token}`)
  t.truthy(auth)
  t.is(auth.email, 'u@x.com')
  t.is(auth.auth_token, TEST_JWT)
})

test.serial('OAuth end-to-end > refresh_token grant is rejected', async t => {
  const { client_id, tokens } = await fullFlow(t)

  const refr = await request(app).post('/oauth/token').type('form').send({
    grant_type: 'refresh_token',
    refresh_token: tokens.access_token,
    client_id
  })
  t.is(refr.status, 400)
  t.is(refr.body.error, 'unsupported_grant_type')
})

test.serial('OAuth end-to-end > expired auth code is rejected', async t => {
  const { wrapAuthCode } = await import('../../services/tokenService.js')
  const reg = await request(app).post('/oauth/register').send({
    redirect_uris: ['https://localhost:1/cb'],
    client_name: 'test'
  })
  const client_id = reg.body.client_id
  const verifier = randomBytes(40).toString('base64url')
  const code = wrapAuthCode({
    client_id,
    redirect_uri: 'https://localhost:1/cb',
    code_challenge: challenge(verifier),
    lincx_jwt: TEST_JWT,
    exp: Math.floor(Date.now() / 1000) - 10
  })

  const tok = await request(app).post('/oauth/token').type('form').send({
    grant_type: 'authorization_code',
    code,
    redirect_uri: 'https://localhost:1/cb',
    client_id,
    code_verifier: verifier
  })
  t.is(tok.status, 400)
  t.is(tok.body.error, 'invalid_grant')
})
