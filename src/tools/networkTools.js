/* eslint-disable camelcase -- OAuth params and tool-output fields are snake_case on the wire. */
/**
 * tools/networkTools.js
 *
 * network_list    — list all accessible networks
 * network_refresh — re-fetch networks from the API (same slim/paged shape)
 *
 * Network selection is per-tool-call via `network_id`. There is no session
 * active_network fallback.
 */

import { z } from 'zod'
import { refreshNetworks, resolveLincxSession } from '../services/sessionManager.js'
import { fetchUserNetworks } from '../services/networkService.js'

/**
 * Slim + page + archived-filter a network list. Shared by network_list and
 * auth_status so both stay small on high-network accounts.
 */
export function selectNetworks (
  session,
  opts = {}
) {
  const { includeArchived = false, limit = 100, offset = 0, verbose = false } = opts
  const all = session.networks
  const filtered = includeArchived ? all : all.filter((n) => !n.archived)
  const window = filtered.slice(offset, offset + limit)
  const end = offset + window.length
  return {
    total: filtered.length,
    archived_hidden: includeArchived ? 0 : all.length - filtered.length,
    returned: window.length,
    next_offset: end < filtered.length ? end : null,
    networks: verbose
      ? window
      : window.map((n) => ({
        id: n.id,
        name: n.name,
        archived: n.archived === true
      }))
  }
}

export function registerNetworkTools (server) {
  // ── network_list ──────────────────────────────────────────────────────────
  server.registerTool(
    'network_list',
    {
      title: 'List Networks',
      description: `List the networks the current user has access to.

Use this before any business tool to find the correct network_id.

Defaults to ACTIVE networks only and pages at limit=100 — high-network
accounts have hundreds of archived "Remove Network" test entries that would
otherwise overflow the response. Pass includeArchived: true to see them, and
limit/offset (next_offset in the reply) to page.

Returns:
  {
    total: number,            // networks matching the filter
    archived_hidden: number,  // archived entries omitted (0 when includeArchived)
    returned: number,
    next_offset: number | null,
    networks: Array<{ id, name, archived }>
  }`,
      inputSchema: z.object({
        includeArchived: z.boolean().default(false).describe("Include archived networks (e.g. 'NN - Remove Network' test entries). Default: active only."),
        limit: z.number().int().min(1).max(500).default(100).describe('Max networks to return'),
        offset: z.number().int().min(0).default(0).describe('Skip this many (use next_offset from a previous call to page)'),
        verbose: z.boolean().default(false).describe('Return full network objects instead of slim { id, name, archived }')
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ includeArchived, limit, offset, verbose }, extra) => {
      const auth = await resolveLincxSession(extra)
      if (!auth) {
        return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }
      }

      let networks
      try {
        networks = await fetchUserNetworks(auth.auth_token)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Error: could not fetch networks — ${msg}` }] }
      }
      const result = selectNetworks({ networks }, { includeArchived, limit, offset, verbose })
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result
      }
    }
  )

  // ── network_refresh ───────────────────────────────────────────────────────
  server.registerTool(
    'network_refresh',
    {
      title: 'Refresh Networks',
      description: `Re-fetch the user's network list from the API and return it.

Use when a network seems to be missing, the user was recently added to a new one,
or the list came back empty at login.

Takes the same filtering/paging args as 'network_list' and returns the same shape —
the raw list is hundreds of full objects on large accounts and would overflow the
response guard.

Returns: network_list's shape plus { success }`,
      inputSchema: z.object({
        includeArchived: z.boolean().default(false).describe("Include archived networks (e.g. 'NN - Remove Network' test entries). Default: active only."),
        limit: z.number().int().min(1).max(500).default(100).describe('Max networks to return'),
        offset: z.number().int().min(0).default(0).describe('Skip this many (use next_offset from a previous call to page)'),
        verbose: z.boolean().default(false).describe('Return full network objects instead of slim { id, name, archived }')
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ includeArchived, limit, offset, verbose }, extra) => {
      const auth = await resolveLincxSession(extra)
      if (!auth) {
        return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }
      }

      let refreshed
      try {
        refreshed = await refreshNetworks(auth)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return { content: [{ type: 'text', text: `Error: Could not refresh networks — ${msg}` }] }
      }
      if (!refreshed) {
        return { content: [{ type: 'text', text: 'Error: Could not refresh networks.' }] }
      }

      const { session } = refreshed
      const result = {
        success: true,
        ...selectNetworks(session, { includeArchived, limit, offset, verbose })
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result
      }
    }
  )
}
