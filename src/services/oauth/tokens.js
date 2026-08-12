/* eslint-disable camelcase -- OAuth params and Work API / tool-output fields are snake_case on the wire: protocol, not style. */
import { randomBytes } from 'node:crypto'
import { getKvStore } from '../sessionStore.js'
import {
  OAUTH_ACCESS_TOKEN_TTL_SECONDS,
  OAUTH_REFRESH_TOKEN_TTL_SECONDS
} from '../../constants.js'

const ACCESS_PREFIX = 'oauth:access:'
const REFRESH_PREFIX = 'oauth:refresh:'

export async function issueTokens (input

) {
  const access_token = randomBytes(32).toString('hex')
  const refresh_token = randomBytes(32).toString('hex')

  const accessRecord = {
    token: access_token,
    client_id: input.client_id,
    lincx_session_id: input.lincx_session_id,
    expires_at: Date.now() + OAUTH_ACCESS_TOKEN_TTL_SECONDS * 1000
  }
  const refreshRecord = {
    token: refresh_token,
    client_id: input.client_id,
    lincx_session_id: input.lincx_session_id,
    expires_at: Date.now() + OAUTH_REFRESH_TOKEN_TTL_SECONDS * 1000
  }

  const kv = await getKvStore()
  await kv.set(
    ACCESS_PREFIX + access_token,
    JSON.stringify(accessRecord),
    OAUTH_ACCESS_TOKEN_TTL_SECONDS
  )
  await kv.set(
    REFRESH_PREFIX + refresh_token,
    JSON.stringify(refreshRecord),
    OAUTH_REFRESH_TOKEN_TTL_SECONDS
  )

  return {
    access_token,
    refresh_token,
    token_type: 'Bearer',
    expires_in: OAUTH_ACCESS_TOKEN_TTL_SECONDS
  }
}

export async function lookupAccessToken (token) {
  const kv = await getKvStore()
  const raw = await kv.get(ACCESS_PREFIX + token)
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function refreshTokens (
  refreshTokenValue,
  clientId
) {
  const kv = await getKvStore()
  const raw = await kv.get(REFRESH_PREFIX + refreshTokenValue)
  if (!raw) return null

  let record
  try {
    record = JSON.parse(raw)
  } catch {
    return null
  }

  if (record.client_id !== clientId) return null

  // Rotate: invalidate old refresh, issue new pair tied to same Lincx session
  await kv.delete(REFRESH_PREFIX + refreshTokenValue)
  return issueTokens({
    client_id: record.client_id,
    lincx_session_id: record.lincx_session_id
  })
}

export async function revokeRefreshToken (refreshTokenValue) {
  const kv = await getKvStore()
  await kv.delete(REFRESH_PREFIX + refreshTokenValue)
}
