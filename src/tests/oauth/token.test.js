import { describe, it, expect } from 'vitest'
import request from 'supertest'
import express from 'express'
import { createHash } from 'node:crypto'
import { oauthTokenRouter } from '../../routes/oauthToken.js'
import { registerClient } from '../../services/oauth/clients.js'
import { issueAuthCode } from '../../services/oauth/codes.js'

function challenge (verifier) {
  return createHash('sha256').update(verifier).digest('base64url')
}

describe('POST /oauth/token', () => {
  const app = express()
  app.use(express.urlencoded({ extended: true }))
  app.use(express.json())
  app.use('/oauth', oauthTokenRouter)

  it('exchanges auth_code (with PKCE) for tokens', async () => {
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

    expect(res.status).toBe(200)
    expect(res.body.access_token).toMatch(/^[a-f0-9]{64}$/)
    expect(res.body.refresh_token).toMatch(/^[a-f0-9]{64}$/)
    expect(res.body.token_type).toBe('Bearer')
  })

  it('rejects wrong code_verifier', async () => {
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
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_grant')
  })

  it('rejects code reuse', async () => {
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
    expect(ok.status).toBe(200)

    const reused = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://x/cb',
      client_id: client.client_id,
      code_verifier: verifier
    })
    expect(reused.status).toBe(400)
    expect(reused.body.error).toBe('invalid_grant')
  })
})
