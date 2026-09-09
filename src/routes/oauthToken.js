/* eslint-disable camelcase -- OAuth params are snake_case on the wire. */
import { redeemAuthCode } from '../services/oauth/codes.js'
import { issueTokens } from '../services/oauth/tokens.js'
import { verifyPkce } from '../services/oauth/pkce.js'
import { getClient } from '../services/oauth/clients.js'
import { json } from '../http/respond.js'
import { readBody } from '../http/request.js'
import { oauthTokenLimiter } from '../middleware/rateLimit.js'

export async function postToken (req, res, _opts, cb) {
  if (!oauthTokenLimiter(req, res)) return

  let body
  try {
    body = await readBody(req)
  } catch (err) {
    return cb(err)
  }

  const { grant_type } = body ?? {}

  if (grant_type === 'authorization_code') {
    const { code, redirect_uri, client_id, code_verifier } = body

    if (!code || !redirect_uri || !client_id || !code_verifier) {
      return json(res, 400, { error: 'invalid_request' })
    }

    const client = await getClient(client_id)
    if (!client) return json(res, 400, { error: 'invalid_client' })

    const authCode = redeemAuthCode(code)
    if (!authCode) return json(res, 400, { error: 'invalid_grant' })
    if (authCode.client_id !== client_id) return json(res, 400, { error: 'invalid_grant' })
    if (authCode.redirect_uri !== redirect_uri) return json(res, 400, { error: 'invalid_grant' })
    if (!verifyPkce(code_verifier, authCode.code_challenge, 'S256')) {
      return json(res, 400, { error: 'invalid_grant' })
    }

    const tokens = issueTokens({ lincx_jwt: authCode.lincx_jwt })
    return json(res, 200, tokens)
  }

  if (grant_type === 'refresh_token') {
    return json(res, 400, {
      error: 'unsupported_grant_type',
      error_description: 'Refresh tokens are not issued; re-authenticate when the access token expires.'
    })
  }

  json(res, 400, { error: 'unsupported_grant_type' })
}
