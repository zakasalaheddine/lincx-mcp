/**
 * services/tokenService.js
 *
 * Stateless OAuth / access-token crypto. One WRAPPING_KEY drives:
 *   - AES-256-GCM sealed payloads — anything carrying a secret
 *     (access tokens wrap the Lincx JWT; auth codes carry it to /oauth/token)
 *   - HMAC-SHA256 signed payloads — public metadata only
 *     (client_id registration, the /login?ctx= auth request)
 *
 * Wire formats, both base64url with a version byte first:
 *   sealed: version(1) || iv(12) || ciphertext || tag(16)
 *   signed: version(1) || hmac(32) || utf8(JSON)
 *
 * Every payload carries a `typ` claim binding it to its family — the two
 * formats share the key, so without it a valid token of one kind could be
 * replayed where another is expected (a `ctx` passed every /oauth/token check
 * an auth `code` gets while carrying no lincx_jwt, crashing issueTokens).
 */

import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { WRAPPING_KEY } from '../constants.js'
import { isJwtExpired } from './auth.js'

const VERSION = 0x01
const IV_LEN = 12
const TAG_LEN = 16
const HMAC_LEN = 32
const MIN_KEY_LEN = 32

let cachedKey = null

function wrappingKeyBytes () {
  if (cachedKey) return cachedKey
  if (!WRAPPING_KEY || WRAPPING_KEY.length < MIN_KEY_LEN) {
    throw new Error(
      `WRAPPING_KEY must be set and at least ${MIN_KEY_LEN} characters`
    )
  }
  // Derive a fixed 32-byte AES/HMAC key from the configured secret.
  cachedKey = createHmac('sha256', 'lincx-mcp-wrapping-v1')
    .update(WRAPPING_KEY)
    .digest()
  return cachedKey
}

/** Call from start() so a missing/short key fails the process before bind. */
export function assertWrappingKey () {
  wrappingKeyBytes()
}

function b64urlEncode (buf) {
  return Buffer.from(buf).toString('base64url')
}

function b64urlDecode (str) {
  return Buffer.from(str, 'base64url')
}

// ── Sealed tokens (AES-256-GCM) ──────────────────────────────────────────────
// For payloads containing secrets — the plaintext must not be readable by
// whoever holds the token (auth codes transit the browser redirect; a signed
// envelope would hand the Lincx JWT to anyone who base64url-decodes it).

function sealPayload (typ, payload) {
  const key = wrappingKeyBytes()
  const iv = randomBytes(IV_LEN)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const body = Buffer.from(JSON.stringify({ ...payload, typ }), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()])
  const tag = cipher.getAuthTag()
  return b64urlEncode(Buffer.concat([Buffer.from([VERSION]), iv, ciphertext, tag]))
}

function openPayload (token, typ) {
  if (!token || typeof token !== 'string') return null
  let buf
  try {
    buf = b64urlDecode(token)
  } catch {
    return null
  }
  if (buf.length < 1 + IV_LEN + TAG_LEN + 2) return null
  if (buf[0] !== VERSION) return null

  const iv = buf.subarray(1, 1 + IV_LEN)
  const tag = buf.subarray(buf.length - TAG_LEN)
  const ciphertext = buf.subarray(1 + IV_LEN, buf.length - TAG_LEN)

  let payload
  try {
    const decipher = createDecipheriv('aes-256-gcm', wrappingKeyBytes(), iv)
    decipher.setAuthTag(tag)
    const body = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ])
    payload = JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
  if (payload?.typ !== typ) return null
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
    return null
  }
  return payload
}

/**
 * Encrypt a Lincx JWT into an opaque access token.
 */
export function wrapAccessToken (lincxJwt) {
  return sealPayload('access', { jwt: lincxJwt })
}

/**
 * Decrypt an access token to the Lincx JWT string.
 * Returns null on malformed / tampered / wrong-key / expired-JWT tokens.
 */
export function unwrapAccessToken (token) {
  const payload = openPayload(token, 'access')
  if (typeof payload?.jwt !== 'string' || isJwtExpired(payload.jwt)) return null
  return payload.jwt
}

/** Seal an auth code — it carries the Lincx JWT through the browser redirect. */
export function wrapAuthCode (payload) {
  return sealPayload('code', payload)
}

/** Open an auth code. Returns null if malformed/tampered/wrong-family/expired. */
export function unwrapAuthCode (token) {
  return openPayload(token, 'code')
}

// ── Signed tokens (HMAC-SHA256) ──────────────────────────────────────────────

/**
 * Wire format: version(1) || hmac(32) || utf8(JSON) → base64url
 * For public metadata only — the body is readable by anyone holding the token.
 */
function signPayload (typ, payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, typ }), 'utf8')
  const mac = createHmac('sha256', wrappingKeyBytes()).update(body).digest()
  return b64urlEncode(Buffer.concat([Buffer.from([VERSION]), mac, body]))
}

function verifyPayload (token, typ) {
  if (!token || typeof token !== 'string') return null
  let buf
  try {
    buf = b64urlDecode(token)
  } catch {
    return null
  }
  if (buf.length < 1 + HMAC_LEN + 2) return null
  if (buf[0] !== VERSION) return null

  const mac = buf.subarray(1, 1 + HMAC_LEN)
  const body = buf.subarray(1 + HMAC_LEN)
  const expected = createHmac('sha256', wrappingKeyBytes()).update(body).digest()
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null

  let payload
  try {
    payload = JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
  if (payload?.typ !== typ) return null
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) {
    return null
  }
  return payload
}

export function signClient (payload) {
  return signPayload('client', payload)
}

export function verifyClient (token) {
  return verifyPayload(token, 'client')
}

export function signAuthRequest (payload) {
  return signPayload('authreq', payload)
}

export function verifyAuthRequest (token) {
  return verifyPayload(token, 'authreq')
}
