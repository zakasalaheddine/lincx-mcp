import test from 'ava'

// test.serial throughout: these tests share a module-level store, and ava runs a
// file's tests concurrently where vitest's forked pool ran them one at a time.
import {
  issueTokens,
  refreshTokens,
  lookupAccessToken,
  revokeRefreshToken
} from '../../services/oauth/tokens.js'

{ // OAuth tokens
  test.serial('OAuth tokens > issues access + refresh, then refreshes (rotating refresh)', async t => {
    const a = await issueTokens({ client_id: 'c', lincx_session_id: 's' })
    t.regex(a.access_token, /^[a-f0-9]{64}$/)
    t.regex(a.refresh_token, /^[a-f0-9]{64}$/)
    t.is(a.expires_in, 3600)

    const lookup = await lookupAccessToken(a.access_token)
    t.is(lookup?.lincx_session_id, 's')

    const b = await refreshTokens(a.refresh_token, 'c')
    t.not(b, null)
    t.not(b.access_token, a.access_token)
    t.not(b.refresh_token, a.refresh_token)

    t.is(await refreshTokens(a.refresh_token, 'c'), null)
  })

  test.serial('OAuth tokens > rejects refresh from wrong client', async t => {
    const a = await issueTokens({ client_id: 'c1', lincx_session_id: 's' })
    t.is(await refreshTokens(a.refresh_token, 'c2'), null)
  })

  test.serial('OAuth tokens > revokes a refresh token', async t => {
    const a = await issueTokens({ client_id: 'c', lincx_session_id: 's' })
    await revokeRefreshToken(a.refresh_token)
    t.is(await refreshTokens(a.refresh_token, 'c'), null)
  })
}
