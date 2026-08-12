import { randomBytes } from 'node:crypto'
import { getKvStore } from '../sessionStore.js'
import { OAUTH_AUTH_CODE_TTL_SECONDS } from '../../constants.js'

const PREFIX = 'oauth:code:'

export async function issueAuthCode (input

) {
  const code = randomBytes(32).toString('hex')
  const record = {
    code,
    ...input,
    expires_at: Date.now() + OAUTH_AUTH_CODE_TTL_SECONDS * 1000
  }
  const kv = await getKvStore()
  await kv.set(PREFIX + code, JSON.stringify(record), OAUTH_AUTH_CODE_TTL_SECONDS)
  return code
}

/** Single-use: deletes the code on retrieval. Returns null if missing/expired. */
export async function consumeAuthCode (code) {
  const kv = await getKvStore()
  const raw = await kv.get(PREFIX + code)
  if (!raw) return null
  await kv.delete(PREFIX + code)
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

// ── Pending authorization-request store ─────────────────────────────────────
// Used by /oauth/authorize → /login → /api/login to carry OAuth context across
// the user-driven login redirect.

;

const PENDING_PREFIX = 'oauth:pending:'
const PENDING_TTL_SECONDS = 600

export async function storePendingAuthRequest (
  req
) {
  const kv = await getKvStore()
  const record = {
    ...req,
    expires_at: Date.now() + PENDING_TTL_SECONDS * 1000
  }
  await kv.set(PENDING_PREFIX + req.request_id, JSON.stringify(record), PENDING_TTL_SECONDS)
}

export async function consumePendingAuthRequest (
  requestId
) {
  const kv = await getKvStore()
  const raw = await kv.get(PENDING_PREFIX + requestId)
  if (!raw) return null
  await kv.delete(PENDING_PREFIX + requestId)
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function peekPendingAuthRequest (
  requestId
) {
  const kv = await getKvStore()
  const raw = await kv.get(PENDING_PREFIX + requestId)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}
