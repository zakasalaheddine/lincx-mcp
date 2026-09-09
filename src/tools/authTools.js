/* eslint-disable camelcase -- OAuth params and Work API / tool-output fields are snake_case on the wire: protocol, not style. */
/**
 * tools/authTools.js
 *
 * auth_login  — points the caller at their client OAuth flow.
 * auth_status — reports current session state.
 * auth_logout — destroys the Lincx session behind the caller's OAuth token.
 *   It does NOT revoke the OAuth grant: the access token stays valid for its hour
 *   and the refresh token keeps minting new ones for 30 days, all bound to a
 *   session id that no longer resolves. Every tool therefore fails closed at
 *   validateSession, so no data is reachable — but a user logging out BECAUSE a
 *   token leaked gets no revocation. The deploy-wide kill switch is still
 *   flushing Redis (CLAUDE.md § Deployment).
 */

import { z } from 'zod'
import { destroySession, resolveLincxSession } from '../services/sessionManager.js'
import { getSessionStore } from '../services/sessionStore.js'
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
      inputSchema: z.object({}),
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
      description: `Check current authentication status and session details.

Returns:
  - authenticated (boolean)
  - email (string)
  - networks: accessible networks (active only by default, slimmed to
    { id, name, archived }) plus total / archived_hidden /
    next_offset paging fields

Pass includeArchived: true to include archived networks, limit/offset to page,
and verbose: true for full network objects. Defaults keep the response small on
high-network accounts.

Network context is now passed per tool call via the network_id argument; auth_status
no longer tracks a server-side active network.`,
      inputSchema: z.object({
        includeArchived: z.boolean().default(false).describe('Include archived networks. Default: active only.'),
        limit: z.number().int().min(1).max(500).default(100).describe('Max networks to return'),
        offset: z.number().int().min(0).default(0).describe('Skip this many (page with next_offset)'),
        verbose: z.boolean().default(false).describe('Return full network objects instead of the slim fields')
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async ({ includeArchived, limit, offset, verbose }, extra) => {
      const sessionId = await resolveLincxSession(extra)

      if (!sessionId) {
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

      const store = await getSessionStore()
      const session = await store.get(sessionId)

      if (!session) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              authenticated: false,
              message: "Session expired. Use 'auth_login' to re-authenticate."
            })
          }]
        }
      }

      const netView = selectNetworks(session, { includeArchived, limit, offset, verbose })
      const status = {
        authenticated: true,
        user: session.email,
        email: session.email,
        ...netView
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
      description: `Destroy the current session and clear all auth context.

The user will need to log in again via the browser to continue.`,
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false
      }
    },
    async (_args, extra) => {
      const sessionId = await resolveLincxSession(extra)
      if (!sessionId) {
        return { content: [{ type: 'text', text: 'No active session to log out from.' }] }
      }
      await destroySession(sessionId)
      return { content: [{ type: 'text', text: 'Logged out. Session cleared.' }] }
    }
  )
}
