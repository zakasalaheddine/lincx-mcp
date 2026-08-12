/* eslint-disable camelcase -- OAuth params and Work API / tool-output fields are snake_case on the wire: protocol, not style. */
import { registerClient } from '../services/oauth/clients.js'
import { json } from '../http/respond.js'
import { readBody } from '../http/request.js'

export async function postRegister (req, res, _opts, cb) {
  let body
  try {
    body = await readBody(req)
  } catch (err) {
    return cb(err) // BodyError carries statusCode 400 (malformed) or 413 (too large)
  }

  const { redirect_uris, client_name } = body ?? {}
  try {
    const client = await registerClient({ redirect_uris, client_name })
    json(res, 201, {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(client.created_at / 1000),
      redirect_uris: client.redirect_uris,
      client_name: client.client_name,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code']
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'registration_failed'
    console.error(`[OAuth] register failed: ${msg}`)
    json(res, 400, { error: 'invalid_redirect_uri', error_description: msg })
  }
}
