import test from 'ava'
import request from 'supertest'
import express from 'express'
import { createHash } from 'node:crypto'
import { oauthTokenRouter } from '../../routes/oauthToken.js'
import { registerClient } from '../../services/oauth/clients.js'
import { issueAuthCode } from '../../services/oauth/codes.js'

function challenge (verifier) {
  return createHash('sha256').update(verifier).digest('base64url')
}

{ // POST /oauth/token
  const app = express()
  app.use(express.urlencoded({ extended: true }))
  app.use(express.json())
  app.use('/oauth', oauthTokenRouter)

  test('POST /oauth/token > exchanges auth_code (with PKCE) for tokens', async t => {
    const client = await registerClient({ redirect_uris: ['https://x/cb'] })
    const verifier = 'a'.repeat(64)
    const code = await issueAuthCode({
      client_id: client.client_id,
      redirect_uri: 'https://x/cb',
      code_challenge: challenge(verifier),
      lincx_session_id: 'lsid'
    })

    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://x/cb',
      client_id: client.client_id,
      code_verifier: verifier
    })

    t.is(res.status, 200)
    t.regex(res.body.access_token, /^[a-f0-9]{64}$/)
    t.regex(res.body.refresh_token, /^[a-f0-9]{64}$/)
    t.is(res.body.token_type, 'Bearer')
  })

  test('POST /oauth/token > rejects wrong code_verifier', async t => {
    const client = await registerClient({ redirect_uris: ['https://x/cb'] })
    const code = await issueAuthCode({
      client_id: client.client_id,
      redirect_uri: 'https://x/cb',
      code_challenge: challenge('a'.repeat(64)),
      lincx_session_id: 'lsid'
    })

    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://x/cb',
      client_id: client.client_id,
      code_verifier: 'b'.repeat(64)
    })
    t.is(res.status, 400)
    t.is(res.body.error, 'invalid_grant')
  })

  test('POST /oauth/token > rejects code reuse', async t => {
    const client = await registerClient({ redirect_uris: ['https://x/cb'] })
    const verifier = 'a'.repeat(64)
    const code = await issueAuthCode({
      client_id: client.client_id,
      redirect_uri: 'https://x/cb',
      code_challenge: challenge(verifier),
      lincx_session_id: 'lsid'
    })

    const ok = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://x/cb',
      client_id: client.client_id,
      code_verifier: verifier
    })
    t.is(ok.status, 200)

    const reused = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://x/cb',
      client_id: client.client_id,
      code_verifier: verifier
    })
    t.is(reused.status, 400)
    t.is(reused.body.error, 'invalid_grant')
  })
}
