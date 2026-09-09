import test from 'ava'
import { issueTokens, lookupAccessToken } from '../../services/oauth/tokens.js'

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const jwt = (payload) => `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(payload)}.sig`

test('OAuth tokens > issues a wrapped access token with no refresh_token', t => {
  const lincx = jwt({
    sub: 'u@x.com',
    exp: Math.floor(Date.now() / 1000) + 7200
  })
  const a = issueTokens({ lincx_jwt: lincx })
  t.truthy(a.access_token)
  t.is(a.token_type, 'Bearer')
  t.true(a.expires_in > 7000)
  t.falsy(a.refresh_token)

  const lookup = lookupAccessToken(a.access_token)
  t.is(lookup?.lincx_jwt, lincx)
})

test('OAuth tokens > lookup rejects garbage', t => {
  t.is(lookupAccessToken('nope'), null)
})
