import test from 'ava'
import { issueAuthCode, redeemAuthCode } from '../../services/oauth/codes.js'

test.serial('OAuth auth codes > issues a sealed code that opens', t => {
  const code = issueAuthCode({
    client_id: 'c1',
    redirect_uri: 'https://x/cb',
    code_challenge: 'ch',
    lincx_jwt: 'jwt-value'
  })
  t.truthy(code)

  const first = redeemAuthCode(code)
  t.is(first?.lincx_jwt, 'jwt-value')
  t.is(first?.client_id, 'c1')

  // Deliberate: no replay store — sealed codes stay redeemable until expiry.
  // See the tradeoff comment on redeemAuthCode in services/oauth/codes.js.
  const second = redeemAuthCode(code)
  t.is(second?.lincx_jwt, 'jwt-value')
})

test.serial('OAuth auth codes > returns null for unknown code', t => {
  t.is(redeemAuthCode('nope'), null)
})
