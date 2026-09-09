/**
 * services/sessionManager.js
 *
 * Auth context from wrapped access tokens — no session store.
 *
 * Security contract:
 *   - The OAuth bearer unwraps to the Lincx JWT
 *   - auth_token is injected server-side on every Work API request
 *   - Claude (the AI client) never sees the Lincx JWT
 */

/* eslint-disable camelcase -- auth_token / user_id match the Session wire shape. */

import { createHash } from 'node:crypto'
import { isJwtExpired, getJwtUserId, getJwtEmail, getJwtExpiry } from './auth.js'
import { lookupAccessToken } from './oauth/tokens.js'
import { fetchUserNetworks } from './networkService.js'

/**
 * Validate an auth object from resolveLincxSession.
 * Checks the Lincx JWT exp; network membership is enforced by the Work API.
 */
export async function validateSession (auth) {
  if (!auth?.auth_token) {
    return {
      valid: false,
      error: "Not authenticated. Use 'auth_login' to open the browser login page."
    }
  }

  if (isJwtExpired(auth.auth_token)) {
    return {
      valid: false,
      error: "Your Lincx session has expired. Use 'auth_login' to sign in again."
    }
  }

  return { valid: true, session: auth }
}

/**
 * Fetch networks for the auth token (no server-side cache).
 * Returns false when auth is missing; throws when the fetch itself fails —
 * an empty list means a genuinely empty account.
 */
export async function refreshNetworks (auth) {
  if (!auth?.auth_token) return false
  const networks = await fetchUserNetworks(auth.auth_token)
  return { session: { ...auth, networks } }
}

/**
 * Resolve auth for a tool/resource call from the OAuth bearer on the request.
 * Memoised on `extra` so a second resolve in the same request is free.
 */
export async function resolveLincxSession (extra) {
  if (!extra) return null
  if (extra._lincxAuth !== undefined) return extra._lincxAuth
  const auth = await resolveLincxSessionFromBearer(
    extra.requestInfo?.headers?.authorization
  )
  extra._lincxAuth = auth
  return auth
}

/**
 * Rate-limit bucket key for an auth object — the Lincx JWT user id.
 * A token whose claims are unreadable falls back to a hash of itself: a shared
 * 'unknown' bucket would let such tokens starve each other.
 */
export function resolveUserBucket (auth) {
  if (!auth?.auth_token) return 'unknown'
  return getJwtUserId(auth.auth_token) ??
    'tok:' + createHash('sha256').update(auth.auth_token).digest('hex').slice(0, 16)
}

/**
 * Resolve `Authorization: Bearer <token>` to an auth object
 * `{ auth_token, user_id, email }`, or null if missing/invalid/expired.
 */
export async function resolveLincxSessionFromBearer (authorizationHeader) {
  if (!authorizationHeader) return null
  const m = authorizationHeader.match(/^Bearer\s+(\S+)$/i)
  if (!m) return null
  const access = lookupAccessToken(m[1])
  if (!access) return null
  const auth_token = access.lincx_jwt
  return {
    auth_token,
    user_id: getJwtUserId(auth_token) ?? null,
    email: getJwtEmail(auth_token) ?? null,
    expires_at: getJwtExpiry(auth_token)
  }
}
