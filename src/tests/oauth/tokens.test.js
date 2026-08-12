import { describe, it, expect } from 'vitest'
import {
  issueTokens,
  refreshTokens,
  lookupAccessToken,
  revokeRefreshToken
} from '../../services/oauth/tokens.js'

describe('OAuth tokens', () => {
  it('issues access + refresh, then refreshes (rotating refresh)', async () => {
    const a = await issueTokens({ client_id: 'c', lincx_session_id: 's' })
    expect(a.access_token).toMatch(/^[a-f0-9]{64}$/)
    expect(a.refresh_token).toMatch(/^[a-f0-9]{64}$/)
    expect(a.expires_in).toBe(3600)

    const lookup = await lookupAccessToken(a.access_token)
    expect(lookup?.lincx_session_id).toBe('s')

    const b = await refreshTokens(a.refresh_token, 'c')
    expect(b).not.toBeNull()
    expect(b.access_token).not.toBe(a.access_token)
    expect(b.refresh_token).not.toBe(a.refresh_token)

    expect(await refreshTokens(a.refresh_token, 'c')).toBeNull()
  })

  it('rejects refresh from wrong client', async () => {
    const a = await issueTokens({ client_id: 'c1', lincx_session_id: 's' })
    expect(await refreshTokens(a.refresh_token, 'c2')).toBeNull()
  })

  it('revokes a refresh token', async () => {
    const a = await issueTokens({ client_id: 'c', lincx_session_id: 's' })
    await revokeRefreshToken(a.refresh_token)
    expect(await refreshTokens(a.refresh_token, 'c')).toBeNull()
  })
})
