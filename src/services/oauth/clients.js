/* eslint-disable camelcase -- OAuth client_id is snake_case on the wire. */
import { signClient, verifyClient } from '../tokenService.js'
import { OAUTH_CLIENT_TTL_SECONDS } from '../../constants.js'

function isValidRedirectUri (uri) {
  try {
    const u = new URL(uri)
    if (u.protocol === 'https:') return true
    if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true
    return false
  } catch {
    return false
  }
}

export async function registerClient (input) {
  if (!Array.isArray(input.redirect_uris) || input.redirect_uris.length === 0) {
    throw new Error('redirect_uris must be a non-empty array')
  }
  for (const uri of input.redirect_uris) {
    if (!isValidRedirectUri(uri)) {
      throw new Error(`redirect_uri must be https (or http://localhost): ${uri}`)
    }
  }

  const createdAt = Date.now()
  const client_id = signClient({
    redirect_uris: input.redirect_uris,
    client_name: input.client_name,
    exp: Math.floor(createdAt / 1000) + OAUTH_CLIENT_TTL_SECONDS
  })

  return {
    client_id,
    client_name: input.client_name,
    redirect_uris: input.redirect_uris,
    created_at: createdAt
  }
}

export async function getClient (clientId) {
  const payload = verifyClient(clientId)
  if (!payload) return null
  return {
    client_id: clientId,
    client_name: payload.client_name,
    redirect_uris: payload.redirect_uris
  }
}
