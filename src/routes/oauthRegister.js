/* eslint-disable camelcase -- OAuth params and Work API / tool-output fields are snake_case on the wire: protocol, not style. */
import { Router } from 'express'
import { registerClient } from '../services/oauth/clients.js'

export const oauthRegisterRouter = Router()

oauthRegisterRouter.post('/register', async (req, res) => {
  const { redirect_uris, client_name } = req.body ?? {}
  try {
    const client = await registerClient({ redirect_uris, client_name })
    res.status(201).json({
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
    res.status(400).json({ error: 'invalid_redirect_uri', error_description: msg })
  }
})
