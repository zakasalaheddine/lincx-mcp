import test from 'ava'

// test.serial throughout: these tests share a module-level store, and ava runs a
// file's tests concurrently where vitest's forked pool ran them one at a time.
import { issueAuthCode, consumeAuthCode } from '../../services/oauth/codes.js'

{ // OAuth auth codes
  test.serial('OAuth auth codes > issues, consumes once, then fails on reuse', async t => {
    const code = await issueAuthCode({
      client_id: 'c1',
      redirect_uri: 'https://x/cb',
      code_challenge: 'ch',
      lincx_session_id: 'lsid'
    })
    t.regex(code, /^[a-f0-9]{64}$/)

    const first = await consumeAuthCode(code)
    t.is(first?.lincx_session_id, 'lsid')

    const second = await consumeAuthCode(code)
    t.is(second, null)
  })

  test.serial('OAuth auth codes > returns null for unknown code', async t => {
    t.is(await consumeAuthCode('nope'), null)
  })
}
