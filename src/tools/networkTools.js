/* eslint-disable camelcase -- OAuth params and Work API / tool-output fields are snake_case on the wire: protocol, not style. */
/**
 * tools/networkTools.js
 *
 * network_list    — list all accessible networks
 * network_switch  — change active network (Claude resolves name → id automatically)
 * network_refresh — re-fetch networks from the API (same slim/paged shape as network_list)
 */

import { z } from 'zod'
import { switchNetwork, refreshNetworks, resolveLincxSession } from '../services/sessionManager.js'
import { getSessionStore } from '../services/sessionStore.js'

/**
 * Slim + page + archived-filter a session's networks. Shared by network_list and
 * auth_status so both stay small on high-network accounts (Adnet had ~354, mostly
 * archived "Remove Network" test entries — the full dump blew the 30k guard and
 * returned nothing). Active-only by default; archived stays in the session so
 * includeArchived can still surface it.
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
    active_network_id: session.active_network,
    total: filtered.length,
    archived_hidden: includeArchived ? 0 : all.length - filtered.length,
    returned: window.length,
    next_offset: end < filtered.length ? end : null,
    networks: verbose
      ? window
      : window.map((n) => ({
        id: n.id,
        name: n.name,
        is_active: n.id === session.active_network,
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

Use this before 'network_switch' to find the correct network_id.
Also use it when the user asks which network they are on.

Defaults to ACTIVE networks only and pages at limit=100 — high-network
accounts have hundreds of archived "Remove Network" test entries that would
otherwise overflow the response. Pass includeArchived: true to see them, and
limit/offset (next_offset in the reply) to page.

Returns:
  {
    active_network_id: string | null,
    total: number,            // networks matching the filter
    archived_hidden: number,  // archived entries omitted (0 when includeArchived)
    returned: number,
    next_offset: number | null,
    networks: Array<{ id, name, is_active, archived }>
  }`,
      inputSchema: z.object({
        includeArchived: z.boolean().default(false).describe("Include archived networks (e.g. 'NN - Remove Network' test entries). Default: active only."),
        limit: z.number().int().min(1).max(500).default(100).describe('Max networks to return'),
        offset: z.number().int().min(0).default(0).describe('Skip this many (use next_offset from a previous call to page)'),
        verbose: z.boolean().default(false).describe('Return full network objects instead of slim { id, name, is_active, archived }')
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ includeArchived, limit, offset, verbose }, extra) => {
      const sessionId = await resolveLincxSession(extra)
      if (!sessionId) {
        return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }
      }

      const store = await getSessionStore()
      const session = await store.get(sessionId)
      if (!session) {
        return { content: [{ type: 'text', text: "Error: Session not found. Use 'auth_login' to re-authenticate." }] }
      }

      const result = selectNetworks(session, { includeArchived, limit, offset, verbose })
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result
      }
    }
  )

  // ── network_switch ────────────────────────────────────────────────────────
  server.registerTool(
    'network_switch',
    {
      title: 'Switch Network',
      description: `Switch the active network for all subsequent API calls.

ALWAYS call 'network_list' first to get the correct network_id.

The session stays on the new network until switched again.

Args:
  - network_id (string): ID from 'network_list'

Returns: { success, active_network, previous_network_id, message }`,
      inputSchema: z.object({
        network_id: z.string().min(1).describe("Network ID from 'network_list'")
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    async ({ network_id }, extra) => {
      const sessionId = await resolveLincxSession(extra)
      if (!sessionId) {
        return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }
      }

      const result = await switchNetwork(sessionId, network_id)
      if (!result.success) {
        return { content: [{ type: 'text', text: `Error: ${result.error}` }] }
      }

      const store = await getSessionStore()
      const session = await store.get(sessionId)
      const network = session?.networks.find((n) => n.id === network_id)

      const response = {
        success: true,
        active_network: { id: network_id, name: network?.name ?? network_id },
        previous_network_id: result.previousNetwork ?? null,
        message: `Switched to '${network?.name ?? network_id}'. All tool calls now use this network.`
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(response) }],
        structuredContent: response
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
or the list came back empty at login (the fetch is allowed to fail there).

Takes the same filtering/paging args as 'network_list' and returns the same shape —
the raw list is hundreds of full objects on large accounts and would overflow the
response guard.

Preserves the active network if it still exists; if it does not, the session is
moved to the first network and 'active_network_changed' is true.

Returns: network_list's shape plus { success, previous_network_id, active_network_changed }`,
      inputSchema: z.object({
        includeArchived: z.boolean().default(false).describe("Include archived networks (e.g. 'NN - Remove Network' test entries). Default: active only."),
        limit: z.number().int().min(1).max(500).default(100).describe('Max networks to return'),
        offset: z.number().int().min(0).default(0).describe('Skip this many (use next_offset from a previous call to page)'),
        verbose: z.boolean().default(false).describe('Return full network objects instead of slim { id, name, is_active, archived }')
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ includeArchived, limit, offset, verbose }, extra) => {
      const sessionId = await resolveLincxSession(extra)
      if (!sessionId) {
        return { content: [{ type: 'text', text: "Error: Not authenticated. Use 'auth_login' first." }] }
      }

      const refreshed = await refreshNetworks(sessionId)
      if (!refreshed) {
        return { content: [{ type: 'text', text: 'Error: Could not refresh networks. Session may be invalid.' }] }
      }

      const { session, previous_network_id, active_network_changed } = refreshed
      const result = {
        success: true,
        previous_network_id,
        active_network_changed,
        ...selectNetworks(session, { includeArchived, limit, offset, verbose }),
        // fetchUserNetworks returns [] on failure as well as on a genuinely empty
        // account — don't let `success: true` read as "you have no networks".
        ...(session.networks.length === 0
          ? { note: 'The API returned no networks. This can mean the fetch failed — check server logs and retry before concluding the account has none.' }
          : {})
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result
      }
    }
  )
}
