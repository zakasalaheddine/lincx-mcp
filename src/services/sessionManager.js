/**
 * services/sessionManager.js
 *
 * Session lifecycle — the only place session state is mutated.
 *
 * Security contract:
 *   - session_id lives in MCP server process memory only
 *   - auth_token is injected server-side on every API request
 *   - Claude (the AI client) never sees either value
 */

import { v4 as uuidv4 } from 'uuid'

import { getSessionStore } from './sessionStore.js'
import { revokeToken, isJwtExpired } from './auth.js'
import { fetchUserNetworks } from './networkService.js'
import { lookupAccessToken } from './oauth/tokens.js'

// ── Create ───────────────────────────────────────────────────────────────────

export async function createSession (params

) {
  const store = await getSessionStore()
  const networks = await fetchUserNetworks(params.auth_token)

  const session = {
    session_id: uuidv4(),
    user_id: params.user_id,
    email: params.email,
    auth_token: params.auth_token,
    networks
  }

  await store.set(session.session_id, session)
  // Truncated: the full id is the Redis key of the record holding the Lincx JWT,
  // and this line puts it next to the email in container logs for the session's
  // whole 7-day life. Hashing it in the event log while logging it raw here would
  // have removed the weaker copy and kept the stronger one.
  console.error(`[Session] Created for ${params.email} — id: ${session.session_id.slice(0, 8)}…`)
  return session
}

// ── Validate (runs on every tool call) ───────────────────────────────────────

export async function validateSession (
  sessionId,
  networkId
) {
  const store = await getSessionStore()
  const session = await store.get(sessionId)

  if (!session) {
    return {
      valid: false,
      error: "Not authenticated. Use 'auth_login' to open the browser login page."
    }
  }

  // Proactively catch a lapsed Lincx JWT so the user gets one clear re-login
  // prompt instead of every tool call failing with a Work API 401.
  if (isJwtExpired(session.auth_token)) {
    return {
      valid: false,
      error: "Your Lincx session has expired. Use 'auth_login' to sign in again."
    }
  }

  if (networkId && !session.networks.some((n) => n.id === networkId)) {
    return { valid: false, error: `Network '${networkId}' is not in your networks. Use 'network_list'.` }
  }

  return { valid: true, session }
}

// ── Refresh network list ──────────────────────────────────────────────────────

/**
 * Re-fetch the network list onto the session.
 *
 * Returns `false` when the session is gone, otherwise the refreshed session.
 * `fetchUserNetworks` swallows its own errors and returns `[]`, so an empty list
 * is "the fetch failed or you really have none", not a success worth hiding.
 */
export async function refreshNetworks (sessionId) {
  const store = await getSessionStore()
  const session = await store.get(sessionId)
  if (!session) return false

  session.networks = await fetchUserNetworks(session.auth_token)
  await store.set(sessionId, session)
  return { session }
}

// ── Destroy (logout) ──────────────────────────────────────────────────────────

export async function destroySession (sessionId) {
  const store = await getSessionStore()
  const session = await store.get(sessionId)
  if (session) {
    await revokeToken(session.auth_token) // no-op for authentic-server
    await store.delete(sessionId)
    console.error(`[Session] Destroyed ${sessionId.slice(0, 8)}…`)
  }
}

// ── Request → Lincx-session resolution ───────────────────────────────────────

/**
 * Resolve the Lincx session for a tool/resource call, from the OAuth bearer on
 * the request itself.
 *
 * The transport is stateless (no `sessionIdGenerator`), so there is no MCP
 * session id and no `mcp:session:<id>` binding any more — the bearer token IS
 * the identity, and it already resolves to a Lincx session via Redis.
 *
 * The result is memoised on `extra` — one plain object per JSON-RPC request
 * (`shared/protocol.js` builds it fresh, never shared or frozen), so a second
 * resolve within the same request costs nothing.
 *
 * It is NOT a saving over the whole request: mcpPost runs its own
 * resolveLincxSessionFromBearer to answer the RFC-9728 401 before any transport
 * exists, and it has no `extra` to seed. So an authenticated tool call costs two
 * Redis GETs on the same token — the gate's and the handler's. ~1ms, and the
 * alternative is a gate that cannot challenge. The memo's job is to stop that
 * becoming three.
 */
export async function resolveLincxSession (extra) {
  if (!extra) return null
  if (extra._lincxSessionId !== undefined) return extra._lincxSessionId
  const id = await resolveLincxSessionFromBearer(extra.requestInfo?.headers?.authorization)
  extra._lincxSessionId = id
  return id
}

/**
 * The ACCOUNT behind a session, for rate-limit bucketing.
 *
 * Not the session id, which is what this used to key on: `createSession` mints a
 * fresh UUID on every login and each lives 7 days, so one account accumulates
 * buckets — N logins is N × the per-user limit, with only the 10/min login
 * limiter as a brake. ~100 logins over ten minutes bought 12 000 req/min for one
 * account.
 *
 * Costs one Redis GET on the request path, which is real: an authenticated tool
 * call already pays two (the 401 gate, then the handler's memoised resolve). If
 * that shows up in latency, the fix is to carry `user_id` on the OAuth access
 * record so it arrives with the token — not to go back to keying on the session.
 *
 * Falls back to the session id when the session is gone; that request is about to
 * fail closed inside every tool anyway.
 */
export async function resolveUserBucket (lincxSessionId) {
  const store = await getSessionStore()
  const session = await store.get(lincxSessionId)
  return session?.user_id ?? lincxSessionId
}

// ── OAuth bearer → Lincx session ─────────────────────────────────────────────

/**
 * Resolve a bearer token from `Authorization: Bearer <token>` to a Lincx session id.
 *
 * Returns null if the token is missing, malformed, or expired. It does NOT check
 * that the Lincx session still exists — an earlier version of this comment
 * claimed it did. A bearer whose session was destroyed by `auth_logout` still
 * passes this gate and then fails at `validateSession` / `store.get` inside every
 * tool, so no data is reachable; the difference is a 401 vs a tool-level
 * "Not authenticated". Nothing revokes the OAuth grant itself — see auth_logout.
 */
export async function resolveLincxSessionFromBearer (
  authorizationHeader
) {
  if (!authorizationHeader) return null
  const m = authorizationHeader.match(/^Bearer\s+(\S+)$/i)
  if (!m) return null
  const access = await lookupAccessToken(m[1])
  if (!access) return null
  return access.lincx_session_id
}
