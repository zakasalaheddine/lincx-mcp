import test from 'ava'
import request from 'supertest'
import { createHash } from 'node:crypto'
import { buildContractApp } from '../contract/buildApp.js'
import { registerClient } from '../../services/oauth/clients.js'
import { issueAuthCode, issueAuthRequest } from '../../services/oauth/codes.js'

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`
const TEST_JWT = jwt({
  sub: 'u@x.com',
  exp: Math.floor(Date.now() / 1000) + 3600
})

function challenge (verifier) {
  return createHash('sha256').update(verifier).digest('base64url')
}

{ // POST /oauth/token
  const app = buildContractApp()

  test.serial('POST /oauth/token > exchanges auth_code (with PKCE) for a wrapped access token', async t => {
    const client = await registerClient({ redirect_uris: ['https://x/cb'] })
    const verifier = 'a'.repeat(64)
    const code = issueAuthCode({
      client_id: client.client_id,
      redirect_uri: 'https://x/cb',
      code_challenge: challenge(verifier),
      lincx_jwt: TEST_JWT
    })

    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://x/cb',
      client_id: client.client_id,
      code_verifier: verifier
    })

    t.is(res.status, 200)
    t.truthy(res.body.access_token)
    t.falsy(res.body.refresh_token)
    t.is(res.body.token_type, 'Bearer')
  })

  test.serial('POST /oauth/token > rejects wrong code_verifier', async t => {
    const client = await registerClient({ redirect_uris: ['https://x/cb'] })
    const code = issueAuthCode({
      client_id: client.client_id,
      redirect_uri: 'https://x/cb',
      code_challenge: challenge('a'.repeat(64)),
      lincx_jwt: TEST_JWT
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

  test.serial('POST /oauth/token > rejects a signed auth-request ctx presented as code', async t => {
    // A ctx token is a valid signed envelope carrying client_id, redirect_uri
    // and code_challenge but no lincx_jwt — before the typ discriminator this
    // passed every check and threw inside issueTokens, crashing the process on
    // an unhandled rejection (unauthenticated remote DoS).
    const client = await registerClient({ redirect_uris: ['https://x/cb'] })
    const verifier = 'a'.repeat(64)
    const ctx = issueAuthRequest({
      client_id: client.client_id,
      redirect_uri: 'https://x/cb',
      state: 's',
      code_challenge: challenge(verifier)
    })

    const res = await request(app).post('/oauth/token').type('form').send({
      grant_type: 'authorization_code',
      code: ctx,
      redirect_uri: 'https://x/cb',
      client_id: client.client_id,
      code_verifier: verifier
    })

    t.is(res.status, 400)
    t.is(res.body.error, 'invalid_grant')
  })

  test.serial('POST /oauth/token > 400 invalid_grant for a multibyte code_challenge', async t => {
    // A code_challenge of 43 multibyte chars passes verifyPkce's string-length
    // guard but not timingSafeEqual's byte-length requirement — it throws, the
    // async handler's rejection is unhandled (http-hash-router never awaits),
    // and the process dies. Authenticated-client DoS: the challenge only
    // reaches verifyPkce inside a code issued after a successful login.
    // .timeout() keeps the failure fast — today the response never comes.
    const client = await registerClient({ redirect_uris: ['https://x/cb'] })
    const code = issueAuthCode({
      client_id: client.client_id,
      redirect_uri: 'https://x/cb',
      code_challenge: 'é'.repeat(43),
      lincx_jwt: TEST_JWT
    })

    const res = await request(app).post('/oauth/token').type('form').timeout(5000).send({
      grant_type: 'authorization_code',
      code,
      redirect_uri: 'https://x/cb',
      client_id: client.client_id,
      code_verifier: 'a'.repeat(64)
    })
    t.is(res.status, 400)
    t.is(res.body.error, 'invalid_grant')
  })
}
