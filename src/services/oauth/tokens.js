/* eslint-disable camelcase -- OAuth params are snake_case on the wire. */
import { wrapAccessToken, unwrapAccessToken } from '../tokenService.js'
import { getJwtExpiry } from '../auth.js'

/**
 * Issue a wrapped access token from a Lincx JWT.
 * No refresh tokens — the access token lives until the JWT's `exp`.
 */
export function issueTokens (input) {
  const access_token = wrapAccessToken(input.lincx_jwt)
  const exp = getJwtExpiry(input.lincx_jwt)
  const expires_in = exp !== null
    ? Math.max(0, exp - Math.floor(Date.now() / 1000))
    : 60 * 60 * 24 * 30

  return {
    access_token,
    token_type: 'Bearer',
    expires_in
  }
}

/** Unwrap an access token to the Lincx JWT, or null if invalid/expired. */
export function lookupAccessToken (token) {
  const lincx_jwt = unwrapAccessToken(token)
  if (!lincx_jwt) return null
  return { lincx_jwt }
}
