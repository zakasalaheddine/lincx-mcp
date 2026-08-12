/* eslint-disable camelcase -- OAuth params and Work API / tool-output fields are snake_case on the wire: protocol, not style. */
import { describe, it, expect, vi } from 'vitest'
import request from 'supertest'
import { createHash, randomBytes } from 'node:crypto'
import express from 'express'

import { wellKnownRouter } from '../../routes/wellKnown.js'
import { oauthRegisterRouter } from '../../routes/oauthRegister.js'
import { oauthTokenRouter } from '../../routes/oauthToken.js'
import { loginRouter } from '../../routes/login.js'
import { resolveLincxSessionFromBearer } from '../../services/sessionManager.js'

vi.mock('../../services/auth.js', () => ({
  loginWithCredentials: vi.fn(async (email) => ({ authToken: `jwt-for-${email}` })),
  revokeToken: vi.fn(async () => {})
}))
vi.mock('../../services/networkService.js', () => ({
  fetchUserNetworks: vi.fn(async () => [{
    id: 'svce6t',
    name: 'Test Net',
    owner: 'u',
    members: [],
    observers: [],
    dateCreated: '',
    dateUpdated: '',
    userUpdated: '',
    customDimensions: []
  }])
}))

function challenge (verifier) {
  return createHash('sha256').update(verifier).digest('base64url')
}

describe('OAuth end-to-end', () => {
  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))
  app.use('/.well-known', wellKnownRouter)
  app.use('/oauth', oauthRegisterRouter)
  app.use('/oauth', oauthTokenRouter)
  app.use(loginRouter)

  it('client → register → authorize → login → token → bearer resolves to Lincx session', async () => {
    // 1. Register
    const reg = await request(app).post('/oauth/register').send({
      redirect_uris: ['https://localhost:1/cb'],
      client_name: 'test'
    })
    expect(reg.status).toBe(201)
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
    expect(auth.status).toBe(302)
    const loc = auth.headers.location
    const reqId = new URL(loc, 'http://x').searchParams.get('req')
    expect(reqId).toBeTruthy()

    // 3. POST /api/login → JSON { redirect: "https://localhost:1/cb?code=...&state=abc" }
    const login = await request(app)
      .post('/api/login')
      .query({ req: reqId })
      .send({ email: 'u@x.com', password: 'pw' })
    expect(login.status).toBe(200)
    expect(login.body.success).toBe(true)
    const redirect = new URL(login.body.redirect)
    const code = redirect.searchParams.get('code')
    expect(redirect.searchParams.get('state')).toBe('abc')

    // 4. Exchange code → access + refresh tokens
    const tok = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://localhost:1/cb',
      client_id,
      code_verifier: verifier
    })
    expect(tok.status).toBe(200)
    const access = tok.body.access_token

    // 5. Bearer resolves to a Lincx session id
    const lincxSid = await resolveLincxSessionFromBearer(`Bearer ${access}`)
    expect(lincxSid).toMatch(/^[0-9a-f-]{36}$/)

    // 6. Refresh
    const refr = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'refresh_token',
      refresh_token: tok.body.refresh_token,
      client_id
    })
    expect(refr.status).toBe(200)
    expect(refr.body.access_token).not.toBe(access)
  })
})
