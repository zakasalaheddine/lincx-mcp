/**
 * services/auth.js
 *
 * Handles login against the Lincx authentic-server identity service.
 *
 * Flow:
 *   1. User opens http://localhost:PORT/login in browser
 *   2. Submits email + password via the web form
 *   3. Express POST /api/login calls loginWithCredentials()
 *   4. Returns authToken which is stored in session — never seen by Claude
 */

import { IDENTITY_SERVER } from '../constants.js'

export async function loginWithCredentials (
  email,
  password
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)

  let res
  try {
    res = await fetch(`${IDENTITY_SERVER}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.toLowerCase().trim(), password }),
      signal: controller.signal
    })
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Request timed out')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }

  const body = await res.json()

  // The identity server reports failures in `body.error` (observed:
  // { success:false, error:"User Not Found" }). Read that first so the real
  // reason reaches the user/logs — `message` is a forward-compat fallback.
  // Previously every branch read only `body.message`, masking every failure as
  // "Invalid email or password" and making login impossible to diagnose.
  const serverError = body.error ?? body.message

  if (res.status === 401) {
    throw new Error(serverError ?? 'Invalid email or password')
  }
  if (res.status === 403) {
    throw new Error(serverError ?? 'Account not confirmed. Check your email for a confirmation link.')
  }
  if (!res.ok) {
    throw new Error(serverError ?? `Login failed with status ${res.status}`)
  }

  const authToken = body.data?.authToken
  if (!body.success || authToken === undefined) {
    throw new Error(serverError ?? 'Login failed — no token returned')
  }

  return { authToken, email: email.toLowerCase().trim() }
}

/**
 * authentic-server has no token revocation endpoint.
 * Logout is client-side — the JWT expires naturally (~30d).
 */
export async function revokeToken (_token) {
  // intentional no-op
}

const MAX_JWT_CLAIM_LEN = 320

/**
 * Read a JWT's header and payload WITHOUT verifying the signature. Returns null
 * when the value isn't a 3-part JWT, the header/payload aren't JSON objects, or
 * the header explicitly claims a type other than 'JWT'.
 */
function readJwt (token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') {
      return null
    }
    // Reject a token whose header explicitly claims another type, but allow a
    // missing typ for compatibility with tokens that omit it.
    if (header.typ !== undefined && header.typ !== 'JWT') return null
    return { header, payload }
  } catch {
    return null
  }
}

function readJwtPayload (token) {
  return readJwt(token)?.payload ?? null
}

/**
 * Read the `exp` claim (seconds since epoch) from a JWT WITHOUT verifying the
 * signature. We only need to know whether our stored Lincx token has lapsed so
 * we can prompt a clean re-login instead of letting every Work API call 401 —
 * the Work API still verifies the signature on its side. Returns null when the
 * value isn't a 3-part JWT or carries no numeric `exp`.
 */
export function getJwtExpiry (token) {
  const payload = readJwtPayload(token)
  return typeof payload?.exp === 'number' ? payload.exp : null
}

/**
 * True when the token carries an `exp` claim that has already passed. Tokens with
 * no readable expiry return false (fail open — let the Work API be the authority).
 */
export function isJwtExpired (token, nowMs = Date.now()) {
  const exp = getJwtExpiry(token)
  return exp !== null && exp * 1000 <= nowMs
}

function validJwtClaim (value) {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (v.length === 0 || v.length > MAX_JWT_CLAIM_LEN) return null
  return v
}

function validJwtEmail (value) {
  const v = validJwtClaim(value)
  if (!v) return null
  const lower = v.toLowerCase()
  const at = lower.indexOf('@')
  if (at <= 0 || at === lower.length - 1 || at !== lower.lastIndexOf('@')) return null
  return lower
}

/**
 * User id for rate-limit bucketing. Prefers `sub`, then `user_id`, then `email`.
 * Validates the token is a well-formed JWT and the selected claim is a non-empty,
 * trimmed string. Returns null when none are present or the JWT is unreadable.
 */
export function getJwtUserId (token) {
  const payload = readJwtPayload(token)
  if (!payload) return null
  for (const key of ['sub', 'user_id', 'email']) {
    const id = validJwtClaim(payload[key])
    if (id) return id
  }
  return null
}

/**
 * Best-effort email (or verified user identifier) from the JWT payload for
 * auth_status display. Prefers a value that looks like an email, then falls
 * back to `sub` or `user_id` as a verified non-empty string. Returns null when
 * none are present or the JWT is unreadable.
 */
export function getJwtEmail (token) {
  const payload = readJwtPayload(token)
  if (!payload) return null
  let fallback = null
  for (const key of ['email', 'sub', 'user_id']) {
    const value = payload[key]
    const email = validJwtEmail(value)
    if (email) return email
    if (!fallback) fallback = validJwtClaim(value)
  }
  return fallback
}
