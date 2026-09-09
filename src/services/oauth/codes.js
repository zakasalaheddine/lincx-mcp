/* eslint-disable camelcase -- OAuth params are snake_case on the wire. */
import {
  signAuthRequest,
  verifyAuthRequest,
  wrapAuthCode,
  unwrapAuthCode
} from '../tokenService.js'
import { OAUTH_AUTH_CODE_TTL_SECONDS } from '../../constants.js'

const PENDING_TTL_SECONDS = 600

/** Sign the pending authorize context into a URL-safe `ctx` token. */
export function issueAuthRequest (req) {
  return signAuthRequest({
    client_id: req.client_id,
    redirect_uri: req.redirect_uri,
    state: req.state,
    code_challenge: req.code_challenge,
    scope: req.scope ?? 'mcp',
    exp: Math.floor(Date.now() / 1000) + PENDING_TTL_SECONDS
  })
}

/**
 * Verify `/login?ctx=` — returns null if missing, tampered, or expired.
 * Used by both GET /login (render the form) and POST /api/login (submit
 * credentials): nothing is consumed, so a ctx stays usable for its 10-min TTL.
 * Deliberate — a password typo used to burn the whole login link; the
 * loginLimiter gates retries instead.
 */
export function peekAuthRequest (ctx) {
  return verifyAuthRequest(ctx)
}

export function issueAuthCode (input) {
  return wrapAuthCode({
    client_id: input.client_id,
    redirect_uri: input.redirect_uri,
    code_challenge: input.code_challenge,
    lincx_jwt: input.lincx_jwt,
    exp: Math.floor(Date.now() / 1000) + OAUTH_AUTH_CODE_TTL_SECONDS
  })
}

/**
 * Open a sealed auth code. Returns null if missing/tampered/wrong-family/expired.
 *
 * NOT single-use — there is deliberately no replay store: the code stays
 * redeemable until its 60s `exp`. That is safe here because the envelope is
 * sealed (a leaked code exposes nothing — the JWT is ciphertext) and PKCE binds
 * redemption to the verifier only the legitimate client holds, so replay needs
 * a code+verifier pair inside the window. What we give up vs. a store is the
 * second-redemption alarm and revoke-on-reuse (RFC 9700) — both require shared
 * state this deployment does not run. Revisit if the instance count ever grows.
 */
export function redeemAuthCode (code) {
  return unwrapAuthCode(code)
}
