/* eslint-disable camelcase -- OAuth params are snake_case on the wire. */
import { loginWithCredentials } from '../services/auth.js'
import {
  issueAuthRequest,
  peekAuthRequest,
  issueAuthCode
} from '../services/oauth/codes.js'
import { getClient } from '../services/oauth/clients.js'
import { loginLimiter, oauthAuthorizeLimiter } from '../middleware/rateLimit.js'
import { buildLoginPage, buildSuccessPage, buildErrorPage } from '../views/login.js'
import { json, html, redirect } from '../http/respond.js'
import { query, readBody } from '../http/request.js'

// ── GET /oauth/authorize ─────────────────────────────────────────────────────
export async function getAuthorize (req, res) {
  if (!oauthAuthorizeLimiter(req, res)) return

  const q = query(req)
  const response_type = q.get('response_type')
  const client_id = q.get('client_id')
  const redirect_uri = q.get('redirect_uri')
  const state = q.get('state')
  const code_challenge = q.get('code_challenge')
  const code_challenge_method = q.get('code_challenge_method')
  const scope = q.get('scope')

  if (response_type !== 'code') {
    return html(res, 400, buildErrorPage('Unsupported response_type.'))
  }
  if (!client_id || !redirect_uri || !state || !code_challenge) {
    return html(res, 400, buildErrorPage('Missing required OAuth parameters.'))
  }
  if (code_challenge_method !== 'S256') {
    return html(res, 400, buildErrorPage('Only S256 code_challenge_method is supported.'))
  }

  const client = await getClient(client_id)
  if (!client) return html(res, 400, buildErrorPage('Unknown client_id.'))
  if (!client.redirect_uris.includes(redirect_uri)) {
    return html(res, 400, buildErrorPage('redirect_uri does not match registered URIs.'))
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(code_challenge)) {
    return html(res, 400, buildErrorPage('Invalid code_challenge.'))
  }

  const ctx = issueAuthRequest({
    client_id,
    redirect_uri,
    state,
    code_challenge,
    scope: scope ?? 'mcp'
  })

  redirect(res, `/login?ctx=${encodeURIComponent(ctx)}`)
}

// ── GET /login ───────────────────────────────────────────────────────────────
export async function getLogin (req, res) {
  const ctx = query(req).get('ctx') ?? ''
  if (!ctx) return html(res, 400, buildErrorPage('Missing auth request context.'))

  const pending = peekAuthRequest(ctx)
  if (!pending) return html(res, 400, buildErrorPage('This login link has expired.'))

  html(res, 200, buildLoginPage(ctx))
}

// ── POST /api/login ──────────────────────────────────────────────────────────
export async function postApiLogin (req, res, _opts, cb) {
  if (!loginLimiter(req, res)) return

  let body
  try {
    body = await readBody(req)
  } catch (err) {
    return cb(err)
  }

  const ctx = query(req).get('ctx') ?? ''
  const { email, password } = body ?? {}

  if (!ctx) return json(res, 400, { success: false, error: 'Missing request context.' })
  if (!email || !password) {
    return json(res, 400, { success: false, error: 'Email and password required.' })
  }

  const pending = peekAuthRequest(ctx)
  if (!pending) {
    return json(res, 400, {
      success: false,
      error: 'Login link expired. Restart from your MCP client.'
    })
  }

  try {
    const { authToken } = await loginWithCredentials(email, password)

    const code = issueAuthCode({
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      lincx_jwt: authToken
    })

    const url = new URL(pending.redirect_uri)
    url.searchParams.set('code', code)
    url.searchParams.set('state', pending.state)
    console.error(`[OAuth] auth_code issued for ${email}`)
    json(res, 200, { success: true, redirect: url.toString() })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Login failed'
    console.error(`[OAuth] login failed for ${email}: ${msg}`)
    json(res, 401, { success: false, error: msg })
  }
}

// ── GET /login/success ───────────────────────────────────────────────────────
export function getLoginSuccess (_req, res) {
  html(res, 200, buildSuccessPage())
}
