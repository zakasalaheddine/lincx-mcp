/* eslint-disable camelcase -- OAuth params and tool-output fields are snake_case on the wire. */
/**
 * tools/authTools.js
 *
 * auth_login  — points the caller at their client OAuth flow.
 * auth_status — reports auth state from the wrapped token + Work API networks.
 * auth_logout — client-side instruction; the server has nothing to revoke.
 */

import { z } from 'zod'
import { resolveLincxSession } from '../services/sessionManager.js'
import { fetchUserNetworks } from '../services/networkService.js'
import { getJwtExpiry } from '../services/auth.js'
import { selectNetworks } from './networkTools.js'

export function registerAuthTools (server) {
  // ── auth_login ────────────────────────────────────────────────────────────
  server.registerTool(
    'auth_login',
    {
      title: 'Login',
      description: `Authentication is now handled by your MCP client via OAuth.
If you are not yet signed in, your client should open a browser automatically.
Use 'auth_status' to check the current session.`,
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async () => ({
      content: [{
        type: 'text',
        text: 'Authentication is now handled by your MCP client via OAuth. ' +
              'If you are not yet signed in, your client should open a browser ' +
              "automatically. Use 'auth_status' to check the current session."
      }]
    })
  )

  // ── auth_status ───────────────────────────────────────────────────────────
  server.registerTool(
    'auth_status',
    {
      title: 'Auth Status',
      description: `Check current authentication status.

Returns:
  - authenticated (boolean)
  - email (string)
  - networks: accessible networks (active only by default, slimmed to
    { id, name, archived }) plus total / archived_hidden /
    next_offset paging fields

Pass includeArchived: true to include archived networks, limit/offset to page,
and verbose: true for full network objects. Defaults keep the response small on
high-network accounts.

Network context is passed per tool call via the network_id argument; auth_status
does not track a server-side active network.`,
      inputSchema: z.object({
        includeArchived: z.boolean().default(false).describe('Include archived networks. Default: active only.'),
        limit: z.number().int().min(1).max(500).default(100).describe('Max networks to return'),
        offset: z.number().int().min(0).default(0).describe('Skip this many (page with next_offset)'),
        verbose: z.boolean().default(false).describe('Return full network objects instead of the slim fields')
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ includeArchived, limit, offset, verbose }, extra) => {
      const auth = await resolveLincxSession(extra)

      if (!auth) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              authenticated: false,
              message: "Not logged in. Use 'auth_login' to get the browser login URL."
            })
          }]
        }
      }

      let status
      try {
        const networks = await fetchUserNetworks(auth.auth_token)
        status = {
          authenticated: true,
          user: auth.email,
          email: auth.email,
          ...selectNetworks({ networks }, { includeArchived, limit, offset, verbose })
        }
      } catch (err) {
        // Auth is valid — only the networks fetch failed. Report the failure
        // explicitly rather than as an empty list (which reads as lost access).
        status = {
          authenticated: true,
          user: auth.email,
          email: auth.email,
          networks_error: err instanceof Error ? err.message : String(err)
        }
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(status) }],
        structuredContent: status
      }
    }
  )

  // ── auth_logout ───────────────────────────────────────────────────────────
  server.registerTool(
    'auth_logout',
    {
      title: 'Logout',
      description: `Discard the access token on the client. The server has no session store
to revoke — the token remains valid until the Lincx JWT expires.`,
      inputSchema: z.object({}).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (_args, extra) => {
      const auth = await resolveLincxSession(extra)
      if (!auth) {
        return { content: [{ type: 'text', text: 'No active token to discard.' }] }
      }
      const exp = getJwtExpiry(auth.auth_token)
      const remaining = exp !== null
        ? Math.max(0, Math.ceil((exp * 1000 - Date.now()) / 60_000))
        : null
      const mins = remaining === null ? 'unknown' : String(remaining)
      return {
        content: [{
          type: 'text',
          text: `Token discarded. It will expire in ${mins} minutes and is no longer usable on this client.`
        }]
      }
    }
  )
}
