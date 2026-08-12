/* eslint-disable camelcase -- OAuth params and Work API / tool-output fields are snake_case on the wire: protocol, not style. */
import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import { loginWithCredentials } from '../services/auth.js'
import { createSession } from '../services/sessionManager.js'
import {
  storePendingAuthRequest,
  consumePendingAuthRequest,
  peekPendingAuthRequest,
  issueAuthCode
} from '../services/oauth/codes.js'
import { getClient } from '../services/oauth/clients.js'
import { loginLimiter } from '../middleware/rateLimit.js'
import { buildLoginPage, buildSuccessPage, buildErrorPage } from '../views/login.js'

export const loginRouter = Router()

// ── GET /oauth/authorize ─────────────────────────────────────────────────────
loginRouter.get('/oauth/authorize', async (req, res) => {
  const {
    response_type,
    client_id,
    redirect_uri,
    state,
    code_challenge,
    code_challenge_method,
    scope
  } = req.query

  if (response_type !== 'code') {
    res.status(400).send(buildErrorPage('Unsupported response_type.'))
    return
  }
  if (!client_id || !redirect_uri || !state || !code_challenge) {
    res.status(400).send(buildErrorPage('Missing required OAuth parameters.'))
    return
  }
  if (code_challenge_method !== 'S256') {
    res.status(400).send(buildErrorPage('Only S256 code_challenge_method is supported.'))
    return
  }

  const client = await getClient(client_id)
  if (!client) {
    res.status(400).send(buildErrorPage('Unknown client_id.'))
    return
  }
  if (!client.redirect_uris.includes(redirect_uri)) {
    res.status(400).send(buildErrorPage('redirect_uri does not match registered URIs.'))
    return
  }

  const request_id = randomBytes(16).toString('hex')
  await storePendingAuthRequest({
    request_id,
    client_id,
    redirect_uri,
    state,
    code_challenge,
    scope: scope ?? 'mcp'
  })

  res.redirect(`/login?req=${request_id}`)
})

// ── GET /login ───────────────────────────────────────────────────────────────
loginRouter.get('/login', async (req, res) => {
  const requestId = typeof req.query.req === 'string' ? req.query.req : ''
  if (!requestId) {
    res.status(400).send(buildErrorPage('Missing auth request id.'))
    return
  }
  const pending = await peekPendingAuthRequest(requestId)
  if (!pending) {
    res.status(400).send(buildErrorPage('This login link has expired.'))
    return
  }
  res.setHeader('Content-Type', 'text/html')
  res.send(buildLoginPage(requestId))
})

// ── POST /api/login ──────────────────────────────────────────────────────────
loginRouter.post('/api/login', loginLimiter, async (req, res) => {
  const requestId = typeof req.query.req === 'string' ? req.query.req : ''
  const { email, password } = req.body

  if (!requestId) {
    res.status(400).json({ success: false, error: 'Missing request id.' })
    return
  }
  if (!email || !password) {
    res.status(400).json({ success: false, error: 'Email and password required.' })
    return
  }

  const pending = await consumePendingAuthRequest(requestId)
  if (!pending) {
    res.status(400).json({
      success: false,
      error: 'Login link expired. Restart from your MCP client.'
    })
    return
  }

  try {
    const { authToken } = await loginWithCredentials(email, password)
    const session = await createSession({ user_id: email, email, auth_token: authToken })

    const code = await issueAuthCode({
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      lincx_session_id: session.session_id
    })

    const url = new URL(pending.redirect_uri)
    url.searchParams.set('code', code)
    url.searchParams.set('state', pending.state)
    console.error(`[OAuth] auth_code issued for ${email} → client=${pending.client_id}`)
    res.json({ success: true, redirect: url.toString() })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Login failed'
    console.error(`[OAuth] login failed for ${email}: ${msg}`)
    res.status(401).json({ success: false, error: msg })
  }
})

// ── GET /login/success ───────────────────────────────────────────────────────
loginRouter.get('/login/success', (_req, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.send(buildSuccessPage())
})
