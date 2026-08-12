/* eslint-disable camelcase -- OAuth params and Work API / tool-output fields are snake_case on the wire: protocol, not style. */
import { consumeAuthCode } from '../services/oauth/codes.js'
import { issueTokens, refreshTokens } from '../services/oauth/tokens.js'
import { verifyPkce } from '../services/oauth/pkce.js'
import { getClient } from '../services/oauth/clients.js'
import { json } from '../http/respond.js'
import { readBody } from '../http/request.js'

export async function postToken (req, res, _opts, cb) {
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

    const authCode = await consumeAuthCode(code)
    if (!authCode) return json(res, 400, { error: 'invalid_grant' })
    if (authCode.client_id !== client_id) return json(res, 400, { error: 'invalid_grant' })
    if (authCode.redirect_uri !== redirect_uri) return json(res, 400, { error: 'invalid_grant' })
    if (!verifyPkce(code_verifier, authCode.code_challenge, 'S256')) {
      return json(res, 400, { error: 'invalid_grant' })
    }

    const tokens = await issueTokens({
      client_id,
      lincx_session_id: authCode.lincx_session_id
    })
    return json(res, 200, tokens)
  }

  if (grant_type === 'refresh_token') {
    const { refresh_token, client_id } = body
    if (!refresh_token || !client_id) return json(res, 400, { error: 'invalid_request' })

    const tokens = await refreshTokens(refresh_token, client_id)
    if (!tokens) return json(res, 400, { error: 'invalid_grant' })
    return json(res, 200, tokens)
  }

  json(res, 400, { error: 'unsupported_grant_type' })
}
